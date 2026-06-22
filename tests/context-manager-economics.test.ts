import { describe, expect, it } from "vitest";
import { Usage } from "../src/client.js";
import { estimateFoldEconomics } from "../src/context-manager.js";

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
