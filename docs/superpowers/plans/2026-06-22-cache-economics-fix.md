# Cache-Economics Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop large DeepSeek prompt-cache-miss costs on long-lived reasonix sessions by making fold economics account for cache-bust risk (A2) and keeping the prefix cache warm during idle gaps (Keepalive).

**Architecture:** A2 adds one additive term to the pure function `estimateFoldEconomics` so large sessions fold and small ones don't. Keepalive is a new pure timer module plus one public loop method (`pingCachePrefix`) plus wiring in the acp `session/prompt` handler. The two are independent and defense-in-depth.

**Tech Stack:** TypeScript, reasonix legacy v1 (branch `v1`). Test runner: vitest (the repo's existing runner — confirm with `npx vitest run <file>`). No new runtime dependencies.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-06-22-cache-economics-fix-design.md`. Every task implicitly includes its requirements.
- Pricing source of truth: `src/telemetry/stats.ts` — v4-flash `inputCacheHit = 0.0028`, `inputCacheMiss = 0.14` (USD per 1e6 tokens). miss is 50× hit.
- Config defaults (exact values): `cacheBustProbability = 0.15`, `keepaliveIntervalMs = 240000`, `keepaliveMaxPings = 10`, `keepaliveEnabled = true`.
- `cacheBustProbability = 0` MUST make `estimateFoldEconomics` numerically identical to the pre-change function (regression off-switch).
- A2's bust term is additive to carry cost only — it can never make folding *less* likely than today (no context-overflow regression).
- Keepalive pings MUST be ephemeral: never append a message to session history (prefix-cache-safe).
- Keepalive MUST never block, delay, or error a real `session/prompt` turn.
- Run the full suite (`npx vitest run`) green before the final commit of each task.

---

## File Structure

- `src/config.ts` — MODIFY: add 4 optional fields to `ReasonixConfig` and 4 loader functions (mirror `loadContextTokens`).
- `src/context-manager.ts` — MODIFY: `estimateFoldEconomics` gains a `cacheBustProbability` parameter and the bust term; its one caller in `decideAfterUsage` passes the config value.
- `src/loop.ts` — MODIFY: add a public `pingCachePrefix(): Promise<void>` method to `CacheFirstLoop`.
- `src/acp/keepalive.ts` — CREATE: pure idle-timer module (no I/O, injectable clock + ping callback).
- `src/cli/commands/acp.ts` — MODIFY: instantiate keepalive per session and call its hooks around `session/prompt` and on close.
- Tests: `src/context-manager.economics.test.ts`, `src/acp/keepalive.test.ts`, `src/config.cache-economics.test.ts` (create alongside existing test files — confirm the repo's test glob includes `src/**/*.test.ts`).

---

## Task 1: Config fields + loaders

**Files:**
- Modify: `src/config.ts` (interface `ReasonixConfig` near L173-316; add loaders after `loadContextTokens` near L841)
- Test: `src/config.cache-economics.test.ts`

**Interfaces:**
- Produces: `loadCacheBustProbability(path?: string): number` (default 0.15), `loadKeepaliveIntervalMs(path?: string): number` (default 240000), `loadKeepaliveMaxPings(path?: string): number` (default 10), `loadKeepaliveEnabled(path?: string): boolean` (default true). All read from `readConfig(path)` and clamp to safe ranges.

- [ ] **Step 1: Write the failing test**

Create `src/config.cache-economics.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadCacheBustProbability,
  loadKeepaliveIntervalMs,
  loadKeepaliveMaxPings,
  loadKeepaliveEnabled,
} from "./config.js";

function cfgFile(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rx-cfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("cache-economics config loaders", () => {
  it("returns defaults when keys absent", () => {
    const p = cfgFile({});
    expect(loadCacheBustProbability(p)).toBe(0.15);
    expect(loadKeepaliveIntervalMs(p)).toBe(240000);
    expect(loadKeepaliveMaxPings(p)).toBe(10);
    expect(loadKeepaliveEnabled(p)).toBe(true);
  });

  it("reads provided values", () => {
    const p = cfgFile({
      cacheBustProbability: 0.3,
      keepaliveIntervalMs: 120000,
      keepaliveMaxPings: 4,
      keepaliveEnabled: false,
    });
    expect(loadCacheBustProbability(p)).toBe(0.3);
    expect(loadKeepaliveIntervalMs(p)).toBe(120000);
    expect(loadKeepaliveMaxPings(p)).toBe(4);
    expect(loadKeepaliveEnabled(p)).toBe(false);
  });

  it("clamps cacheBustProbability into [0,1] and rejects non-numbers", () => {
    expect(loadCacheBustProbability(cfgFile({ cacheBustProbability: 5 }))).toBe(1);
    expect(loadCacheBustProbability(cfgFile({ cacheBustProbability: -2 }))).toBe(0);
    expect(loadCacheBustProbability(cfgFile({ cacheBustProbability: "x" }))).toBe(0.15);
  });

  it("rejects non-positive interval/maxPings and falls back to default", () => {
    expect(loadKeepaliveIntervalMs(cfgFile({ keepaliveIntervalMs: 0 }))).toBe(240000);
    expect(loadKeepaliveMaxPings(cfgFile({ keepaliveMaxPings: -1 }))).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/config.cache-economics.test.ts`
Expected: FAIL — `loadCacheBustProbability` (and siblings) is not exported.

- [ ] **Step 3: Add the interface fields**

In `src/config.ts`, inside the `ReasonixConfig` interface (near the `contextTokens?` / `pricingOverride?` fields, ~L311-316), add:
```ts
  cacheBustProbability?: number;
  keepaliveIntervalMs?: number;
  keepaliveMaxPings?: number;
  keepaliveEnabled?: boolean;
```

- [ ] **Step 4: Add the loaders**

In `src/config.ts`, after `loadContextTokens` (which ends ~L841), add:
```ts
export function loadCacheBustProbability(path: string = defaultConfigPath()): number {
  const raw = readConfig(path).cacheBustProbability;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0.15;
  return Math.min(1, Math.max(0, raw));
}

export function loadKeepaliveIntervalMs(path: string = defaultConfigPath()): number {
  const raw = readConfig(path).keepaliveIntervalMs;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 240000;
  return Math.floor(raw);
}

export function loadKeepaliveMaxPings(path: string = defaultConfigPath()): number {
  const raw = readConfig(path).keepaliveMaxPings;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 10;
  return Math.floor(raw);
}

export function loadKeepaliveEnabled(path: string = defaultConfigPath()): boolean {
  const raw = readConfig(path).keepaliveEnabled;
  return typeof raw === "boolean" ? raw : true;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/config.cache-economics.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.cache-economics.test.ts
git commit -m "feat(config): cache-economics config fields and loaders"
```

---

## Task 2: A2 bust-risk economics

**Files:**
- Modify: `src/context-manager.ts` (`estimateFoldEconomics` ~L104-144; its caller `decideAfterUsage` ~L221 passes the value)
- Test: `src/context-manager.economics.test.ts`

**Interfaces:**
- Consumes: `Usage` (from `./client.js`, has `promptTokens`, `promptCacheHitTokens`, `promptCacheMissTokens`), `pricingFor(model)` → `{ inputCacheHit, inputCacheMiss, output } | undefined`, `inputCostUsd(model, usage)`.
- Produces: `estimateFoldEconomics(usage, model, tailBudgetTokens, cacheBustProbability)` — new 4th param `cacheBustProbability: number`. Same `FoldEconomics` return shape.

- [ ] **Step 1: Write the failing test**

Create `src/context-manager.economics.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Usage } from "./client.js";
import { estimateFoldEconomics } from "./context-manager.js";

// v4-flash pricing: inputCacheHit 0.0028, inputCacheMiss 0.14 per 1e6 tok.
function usageWith(promptTokens: number): Usage {
  // mostly-cached prompt: hit ~ all, miss small — the warm-steady-state case.
  const u = new Usage();
  u.promptTokens = promptTokens;
  u.promptCacheHitTokens = Math.floor(promptTokens * 0.99);
  u.promptCacheMissTokens = promptTokens - u.promptCacheHitTokens;
  return u;
}

const MODEL = "deepseek-v4-flash";
const TAIL = 200_000;

describe("estimateFoldEconomics bust-risk term", () => {
  it("small warm session is not worth folding", () => {
    const e = estimateFoldEconomics(usageWith(150_000), MODEL, TAIL, 0.15);
    expect(e.worthwhile).toBe(false);
  });

  it("large session becomes worth folding due to bust risk", () => {
    const e = estimateFoldEconomics(usageWith(800_000), MODEL, TAIL, 0.15);
    expect(e.worthwhile).toBe(true);
  });

  it("cacheBustProbability=0 reproduces legacy behavior (large warm session not folded)", () => {
    const e = estimateFoldEconomics(usageWith(800_000), MODEL, TAIL, 0);
    // With no bust risk and a near-fully-cached prompt, carry cost ~ 0 → not worthwhile.
    expect(e.worthwhile).toBe(false);
  });

  it("missing pricing falls back to worthwhile=true", () => {
    const e = estimateFoldEconomics(usageWith(800_000), "no-such-model", TAIL, 0.15);
    expect(e.worthwhile).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/context-manager.economics.test.ts`
Expected: FAIL — `estimateFoldEconomics` currently takes 3 args; the 4-arg calls compile but the bust cases assert the wrong result (large session `worthwhile` is currently `false`). Specifically "large session becomes worth folding" FAILS.

- [ ] **Step 3: Add the bust term**

In `src/context-manager.ts`, change the signature and the `carryInputUsd` line. Replace the function body region from the signature through `const carryInputUsd = ...`:

Signature (was 3 params):
```ts
export function estimateFoldEconomics(
  usage: Usage,
  model: string,
  tailBudgetTokens: number,
  cacheBustProbability: number,
): FoldEconomics {
```

Carry cost (was `const carryInputUsd = inputCostUsd(model, usage) * horizonTurns;`):
```ts
  const bustExtraPerTurnUsd =
    (usage.promptTokens *
      cacheBustProbability *
      (pricing.inputCacheMiss - pricing.inputCacheHit)) /
    1_000_000;
  const carryInputUsd =
    inputCostUsd(model, usage) * horizonTurns + bustExtraPerTurnUsd * horizonTurns;
```
Leave the `!pricing` early-return, `foldInputUsd`, `savingsUsd`, `savingsFraction`, and the `worthwhile` gate exactly as they are.

- [ ] **Step 4: Update the caller in decideAfterUsage**

In `src/context-manager.ts`, `decideAfterUsage` (~L221) calls `estimateFoldEconomics(usage, model, tailBudget)`. It needs the config value. Add a field to `ContextManagerDeps` (interface ~L59) so the manager can read it once:
```ts
  /** P(cache-bust before next turn) fed to fold economics. Default 0.15 via loader. */
  cacheBustProbability: number;
```
Then change the call site:
```ts
      const economics = estimateFoldEconomics(usage, model, tailBudget, this.deps.cacheBustProbability);
```
Wire the value where the ContextManager is constructed — find construction with `grep -n "new ContextManager\|ContextManagerDeps\|deps:" src/loop.ts` and pass `cacheBustProbability: loadCacheBustProbability()` (import from `./config.js`). If the constructor is in `loop.ts`, add the import there.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/context-manager.economics.test.ts`
Expected: PASS (all 4). Then `npx vitest run src/context-manager.test.ts` (existing tests) — if any existing test calls `estimateFoldEconomics` with 3 args, update it to pass a 4th arg `0.15`; if any constructs `ContextManager` deps, add `cacheBustProbability: 0.15`.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions). Fix any 3-arg `estimateFoldEconomics` call or `ContextManagerDeps` literal the compiler flags.

- [ ] **Step 7: Commit**

```bash
git add src/context-manager.ts src/context-manager.economics.test.ts src/loop.ts
git commit -m "feat(context-manager): add cache-bust-risk term to fold economics"
```

---

## Task 3: Loop pingCachePrefix method

**Files:**
- Modify: `src/loop.ts` (`CacheFirstLoop`, add public method; `client` is `readonly client: DeepSeekClient` ~L153, history via `this.log.toFullHistory()` ~L618, model/system already used in the `this.client.chat({...})` call ~L969)
- Test: `src/loop.ping.test.ts`

**Interfaces:**
- Consumes: `this.client.chat({ system, messages, model, maxTokens })` → `Promise<ChatResponse>` (see `DeepSeekClient.chat` in `src/client.ts:283`; `maxTokens` is honored at `src/client.ts:220`), `this.log.toFullHistory(): ChatMessage[]`.
- Produces: `CacheFirstLoop.pingCachePrefix(): Promise<void>` — issues one `max_tokens: 1` chat over the CURRENT system+history to renew the prefix cache; appends nothing to the log; swallows errors.

- [ ] **Step 1: Read the existing chat call to copy its shape**

Run: `grep -n "this.client.chat(" src/loop.ts` and read those lines plus the surrounding system-prompt/model variables. Note the exact property names the loop already passes (e.g. `system`, `messages`, `model`, `tools`). The ping uses the SAME system + the SAME `this.log.toFullHistory()` messages, NO tools, `maxTokens: 1`.

- [ ] **Step 2: Write the failing test**

Create `src/loop.ping.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { CacheFirstLoop } from "./loop.js";

// Build a loop with a fake client that records chat() calls. Use the same
// constructor options the existing loop tests use — copy the helper from
// src/loop.test.ts (look for a makeLoop/buildLoop factory) and inject a fake
// client whose chat() resolves to a minimal ChatResponse.
function fakeChatResponse() {
  return { content: "", usage: undefined, reasoningContent: undefined } as any;
}

describe("pingCachePrefix", () => {
  it("issues one max_tokens:1 chat over current history and appends nothing", async () => {
    const chat = vi.fn().mockResolvedValue(fakeChatResponse());
    const loop = makeTestLoop({ client: { chat, baseUrl: "http://x" } as any });
    const before = (loop as any).log.toFullHistory().length;
    await loop.pingCachePrefix();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][0].maxTokens).toBe(1);
    const after = (loop as any).log.toFullHistory().length;
    expect(after).toBe(before); // ephemeral: no message appended
  });

  it("swallows chat errors", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("network"));
    const loop = makeTestLoop({ client: { chat, baseUrl: "http://x" } as any });
    await expect(loop.pingCachePrefix()).resolves.toBeUndefined();
  });
});

// makeTestLoop: import or replicate the factory used by src/loop.test.ts.
declare function makeTestLoop(overrides: any): CacheFirstLoop;
```
Before running, replace the `declare function makeTestLoop` with the actual loop-construction helper from `src/loop.test.ts` (open it, copy the factory, adapt to inject the fake client). If no factory exists, construct `CacheFirstLoop` with the minimal options the existing tests use.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/loop.ping.test.ts`
Expected: FAIL — `pingCachePrefix` is not a method on `CacheFirstLoop`.

- [ ] **Step 4: Implement the method**

In `src/loop.ts`, inside `class CacheFirstLoop`, add (use the EXACT property names found in Step 1 — `system`/`messages`/`model` may differ; match the existing `this.client.chat({...})` call):
```ts
  /** Touch the current prefix with a 1-token call to renew the DeepSeek prompt
   *  cache during idle gaps. Ephemeral: appends nothing to the log, so the
   *  prefix hash is unchanged (cache-safe). Errors are swallowed — a failed
   *  keepalive must never affect a real turn. */
  async pingCachePrefix(): Promise<void> {
    try {
      await this.client.chat({
        system: this.systemPrompt,
        messages: this.log.toFullHistory(),
        model: this.model,
        maxTokens: 1,
      });
    } catch {
      // keepalive is best-effort; never surface to the caller
    }
  }
```
If the loop's system-prompt field is not named `this.systemPrompt`, use the same expression the existing `chat` call uses for `system`. Do NOT pass `tools`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/loop.ping.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add src/loop.ts src/loop.ping.test.ts
git commit -m "feat(loop): pingCachePrefix for idle cache keepalive"
```

---

## Task 4: Keepalive timer module

**Files:**
- Create: `src/acp/keepalive.ts`
- Test: `src/acp/keepalive.test.ts`

**Interfaces:**
- Consumes: nothing from the codebase (pure module). Injected `ping: () => Promise<void>`, and a clock: `setTimer: (fn: () => void, ms: number) => T`, `clearTimer: (t: T) => void` (default to `setTimeout`/`clearTimeout`).
- Produces: `class Keepalive` with `onTurnStart(): void`, `onTurnEnd(): void`, `close(): void`. Constructor: `new Keepalive(opts: { enabled: boolean; intervalMs: number; maxPings: number; ping: () => Promise<void>; setTimer?; clearTimer? })`.

- [ ] **Step 1: Write the failing test**

Create `src/acp/keepalive.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { Keepalive } from "./keepalive.js";

// Controllable fake clock: tasks keyed by id, advance() fires due ones.
function fakeClock() {
  let nextId = 1;
  const tasks = new Map<number, { fn: () => void }>();
  return {
    setTimer: (fn: () => void) => {
      const id = nextId++;
      tasks.set(id, { fn });
      return id;
    },
    clearTimer: (id: number) => tasks.delete(id),
    fireAll: () => {
      const due = [...tasks.entries()];
      for (const [id, t] of due) {
        tasks.delete(id);
        t.fn();
      }
    },
    pending: () => tasks.size,
  };
}

function make(overrides: Partial<{ enabled: boolean; maxPings: number; ping: () => Promise<void> }> = {}) {
  const clock = fakeClock();
  const ping = overrides.ping ?? vi.fn().mockResolvedValue(undefined);
  const ka = new Keepalive({
    enabled: overrides.enabled ?? true,
    intervalMs: 240000,
    maxPings: overrides.maxPings ?? 10,
    ping,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { ka, clock, ping };
}

describe("Keepalive", () => {
  it("pings once after an idle interval following a turn", async () => {
    const { ka, clock, ping } = make();
    ka.onTurnEnd();
    expect(clock.pending()).toBe(1);
    clock.fireAll();
    await Promise.resolve();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("does not ping if a turn starts before the interval fires", async () => {
    const { ka, clock, ping } = make();
    ka.onTurnEnd();
    ka.onTurnStart(); // real turn arrived
    expect(clock.pending()).toBe(0);
    clock.fireAll();
    await Promise.resolve();
    expect(ping).not.toHaveBeenCalled();
  });

  it("stops after maxPings consecutive pings", async () => {
    const { ka, clock, ping } = make({ maxPings: 3 });
    ka.onTurnEnd();
    for (let i = 0; i < 5; i++) {
      clock.fireAll();
      await Promise.resolve();
    }
    expect(ping).toHaveBeenCalledTimes(3);
    expect(clock.pending()).toBe(0);
  });

  it("resets the ping counter when a real turn happens", async () => {
    const { ka, clock, ping } = make({ maxPings: 2 });
    ka.onTurnEnd();
    clock.fireAll(); await Promise.resolve(); // ping 1
    ka.onTurnStart(); ka.onTurnEnd();          // real turn resets counter
    clock.fireAll(); await Promise.resolve();  // ping 1 again (not 3)
    clock.fireAll(); await Promise.resolve();  // ping 2
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it("does nothing when disabled", () => {
    const { ka, clock } = make({ enabled: false });
    ka.onTurnEnd();
    expect(clock.pending()).toBe(0);
  });

  it("keeps cycling when ping rejects", async () => {
    const ping = vi.fn().mockRejectedValue(new Error("boom"));
    const { ka, clock } = make({ ping, maxPings: 2 });
    ka.onTurnEnd();
    clock.fireAll(); await Promise.resolve(); await Promise.resolve();
    expect(clock.pending()).toBe(1); // re-armed despite rejection
  });

  it("close clears the timer", () => {
    const { ka, clock } = make();
    ka.onTurnEnd();
    ka.close();
    expect(clock.pending()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/acp/keepalive.test.ts`
Expected: FAIL — `./keepalive.js` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/acp/keepalive.ts`:
```ts
/** Idle prefix-cache keepalive. After a turn ends, schedule a ping; if no real
 *  turn arrives before the interval, ping the model to renew the DeepSeek
 *  prompt cache, then re-arm — up to maxPings consecutive times. A real turn
 *  (onTurnStart) cancels the pending ping and resets the counter. Pure timer
 *  logic; the clock and the ping action are injected. */

export interface KeepaliveOptions {
  enabled: boolean;
  intervalMs: number;
  maxPings: number;
  ping: () => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class Keepalive {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly maxPings: number;
  private readonly ping: () => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private timer: unknown = null;
  private pingsSoFar = 0;

  constructor(opts: KeepaliveOptions) {
    this.enabled = opts.enabled;
    this.intervalMs = opts.intervalMs;
    this.maxPings = opts.maxPings;
    this.ping = opts.ping;
    this.setTimer =
      opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** A real turn is starting: cancel any pending ping and reset the counter. */
  onTurnStart(): void {
    this.cancel();
    this.pingsSoFar = 0;
  }

  /** A turn finished: arm the idle ping (unless disabled or capped). */
  onTurnEnd(): void {
    this.arm();
  }

  /** Session closing: cancel any pending ping (no leak). */
  close(): void {
    this.cancel();
  }

  private arm(): void {
    if (!this.enabled) return;
    if (this.pingsSoFar >= this.maxPings) return;
    this.cancel();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.pingsSoFar += 1;
      void this.ping().catch(() => undefined).finally(() => this.arm());
    }, this.intervalMs);
  }

  private cancel(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/acp/keepalive.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/acp/keepalive.ts src/acp/keepalive.test.ts
git commit -m "feat(acp): keepalive idle-timer module"
```

---

## Task 5: Wire keepalive into the acp session/prompt handler

**Files:**
- Modify: `src/cli/commands/acp.ts` (session creation; `session/prompt` handler ~L276-342; teardown ~L349-360)
- Test: covered by `src/acp/keepalive.test.ts` (unit) + a manual smoke (Step 5)

**Interfaces:**
- Consumes: `Keepalive` (Task 4), `loadKeepaliveEnabled/IntervalMs/MaxPings` (Task 1), `session.loop.pingCachePrefix()` (Task 3).
- Produces: per-session keepalive that pings during idle gaps.

- [ ] **Step 1: Read the session shape**

Run: `grep -n "sessions.set\|interface .*Session\|session.loop\|session.id\|type Session" src/cli/commands/acp.ts` to find where a session object is created and what fields it holds. The keepalive instance attaches to that session object (add a `keepalive: Keepalive` field).

- [ ] **Step 2: Construct keepalive at session creation**

Where each session is created (after `session.loop` exists), add (import at top: `import { Keepalive } from "../../acp/keepalive.js";` and the three loaders from `../../config.js`):
```ts
    session.keepalive = new Keepalive({
      enabled: loadKeepaliveEnabled(),
      intervalMs: loadKeepaliveIntervalMs(),
      maxPings: loadKeepaliveMaxPings(),
      ping: () => session.loop.pingCachePrefix(),
    });
```
Add `keepalive: Keepalive` to the session type/interface so TypeScript accepts the field.

- [ ] **Step 3: Call the hooks around the turn**

In the `session/prompt` handler (~L276), immediately after the session is resolved and before `session.aborter = new AbortController();`:
```ts
    session.keepalive.onTurnStart();
```
In the `finally` block (~L338, alongside `session.aborter = null;`):
```ts
    session.keepalive.onTurnEnd();
```

- [ ] **Step 4: Clear on teardown**

In the server-shutdown `finally` (~L349-360, the loop over `sessions.values()`), add inside the loop:
```ts
      session.keepalive.close();
```

- [ ] **Step 5: Build, full suite, and a manual smoke test**

Run: `npx tsc --noEmit` (type-check the wiring) — Expected: no errors.
Run: `npx vitest run` — Expected: PASS (no regressions).
Manual smoke (proves no behavioral break): start the acp agent and drive one prompt:
```bash
node dist/index.js acp --dir "$PWD" --yolo -m deepseek-v4-flash --effort low --budget 0.02 --transcript /tmp/ka-smoke.jsonl
```
(send initialize → session/new → session/prompt "what is 2+2?" over stdin NDJSON). Expected: a normal `stopReason: end_turn` response; the run does not hang and exits cleanly. (The idle ping itself is exercised by the unit tests with a fake clock; this smoke only confirms the wiring didn't break the turn path.)

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/acp.ts
git commit -m "feat(acp): wire keepalive into session/prompt lifecycle"
```

---

## Task 6: Documentation of config knobs

**Files:**
- Modify: the repo's user-facing config doc (find with `grep -rln "contextTokens\|pricingOverride" --include=*.md .` — likely `README.md` or a `docs/config*.md`)

**Interfaces:** none (docs only).

- [ ] **Step 1: Find the config doc**

Run: `grep -rln "contextTokens" --include=*.md .` — open the file that documents `~/.reasonix/config.json` keys.

- [ ] **Step 2: Add the four keys**

Document, near the existing `contextTokens`/`pricingOverride` entries:
```md
- `cacheBustProbability` (number, default 0.15): probability the prompt cache
  expires before the next turn, used by fold economics. Higher → folds large
  sessions sooner to keep cache-bust reloads cheap. `0` disables the bust term.
- `keepaliveEnabled` (boolean, default true): keep the DeepSeek prompt cache
  warm during idle gaps by pinging the prefix.
- `keepaliveIntervalMs` (number, default 240000): idle interval between
  keepalive pings; keep it under the cache TTL.
- `keepaliveMaxPings` (number, default 10): cap on consecutive idle pings
  before keepalive stops for an abandoned session.
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: document cache-economics config knobs"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** A2 economics → Task 2 ✅; Keepalive ping (ephemeral, max_tokens:1) → Task 3 ✅; keepalive timer (interval, maxPings cap, idle-only, error-swallow, close) → Task 4 ✅; acp wiring → Task 5 ✅; config knobs (4 keys, defaults, P_bust=0 off-switch) → Task 1 ✅; docs → Task 6 ✅; success-metric measurement → noted in spec, verified post-merge by re-running a gappy workflow and comparing the cost ledger (not a code task).

**Type consistency:** `estimateFoldEconomics` gains a 4th param `cacheBustProbability: number` (Task 2) consumed by `decideAfterUsage` and `ContextManagerDeps.cacheBustProbability`. `pingCachePrefix(): Promise<void>` defined Task 3, consumed Task 5. `Keepalive` methods `onTurnStart/onTurnEnd/close` defined Task 4, called Task 5. Config loader names (`loadCacheBustProbability`, `loadKeepaliveEnabled/IntervalMs/MaxPings`) defined Task 1, consumed Tasks 2 & 5.

**Placeholder scan:** none — every code step shows the code; test steps show full tests. Two steps (Task 3 Step 1, Task 5 Step 1) require reading existing helpers/field names first because exact local identifiers (`systemPrompt` vs the loop's actual field; the session factory in `loop.test.ts`) must match the real code — each such step states exactly what to grep and how to adapt.
