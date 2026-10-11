// Deterministic clock + timers for data/domain tests. Not a test file itself.

import type { Clock, TimerApi, TimerHandle } from '../../../src/domain/position';
import { T0_MS } from '../../fixtures/canonical';

interface PendingTimer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
  readonly requestedDelayMs: number;
}

export async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

export class FakeEnv {
  mono = 1_000;
  wall = T0_MS;
  private nextId = 1;
  private readonly pending = new Map<number, PendingTimer>();
  /** Every delay passed to timers.set, in call order (for clamp assertions). */
  readonly requestedDelays: number[] = [];

  readonly clock: Clock = {
    wallNowMs: () => this.wall,
    monotonicNowMs: () => this.mono,
  };

  readonly timers: TimerApi = {
    set: (callback: () => void, delayMs: number): TimerHandle => {
      const id = this.nextId;
      this.nextId += 1;
      this.requestedDelays.push(delayMs);
      this.pending.set(id, { id, at: this.mono + delayMs, callback, requestedDelayMs: delayMs });
      return id;
    },
    clear: (handle: TimerHandle): void => {
      if (typeof handle === 'number') this.pending.delete(handle);
    },
  };

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Earliest pending timer, if any. */
  nextTimer(): PendingTimer | undefined {
    let best: PendingTimer | undefined;
    for (const timer of this.pending.values()) {
      if (
        best === undefined ||
        timer.at < best.at ||
        (timer.at === best.at && timer.id < best.id)
      ) {
        best = timer;
      }
    }
    return best;
  }

  /** Advance both clocks together, firing due timers in order and flushing promises. */
  async advance(ms: number): Promise<void> {
    const target = this.mono + ms;
    await flushMicrotasks();
    for (;;) {
      const timer = this.nextTimer();
      if (timer === undefined || timer.at > target) break;
      this.wall += timer.at - this.mono;
      this.mono = timer.at;
      this.pending.delete(timer.id);
      timer.callback();
      await flushMicrotasks();
    }
    this.wall += target - this.mono;
    this.mono = target;
    await flushMicrotasks();
  }

  /** Fire the earliest timer now, before its due time (simulates an early fire). */
  async fireEarliestEarly(): Promise<void> {
    const timer = this.nextTimer();
    if (timer === undefined) throw new Error('no pending timer');
    this.pending.delete(timer.id);
    timer.callback();
    await flushMicrotasks();
  }

  /** Jump only the wall clock (NTP correction, manual change). */
  jumpWall(deltaMs: number): void {
    this.wall += deltaMs;
  }
}
