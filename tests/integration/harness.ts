// QA integration harness (contract G1-v2).
// Deterministic virtual time: vitest fake timers drive Date and the injected
// TimerApi; the injected Clock derives wall and monotonic time from the fake
// Date, with an optional wall offset to simulate wall-clock jumps.

import { vi } from 'vitest';
import type { Clock, FetchLike, TimerApi } from '../../src/domain/position';
import { T0_MS } from '../fixtures/canonical/index';
import type { ResponseCase } from '../fixtures/adversarial/payloads';

/** Monotonic origin. Deliberately non-zero so a "0 means unset" bug shows up. */
export const MONO_BASE = 500_000;

/** Real (never faked) macrotask yield. setImmediate is not in the DOM lib types. */
const realSetImmediate = (globalThis as unknown as { setImmediate: (cb: () => void) => unknown })
  .setImmediate;
export const macrotask = (): Promise<void> =>
  new Promise<void>((resolve) => {
    realSetImmediate(resolve);
  });

export const FAKED = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'Date',
] as const;

export interface VirtualEnv {
  readonly clock: Clock;
  readonly timers: TimerApi;
  /** Milliseconds of virtual monotonic time since the test started. */
  t(): number;
  /** Shift the wall clock only (monotonic unaffected). */
  jumpWall(deltaMs: number): void;
  /** Advance virtual time, running due timers and settling promises between them. */
  advance(ms: number): Promise<void>;
  /** Settle pending promises without moving time. */
  flush(): Promise<void>;
}

export function installVirtualTime(): VirtualEnv {
  vi.useFakeTimers({ now: T0_MS, toFake: [...FAKED] });
  let wallOffset = 0;
  const clock: Clock = {
    wallNowMs: () => Date.now() + wallOffset,
    monotonicNowMs: () => Date.now() - T0_MS + MONO_BASE,
  };
  const timers: TimerApi = {
    set: (cb, delayMs) => setTimeout(cb, delayMs),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) {
      await macrotask();
    }
  };
  return {
    clock,
    timers,
    t: () => Date.now() - T0_MS,
    jumpWall: (deltaMs) => {
      wallOffset += deltaMs;
    },
    flush,
    advance: async (ms) => {
      await flush();
      await vi.advanceTimersByTimeAsync(ms);
      await flush();
    },
  };
}

export function uninstallVirtualTime(): void {
  vi.clearAllTimers();
  vi.useRealTimers();
}

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

export type Reply =
  | {
      readonly kind: 'respond';
      readonly status?: number;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body: string | Uint8Array | null;
      readonly redirected?: boolean;
      readonly opaqueRedirect?: boolean;
      /** Resolve after this many virtual ms (fake setTimeout). Abort cancels it. */
      readonly delayMs?: number;
      /** Resolve even if the signal aborts (simulates a late result). */
      readonly ignoreAbort?: boolean;
    }
  | { readonly kind: 'network' }
  /** Never resolves until aborted. */
  | { readonly kind: 'hang' };

export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
  /** Virtual ms since test start when fetch was called. */
  readonly at: number;
  aborted: boolean;
  settled: boolean;
}

export interface FakeFetch {
  readonly fetch: FetchLike;
  readonly calls: FetchCall[];
  /** Queue replies used in order; when empty, `fallback` is used. */
  queue(...replies: Reply[]): void;
  setFallback(make: (call: FetchCall) => Reply): void;
  /** Calls whose promise has not settled and were not aborted. */
  activeCount(): number;
  maxConcurrentActive(): number;
}

export function json(
  body: string,
  extra: Partial<Extract<Reply, { kind: 'respond' }>> = {},
): Reply {
  return {
    kind: 'respond',
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body,
    ...extra,
  };
}

export function fromCase(c: ResponseCase): Reply {
  return {
    kind: 'respond',
    status: c.status,
    headers: c.headers,
    body: c.body,
    ...(c.redirected === undefined ? {} : { redirected: c.redirected }),
    ...(c.opaqueRedirect === undefined ? {} : { opaqueRedirect: c.opaqueRedirect }),
  };
}

export function buildResponse(reply: Extract<Reply, { kind: 'respond' }>): Response {
  const body =
    reply.body === null
      ? null
      : reply.body instanceof Uint8Array
        ? new Blob([new Uint8Array(reply.body)])
        : reply.body;
  const response = new Response(body, {
    status: reply.status ?? 200,
    headers: reply.headers ?? {},
  });
  if (reply.redirected) Object.defineProperty(response, 'redirected', { value: true });
  if (reply.opaqueRedirect) Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
  return response;
}

export function createFakeFetch(
  env: Pick<VirtualEnv, 't'>,
  fallback?: (call: FetchCall) => Reply,
): FakeFetch {
  const calls: FetchCall[] = [];
  const queued: Reply[] = [];
  let makeFallback: (call: FetchCall) => Reply = fallback ?? (() => ({ kind: 'network' }));
  let maxActive = 0;
  const activeCount = () => calls.filter((c) => !c.settled && !c.aborted).length;

  const fetch: FetchLike = (input, init) => {
    const call: FetchCall = { url: input, init, at: env.t(), aborted: false, settled: false };
    calls.push(call);
    maxActive = Math.max(maxActive, activeCount());
    const reply = queued.shift() ?? makeFallback(call);
    const signal = init.signal ?? undefined;

    return new Promise<Response>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (fn: () => void) => {
        call.settled = true;
        fn();
      };
      const onAbort = () => {
        call.aborted = true;
        if (reply.kind === 'respond' && reply.ignoreAbort) return;
        if (timer !== undefined) clearTimeout(timer);
        finish(() => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      if (reply.kind === 'network') {
        finish(() => reject(new TypeError('Failed to fetch')));
        return;
      }
      if (reply.kind === 'hang') return;
      const deliver = () => {
        if (call.settled) return;
        signal?.removeEventListener('abort', onAbort);
        finish(() => resolve(buildResponse(reply)));
      };
      if (reply.delayMs !== undefined && reply.delayMs > 0) {
        timer = setTimeout(deliver, reply.delayMs);
      } else {
        deliver();
      }
    });
  };

  return {
    fetch,
    calls,
    queue: (...replies) => {
      queued.push(...replies);
    },
    setFallback: (make) => {
      makeFallback = make;
    },
    activeCount,
    maxConcurrentActive: () => maxActive,
  };
}

/** Deterministic random source returning a fixed value. */
export const fixedRandom =
  (r: number): (() => number) =>
  () =>
    r;
