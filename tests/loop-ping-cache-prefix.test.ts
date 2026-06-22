/** Tests for CacheFirstLoop.pingCachePrefix — ephemeral max_tokens:1 keepalive. */

import { describe, expect, it, vi } from "vitest";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";

// Minimal fake ChatResponse that satisfies DeepSeekClient.chat return type.
function fakeChatResponse() {
  return { content: "", usage: undefined, reasoningContent: undefined } as any;
}

/** Build a CacheFirstLoop with an injected fake client. Mirrors the
 *  construction pattern from tests/loop.test.ts. */
function makeTestLoop(fakeClient: { chat: ReturnType<typeof vi.fn> }) {
  return new CacheFirstLoop({
    client: fakeClient as any,
    prefix: new ImmutablePrefix({ system: "be brief" }),
    stream: false,
  });
}

describe("pingCachePrefix", () => {
  it("issues one max_tokens:1 chat over current messages and appends nothing to the log", async () => {
    const chat = vi.fn().mockResolvedValue(fakeChatResponse());
    const loop = makeTestLoop({ chat });

    const before = (loop as any).log.toFullHistory().length;
    await loop.pingCachePrefix();
    const after = (loop as any).log.toFullHistory().length;

    // Must have called chat exactly once
    expect(chat).toHaveBeenCalledTimes(1);

    // The call must use maxTokens: 1
    const opts = chat.mock.calls[0]![0];
    expect(opts.maxTokens).toBe(1);

    // Must include model
    expect(typeof opts.model).toBe("string");

    // Must NOT pass tools (keepalive must not invoke tool machinery)
    expect(opts.tools).toBeUndefined();

    // Ephemeral: log length unchanged — nothing appended
    expect(after).toBe(before);
  });

  it("swallows chat errors — a failed keepalive must never surface", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("network error"));
    const loop = makeTestLoop({ chat });

    // Must resolve (not throw) even when chat rejects
    await expect(loop.pingCachePrefix()).resolves.toBeUndefined();
  });
});
