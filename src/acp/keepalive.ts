/** Idle prefix-cache keepalive: after a turn ends, ping the model on a timer to
 *  renew the DeepSeek prompt cache (up to maxPings times). Clock + ping injected. */

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
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
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
      void this.ping()
        .catch(() => undefined)
        .finally(() => this.arm());
    }, this.intervalMs);
  }

  private cancel(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
