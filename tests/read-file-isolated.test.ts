import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCodeToolset } from "../src/code/setup.js";

// Lever B — sub-agent read-in-isolation.
// REASONIX_READ_ISOLATED gates a `read_file_isolated` tool that spawns a child
// loop (separate context) to read a file and return only a <=2K summary; the
// parent never ingests the raw bytes.
//
// Flag OFF (default): the tool MUST NOT appear in buildCodeToolset specs, and
// read_file's description must be byte-identical to today (no prefix change ->
// no cache disturbance).
// Flag ON: the tool appears in specs and, when dispatched, returns a summary
// (not the raw file) produced by a spawned child loop.

const specNames = (specs: Array<{ function: { name: string } }>): string[] =>
  specs.map((s) => s.function.name);

const readFileDesc = (specs: Array<{ function: { name: string; description: string } }>): string =>
  specs.find((s) => s.function.name === "read_file")?.function.description ?? "";

describe("Lever B: read_file_isolated", () => {
  let savedKey: string | undefined;
  let savedFlag: string | undefined;
  let tmpRoot: string;

  beforeEach(() => {
    savedKey = process.env.DEEPSEEK_API_KEY;
    savedFlag = process.env.REASONIX_READ_ISOLATED;
    // biome-ignore lint/performance/noDelete: setting "undefined" string would mask test
    delete process.env.DEEPSEEK_API_KEY;
    tmpRoot = mkdtempSync(join(tmpdir(), "reasonix-read-isolated-"));
  });

  afterEach(async () => {
    if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
    // biome-ignore lint/performance/noDelete: restoring absent env var; "undefined" string would leak
    else delete process.env.DEEPSEEK_API_KEY;
    if (savedFlag !== undefined) process.env.REASONIX_READ_ISOLATED = savedFlag;
    // biome-ignore lint/performance/noDelete: restoring absent env var; "undefined" string would leak
    else delete process.env.REASONIX_READ_ISOLATED;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("flag OFF: read_file_isolated absent and read_file description byte-stable", async () => {
    // biome-ignore lint/performance/noDelete: assert true default (env unset), not "0"
    delete process.env.REASONIX_READ_ISOLATED;
    const offToolset = await buildCodeToolset({ rootDir: tmpRoot });
    const offSpecs = offToolset.tools.specs();
    expect(specNames(offSpecs)).not.toContain("read_file_isolated");
    const offDesc = readFileDesc(offSpecs);
    await offToolset.jobs.shutdown();

    process.env.REASONIX_READ_ISOLATED = "0";
    const zeroToolset = await buildCodeToolset({ rootDir: tmpRoot });
    const zeroSpecs = zeroToolset.tools.specs();
    expect(specNames(zeroSpecs)).not.toContain("read_file_isolated");
    // Byte-identical read_file description with the flag absent vs "0".
    expect(readFileDesc(zeroSpecs)).toBe(offDesc);
    // And no nudge text leaks in when off.
    expect(offDesc).not.toContain("read_file_isolated");
    await zeroToolset.jobs.shutdown();
  });

  it("flag ON: read_file_isolated present in specs + read_file nudge added", async () => {
    process.env.REASONIX_READ_ISOLATED = "1";
    const toolset = await buildCodeToolset({ rootDir: tmpRoot });
    const specs = toolset.tools.specs();
    expect(specNames(specs)).toContain("read_file_isolated");
    // read_file gains the nudge.
    expect(readFileDesc(specs)).toContain("read_file_isolated");
    await toolset.jobs.shutdown();
  });

  it("flag ON: dispatch returns a child-loop summary, not raw bytes", async () => {
    process.env.REASONIX_READ_ISOLATED = "1";

    const bigContent = `LINE-ALPHA\n${"x".repeat(5000)}\nLINE-OMEGA\n`;
    const fileName = "big.txt";
    writeFileSync(join(tmpRoot, fileName), bigContent, "utf8");

    // Stub the child loop so the test needs no real DeepSeek call: spawnSubagent
    // is mocked to return a short canned summary, proving the tool routes through
    // a spawned child and surfaces only the summary (not the 5K raw body).
    const subagentMod = await import("../src/tools/subagent.js");
    const spy = vi.spyOn(subagentMod, "spawnSubagent").mockResolvedValue({
      success: true,
      output: "SUMMARY: big.txt has LINE-ALPHA then a padding block then LINE-OMEGA.",
      turns: 1,
      toolIters: 1,
      elapsedMs: 5,
      costUsd: 0,
      model: "deepseek-v4-flash",
      usage: new (await import("../src/client.js")).Usage(),
    });

    process.env.DEEPSEEK_API_KEY = "test-key";
    const toolset = await buildCodeToolset({ rootDir: tmpRoot });
    const out = await toolset.tools.dispatch(
      "read_file_isolated",
      JSON.stringify({ path: fileName }),
    );
    // The spawned child was invoked.
    expect(spy).toHaveBeenCalledTimes(1);
    // The summary surfaces; the raw 5K padding does NOT.
    expect(out).toContain("SUMMARY");
    expect(out).not.toContain("x".repeat(200));
    expect(out.length).toBeLessThan(2048);

    spy.mockRestore();
    await toolset.jobs.shutdown();
  });
});
