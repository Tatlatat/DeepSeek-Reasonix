import { describe, expect, it, vi } from "vitest";
import { Keepalive } from "../src/acp/keepalive.js";

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

function make(
  overrides: Partial<{ enabled: boolean; maxPings: number; ping: () => Promise<void> }> = {},
) {
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
    clock.fireAll();
    await Promise.resolve(); // ping 1
    ka.onTurnStart();
    ka.onTurnEnd(); // real turn resets counter
    clock.fireAll();
    await Promise.resolve(); // ping 1 again (not 3)
    clock.fireAll();
    await Promise.resolve(); // ping 2
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
    clock.fireAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.pending()).toBe(1); // re-armed despite rejection
  });

  it("close clears the timer", () => {
    const { ka, clock } = make();
    ka.onTurnEnd();
    ka.close();
    expect(clock.pending()).toBe(0);
  });
});
