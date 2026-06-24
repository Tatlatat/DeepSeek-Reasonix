import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEphemeralSession } from "../src/config.js";

describe("ephemeral session", () => {
  beforeEach(() => {
    Reflect.deleteProperty(process.env, "REASONIX_ACP_EPHEMERAL_SESSION");
  });
  afterEach(() => {
    Reflect.deleteProperty(process.env, "REASONIX_ACP_EPHEMERAL_SESSION");
  });

  it("defaults off", () => {
    expect(loadEphemeralSession()).toBe(false);
  });

  it("on when env=1", () => {
    process.env.REASONIX_ACP_EPHEMERAL_SESSION = "1";
    expect(loadEphemeralSession()).toBe(true);
  });

  it("on for true/yes/on (case-insensitive)", () => {
    for (const v of ["true", "TRUE", "yes", "On"]) {
      process.env.REASONIX_ACP_EPHEMERAL_SESSION = v;
      expect(loadEphemeralSession()).toBe(true);
    }
  });

  it("off for empty / 0 / other values", () => {
    for (const v of ["", "0", "false", "no", "off"]) {
      process.env.REASONIX_ACP_EPHEMERAL_SESSION = v;
      expect(loadEphemeralSession()).toBe(false);
    }
  });
});
