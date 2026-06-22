import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadCacheBustProbability,
  loadKeepaliveEnabled,
  loadKeepaliveIntervalMs,
  loadKeepaliveMaxPings,
} from "../src/config.js";

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

  it("treats an explicit cacheBustProbability of 0 as a valid stored value", () => {
    expect(loadCacheBustProbability(cfgFile({ cacheBustProbability: 0 }))).toBe(0);
  });

  it("floors keepaliveIntervalMs at 1000ms to prevent a ping storm", () => {
    expect(loadKeepaliveIntervalMs(cfgFile({ keepaliveIntervalMs: 1 }))).toBe(1000);
    expect(loadKeepaliveIntervalMs(cfgFile({ keepaliveIntervalMs: 500 }))).toBe(1000);
  });
});
