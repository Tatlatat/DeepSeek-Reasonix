# Cache-Economics Fix — Design

**Goal:** Stop reasonix from running up large DeepSeek prompt-cache-miss costs on long-lived sessions by (1) making the fold economics account for cache-bust risk so big sessions get folded, and (2) keeping the prefix cache warm during idle gaps so a bust rarely happens.

**Architecture:** Two independent components that both attack cache-bust on large sessions, with no behavioral trade-off. Component **A2** edits one pure function (`estimateFoldEconomics` in `src/context-manager.ts`) so the fold cost/benefit math includes the cost of a future cache-bust; this makes large sessions fold and leaves small sessions alone. Component **Keepalive** is a new timer module wired into the acp server that touches the prefix on a 4-minute idle cycle so the DeepSeek cache never expires. A2 makes each bust cheap (small session → small reload); keepalive makes busts rare (cache stays warm). They are defense-in-depth: if one misses, the other limits the damage.

**Tech Stack:** TypeScript (reasonix legacy v1, branch `v1`). No new runtime dependencies.

---

## Background — measured root cause

All numbers below are measured, not assumed (from `~/.reasonix/usage.jsonl` and `runtime/reasonix-cost.jsonl`):

- ~100% of DeepSeek spend is `reasonix code` (TUI) sessions; acp workflow lanes are essentially free (≈16K miss total for 06-22). The cost is NOT effort, NOT acp tool-output accumulation.
- The costliest session `code-level_2` ($3.21, 5.6M miss, 1299 calls): median miss/call = 169 tokens (cache near-perfect for ~96% of calls). 59 calls (4%) carry 5.2M of the 5.6M miss. The 5 worst have prompt 400K-676K tokens at cache 0% — the entire prompt missed.
- Splitting those 59 by time-gap since the previous call: **12 calls with gap >300s carry 4.17M miss (80% of all session miss)**. Smoking-gun rows: `gap=352s prompt=249,008 miss=244,144 cache=2%` vs `gap=123s prompt=884,734 miss=78,078 cache=91%`.
- DeepSeek prompt-cache has a TTL that decays with idle gap: 0-60s → 98.9% hit, 5-10min → 93.1%, 10-30min → 86.6%, >30min → 65.9%. A pause longer than the TTL drops the cached prefix; the next call reloads the whole session at cache-0%.
- **Cache renews on touch:** after every measured bust, the next call (gap 4-100s) returned cache=100%. One touch restores the prefix cache. This is what makes keepalive viable.
- DeepSeek v4 context window = 1,000,000 tokens (`DEEPSEEK_CONTEXT_TOKENS` in `src/telemetry/stats.ts`). reasonix's existing fold triggers at `HISTORY_FOLD_THRESHOLD = 0.75` of ctxMax = ~750K, so sessions grow freely to 750K-1.1M before any fold.
- Pricing (`src/telemetry/stats.ts`): v4-flash `inputCacheHit = $0.0028/Mtok`, `inputCacheMiss = $0.14/Mtok` — **miss is 50× hit**. A bust of an 800K prompt costs `800K × $0.14/M = $0.112`; the same prompt warm costs `$0.0022`.

**Why the existing economics keep sessions large:** `estimateFoldEconomics` computes the "carry" cost (keep the history, don't fold) using the cache-HIT price, assuming the cache stays warm. Because hits are ~free, carry cost ≈ $0, so `worthwhile` is false and the session is never folded. The economics never model the cache-bust event, so on a session with long idle gaps the gate actively keeps the session large — and every bust then reloads up to 1.1M tokens at the 50×-more-expensive miss price.

---

## Component A2 — bust-risk economics

**File:** `src/context-manager.ts` — function `estimateFoldEconomics` (currently around L104).

**Current carry-cost calculation (unchanged parts stay):**
```ts
const carryInputUsd = inputCostUsd(model, usage) * horizonTurns; // assumes cache HIT
```

**Change:** add the expected cost of a cache-bust over the carry horizon. A bust reloads the whole prompt at the miss price instead of the hit price; weight that by a configurable bust probability:
```ts
const bustExtraPerTurnUsd =
  (usage.promptTokens * cacheBustProbability * (pricing.inputCacheMiss - pricing.inputCacheHit)) / 1_000_000;
const carryInputUsd = inputCostUsd(model, usage) * horizonTurns
                    + bustExtraPerTurnUsd * horizonTurns;
```
Everything else in `estimateFoldEconomics` stays: `foldInputUsd` (summary call + post-fold cold + post-fold warm), `savingsUsd = carryInputUsd - foldInputUsd`, and the existing gate `worthwhile = savingsUsd >= HISTORY_FOLD_MIN_ECONOMIC_SAVINGS_USD && savingsFraction >= HISTORY_FOLD_MIN_ECONOMIC_SAVINGS_FRACTION`.

**Why this is self-adjusting and trade-off-free:**
- `(inputCacheMiss − inputCacheHit)` is the real 50× penalty paid on a bust.
- Multiplying by `promptTokens` means a **small** session (e.g. 150K) produces a tiny `bustExtra` → still "not worth folding" (correct — small sessions stay warm and cheap, leave them alone). A **large** session (e.g. 800K-1M) produces a large `bustExtra` → "worth folding" → it folds. No hard threshold; the size dictates the decision.
- The `≥$0.002 AND ≥15%` gate is unchanged, so folds still must show real savings — no folding just to fold.

**Worked example (v4-flash, P_bust=0.15):**
- prompt 800K: `bustExtra = 800K × 0.15 × ($0.14−$0.0028)/1e6 = $0.0165/turn`; ×3 = +$0.049 added to carry. Folding to a 200K tail drops the future bust from `$0.112` to `$0.028` → savings clears the gate → folds. ✅
- prompt 150K: `bustExtra = $0.0031/turn`; the added carry stays under the `≥15%` / `≥$0.002` gate after the summary-call cost is subtracted → does not fold. ✅

**P_bust source:** a config constant `cacheBustProbability` (default `0.15`), NOT derived from timestamps (reasonix does not track inter-turn gaps; adding that is out of scope — see Non-Goals). Interpretation: "on average a 15% chance an idle gap long enough to bust the cache occurs before the next turn." Setting it to `0` makes `estimateFoldEconomics` numerically identical to today's behavior — a clean regression off-switch.

**Error handling:** if `pricingFor(model)` returns undefined, keep the current early-return that yields `worthwhile: true` (unchanged). The bust term is purely additive to carry cost, so A2 can only make folding *more* likely than today, never less — it cannot cause a context-window overflow that the current code would have avoided.

---

## Component Keepalive — keep the prefix cache warm

**File:** new module `src/acp/keepalive.ts`; wired into `src/acp/server.ts`.

**Mechanism:**
```
on turn complete (stopReason received):
  clear any existing timer
  set timer = keepaliveIntervalMs (default 240000 = 4 min, safely under the TTL)

on timer fire (4 min elapsed with NO new turn = session is idle):
  send one cheap ping that touches the current prefix
  if pings-so-far < keepaliveMaxPings: re-arm the timer
  else: stop (do not ping an abandoned session forever)

on real session/prompt arriving:
  clear the timer (the real turn renews the cache itself)

on session close:
  clear the timer (no leak)
```

**The "cheap ping":**
- Call the model with the **exact current prefix** (same system + history) and `max_tokens = 1`. The prefix matches the cached bytes → the whole prompt is a cache HIT (~$0.003 for an 800K prefix) and only 1 output token is produced. This single touch renews the TTL for near-free.
- The ping is **ephemeral**: it does NOT append any message to the session history. The prefix is unchanged → prefix-cache-safe → the ping never grows the session.
- If the prefix has already busted (TTL was missed) the ping pays one reload, but the cache is warm again for subsequent pings.

**Cost control (no trade-off):**
- Pings run only when genuinely idle (no turn for 4 min). A continuously-used session never pings.
- `keepaliveMaxPings` (default 10 ≈ 40 min idle) caps consecutive pings, then stops — an abandoned session does not ping indefinitely.
- Economics: one ping ≈ $0.0022 (800K cache hit); one bust ≈ $0.112. Each ping that prevents a bust wins ~50×. The full 10-ping cap costs ~$0.022 — still cheaper than a single bust.

**Boundary / wiring:** `keepalive.ts` exposes `onTurnEnd()`, `onTurnStart()`, `onClose()`, and takes a `ping()` callback + a clock (injectable for tests). It knows nothing about economics or the main loop. `src/acp/server.ts` calls those hooks at the matching points and supplies the real ping function.

**Why acp, not TUI:** the engine-only fork uses only acp; the TUI is being cut (see [[reasonix-fork-optimize-design]]). Idle gaps are most common on background acp lanes, which is exactly where keepalive belongs.

**Error handling:** a ping error (network/abort) is swallowed, logged at debug only, and does not affect any real turn (the real turn cancels the timer before running). Pings never block or delay a real `session/prompt`. Session close always clears the timer.

---

## Configuration

Added to `~/.reasonix/config.json`, all with safe defaults:

| Key | Default | Meaning |
|---|---|---|
| `cacheBustProbability` | `0.15` | P_bust used by A2 economics. `0` = exactly today's behavior. |
| `keepaliveIntervalMs` | `240000` (4 min) | Idle ping cycle (must stay under the cache TTL). |
| `keepaliveMaxPings` | `10` | Cap on consecutive idle pings before stopping. |
| `keepaliveEnabled` | `true` | Master switch for keepalive. |

---

## Testing

Every unit test runs against fakes — no real model call.

**A2 `estimateFoldEconomics` (pure function):**
- prompt 150K + P_bust 0.15 → `worthwhile === false` (small session does not fold).
- prompt 800K + P_bust 0.15 → `worthwhile === true` (large session folds).
- P_bust 0 → result numerically identical to the pre-change function (no regression).
- pricing missing for model → `worthwhile === true` (safe fallback unchanged).

**Keepalive (fake timer + fake ping fn + injectable clock):**
- idle 4 min → `ping` called exactly once with the current prefix and `max_tokens === 1`.
- a real turn arrives before 4 min → `ping` NOT called (timer cleared).
- 10 consecutive pings → the 11th does not fire (cap honored).
- `ping` throws → no exception escapes; the timer still re-arms.
- session close → timer cleared (assert no pending timer).

**Integration (one acp end-to-end test, fake model counting cache):**
- simulate an idle gap longer than the TTL. With keepalive enabled → 0 busts. With keepalive disabled → 1 bust. Asserts the two components together eliminate the gap-induced bust.

**Success metric (measured on real use):** re-run a workflow/automation session that has long idle gaps, then compare the cost ledger against the baseline: total `cache_miss` drops substantially (the 12 gap-induced busts × ~400K = 4.17M miss seen in `code-level_2` should nearly disappear), and the average cache-hit% on a gappy session rises toward the continuous-use level (95% → ~99%).

---

## Non-Goals (YAGNI)

- **A1 timestamp tracking** — measuring the real inter-turn gap and deriving P(gap > TTL) per turn. A2's constant `cacheBustProbability` is sufficient; per-turn timing is a future refinement, not part of this work.
- **Measuring the exact TTL decay curve** — keepalive uses a fixed safe interval well under the observed TTL.
- **TUI changes** — the TUI path is being removed from the engine-only fork; keepalive targets acp only.
