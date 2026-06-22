import { describe, expect, it } from "vitest";
import { Usage } from "../src/client.js";
import { ContextManager, estimateFoldEconomics } from "../src/context-manager.js";

function manager(cacheBustProbability = 0.15): ContextManager {
  return new ContextManager({
    client: {} as never,
    log: {} as never,
    stats: {} as never,
    sessionName: null,
    getAbortSignal: () => new AbortController().signal,
    getCurrentTurn: () => 1,
    getSystemPrompt: () => "system",
    cacheBustProbability,
  });
}

describe("ContextManager fold economics", () => {
  it("does not fold a small warm session under default bust-risk", () => {
    // 100k tokens = ratio 0.1, well below HISTORY_FOLD_THRESHOLD (0.75).
    // decideAfterUsage returns kind "none" immediately with no economics.
    // At P_bust=0.15 the bust-risk term is negligible on such a tiny session.
    const usage = new Usage(100_000, 100, 100_100, 95_000, 5_000);
    const decision = manager().decideAfterUsage(usage, "deepseek-v4-flash", false);

    expect(decision.kind).toBe("none");
  });

  it("folds in the normal band when high miss tokens make carrying context expensive", () => {
    const usage = new Usage(760_000, 100, 760_100, 0, 760_000);
    const decision = manager().decideAfterUsage(usage, "deepseek-v4-flash", false);

    expect(decision.kind).toBe("fold");
    expect(decision.economics?.worthwhile).toBe(true);
  });

  it("still folds aggressively for headroom even if cache economics are cheap", () => {
    const usage = new Usage(790_000, 100, 790_100, 782_000, 8_000);
    const decision = manager().decideAfterUsage(usage, "deepseek-v4-flash", false);

    expect(decision.kind).toBe("fold");
    expect(decision.aggressive).toBe(true);
  });

  it("estimates fold cost over a short multi-turn horizon", () => {
    const usage = new Usage(760_000, 100, 760_100, 0, 760_000);
    const economics = estimateFoldEconomics(usage, "deepseek-v4-flash", 200_000, 0.15);

    expect(economics.horizonTurns).toBeGreaterThan(1);
    expect(economics.carryInputUsd).toBeGreaterThan(economics.foldInputUsd);
    expect(economics.savingsUsd).toBeGreaterThan(0);
  });
});
