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
});
