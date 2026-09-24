// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Syed Arman

export interface WorkflowClock {
  /** Epoch milliseconds in real mode; configured start plus elapsed time in virtual mode. */
  now(): number;
  /** Awaitable delay; virtual sleeps advance simulated time without waiting in real time. */
  sleep(ms: number): Promise<void>;
}
type Fault = 'timed_out' | 'clock_limit' | 'clock_contract';
type Sleeper = {
  due: number;
  resolve(): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
};

/** Per-trial scheduler. Only the frozen API is exposed to agents and tools. */
export class TrialClock {
  readonly api: WorkflowClock;
  private elapsed = 0;
  private sleeps = 0;
  private holds = 0;
  private closed = false;
  private waiters = new Set<Sleeper>();
  private pump?: ReturnType<typeof setImmediate>;
  private readonly abort: () => void;

  constructor(
    private readonly config:
      { mode: 'virtual'; startMs: number; maxTimeMs: number } | undefined,
    private readonly signal: AbortSignal,
    private readonly onFault: (reason: Fault) => void,
  ) {
    this.api = Object.freeze({
      now: () => this.now(),
      sleep: (ms: number) => this.sleep(ms),
    });
    this.abort = () => this.close();
    signal.addEventListener('abort', this.abort, { once: true });
  }
  get pending() {
    return this.waiters.size;
  }
  /** Let a ready runner transaction start before advancing to a later timer. */
  hold() {
    this.holds++;
    return () => {
      this.holds--;
    };
  }
  get snapshot() {
    return this.config ? { ...this.config, endMs: this.now() } : undefined;
  }
  private now() {
    return this.config ? this.config.startMs + this.elapsed : Date.now();
  }
  private sleep(ms: number): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      if (this.closed || this.signal.aborted) {
        reject(new Error('Trial clock is closed.'));
        return;
      }
      if (!Number.isSafeInteger(ms) || ms < 0 || ms > 86400000) {
        this.fail('clock_contract');
        reject(new Error('Delay must be an integer from 0 to 86400000.'));
        return;
      }
      if (++this.sleeps > 1000) {
        this.fail('clock_limit');
        reject(new Error('Trial sleep limit exceeded.'));
        return;
      }
      const waiter: Sleeper = { due: this.elapsed + ms, resolve, reject };
      this.waiters.add(waiter);
      if (this.config) this.schedule();
      else
        waiter.timer = setTimeout(() => {
          this.waiters.delete(waiter);
          resolve();
        }, ms);
    });
    // Abandoned work must not create process-level unhandled rejections on shutdown.
    void promise.catch(() => undefined);
    return promise;
  }
  private fail(reason: Fault) {
    this.onFault(reason);
    this.close();
  }
  private schedule() {
    if (this.pump || this.closed || !this.waiters.size) return;
    this.pump = setImmediate(() => {
      this.pump = undefined;
      if (this.closed) return;
      if (this.holds) {
        this.schedule();
        return;
      }
      const due = Math.min(...[...this.waiters].map((w) => w.due));
      if (due > this.config!.maxTimeMs) {
        this.elapsed = this.config!.maxTimeMs;
        this.fail('timed_out');
        return;
      }
      this.elapsed = due;
      for (const waiter of this.waiters)
        if (waiter.due === due) {
          this.waiters.delete(waiter);
          waiter.resolve();
        }
      // Yield so resumed code can register its next timer before time moves again.
      this.schedule();
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener('abort', this.abort);
    if (this.pump) clearImmediate(this.pump);
    for (const waiter of this.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error('Trial clock is closed.'));
    }
    this.waiters.clear();
  }
}
