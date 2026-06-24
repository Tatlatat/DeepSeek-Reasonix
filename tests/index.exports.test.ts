import { describe, expect, it } from "vitest";
import * as lib from "../src/index.js";

describe("library exports for the fleet", () => {
  it("exports buildCodeToolset", () => {
    expect(typeof lib.buildCodeToolset).toBe("function");
  });
  it("exports loadEndpoint", () => {
    expect(typeof lib.loadEndpoint).toBe("function");
  });
  it("exports the engine core", () => {
    for (const k of ["DeepSeekClient", "CacheFirstLoop", "ImmutablePrefix"]) {
      expect(lib).toHaveProperty(k);
    }
  });
  // Lever D — pre-index. The fleet gateway builds the semantic index ONCE
  // (buildIndex) and per-lane shims check compatibility read-only
  // (indexCompatible). Both must be re-exported from the library entry point.
  it("exports buildIndex and indexCompatible (Lever D pre-index)", () => {
    expect(typeof lib.buildIndex).toBe("function");
    expect(typeof lib.indexCompatible).toBe("function");
  });
});
