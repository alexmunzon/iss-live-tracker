import { describe, expect, it, vi } from 'vitest';
import { trackerPolicy } from '../../../src/config/trackerPolicy';
import {
  clampTimerDelay,
  CLOCK_SUSPECT_STREAK,
  createPollingScheduler,
  MAX_TIMER_DELAY_MS,
  SERVER_WAIT_MAX_MS,
} from '../../../src/data/pollingMachine';
import type {
  FetchFailure,
  FetchOutcome,
  IssClient,
  PollingScheduler,
  PositionSample,
  RetryAfter,
} from '../../../src/domain/position';
import { sample } from '../../fixtures/canonical';
import { FakeEnv, flushMicrotasks } from './fakes';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** What one request does: settle after delayMs with outcome (or hang until aborted). */
interface Script {
  readonly delayMs: number;
  readonly outcome: ((env: FakeEnv) => FetchOutcome) | 'hang';
}

interface Call {
  readonly startedMono: number;
  readonly signal: AbortSignal;
  resolve: (outcome: FetchOutcome) => void;
  settled: boolean;
}

/** Sample whose provider time equals the current wall second (always newer than the last). */
function liveSample(env: FakeEnv, overrides: Partial<PositionSample> = {}): PositionSample {
  const t = Math.floor(env.wall / 1000) * 1000;
  return sample({ positionTimeMs: t, latitudeDeg: (t / 1000) % 80, ...overrides });
}

const ok =
  (overrides: Partial<PositionSample> = {}) =>
  (env: FakeEnv): FetchOutcome => ({ ok: true, sample: liveSample(env, overrides), issues: [] });

const failWith = (failure: FetchFailure) => (): FetchOutcome => ({ ok: false, failure });

const http = (
  status: number,
  retryAfter: RetryAfter | null = null,
  serverDateMs: number | null = null,
): FetchFailure => ({ kind: 'http', status, retryAfter, serverDateMs });

class FakeClient implements IssClient {
  readonly calls: Call[] = [];
  readonly script: Script[] = [];
  fallback: Script = { delayMs: 100, outcome: ok() };
  active = 0;
  maxActive = 0;

  constructor(private readonly env: FakeEnv) {}

  fetchPosition(signal: AbortSignal): Promise<FetchOutcome> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    return new Promise<FetchOutcome>((resolvePromise) => {
      let handle: unknown = null;
      const call: Call = {
        startedMono: this.env.mono,
        signal,
        settled: false,
        resolve: (outcome) => {
          if (call.settled) return;
          call.settled = true;
          this.active -= 1;
          if (handle !== null) this.env.timers.clear(handle);
          resolvePromise(outcome);
        },
      };
      this.calls.push(call);
      // Like the real client: an abort resolves promptly as 'aborted'.
      signal.addEventListener('abort', () =>
        call.resolve({ ok: false, failure: { kind: 'aborted' } }),
      );
      // Pick the step one microtask later so a test can script the request start() just issued.
      queueMicrotask(() => {
        if (call.settled) return;
        const step = this.script.shift() ?? this.fallback;
        const outcome = step.outcome;
        if (outcome === 'hang') return;
        handle = this.env.timers.set(() => call.resolve(outcome(this.env)), step.delayMs);
      });
    });
  }

  get starts(): number[] {
    return this.calls.map((c) => c.startedMono);
  }
}

interface Setup {
  env: FakeEnv;
  client: FakeClient;
  scheduler: PollingScheduler;
  r: { value: number };
}

function setup(
  options: { visible?: boolean; online?: boolean; random?: number; start?: boolean } = {},
): Setup {
  const env = new FakeEnv();
  const client = new FakeClient(env);
  const r = { value: options.random ?? 0 };
  const scheduler = createPollingScheduler({
    client,
    clock: env.clock,
    timers: env.timers,
    random: () => r.value,
    initialVisible: options.visible ?? true,
    initialOnline: options.online ?? true,
  });
  if (options.start ?? true) scheduler.start();
  return { env, client, scheduler, r };
}

function gaps(starts: number[]): number[] {
  return starts.slice(1).map((s, i) => s - (starts[i] ?? 0));
}

function codes(scheduler: PollingScheduler): string[] {
  return scheduler.getSnapshot().diagnostics.map((d) => d.code);
}

// ---------------------------------------------------------------------------
// Lifecycle and snapshot
// ---------------------------------------------------------------------------

describe('scheduler lifecycle', () => {
  it('idle before start; start is idempotent and issues one immediate request', async () => {
    const { scheduler, client } = setup({ start: false });
    expect(scheduler.getSnapshot().transport).toBe('idle');
    scheduler.start();
    scheduler.start();
    expect(client.calls).toHaveLength(1);
    expect(scheduler.getSnapshot()).toMatchObject({ transport: 'polling', requestInFlight: true });
  });

  it('start while hidden or offline makes no request', () => {
    expect(setup({ visible: false }).client.calls).toHaveLength(0);
    expect(setup({ online: false }).client.calls).toHaveLength(0);
    expect(setup({ online: false }).scheduler.getSnapshot().transport).toBe('offline');
  });

  it('getSnapshot is reference-stable until something changes', async () => {
    const { scheduler, env } = setup();
    const a = scheduler.getSnapshot();
    expect(scheduler.getSnapshot()).toBe(a);
    await env.advance(100); // settles
    const b = scheduler.getSnapshot();
    expect(b).not.toBe(a);
    expect(b.anchor).not.toBeNull();
    await env.advance(1_000); // nothing changes between settle and next start
    expect(scheduler.getSnapshot()).toBe(b);
    scheduler.retryNow(); // blocked by spacing: no-op, no new object
    expect(scheduler.getSnapshot()).toBe(b);
  });

  it('subscribe notifies synchronously; unsubscribe stops notifications', async () => {
    const { scheduler, env } = setup();
    let count = 0;
    const unsubscribe = scheduler.subscribe(() => {
      count += 1;
    });
    await env.advance(100);
    expect(count).toBeGreaterThan(0);
    const seen = count;
    unsubscribe();
    unsubscribe();
    await env.advance(10_000);
    expect(count).toBe(seen);
  });

  it('a throwing listener does not stop other listeners', async () => {
    const { scheduler, env } = setup();
    let other = 0;
    scheduler.subscribe(() => {
      throw new Error('boom');
    });
    scheduler.subscribe(() => {
      other += 1;
    });
    // The scheduler rethrows listener errors in a microtask; capture them instead of crashing.
    const errors: unknown[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
      void Promise.resolve().then(() => {
        try {
          callback();
        } catch (error) {
          errors.push(error);
        }
      });
    });
    await env.advance(100);
    expect(other).toBeGreaterThan(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(scheduler.getSnapshot().anchor).not.toBeNull();
  });

  it('dispose is idempotent, aborts the request and leaves zero pending timers', async () => {
    const { scheduler, env, client } = setup();
    await env.advance(100);
    expect(env.pendingCount).toBe(1); // next wake
    await env.advance(4_900);
    expect(client.active).toBe(1);
    let notified = 0;
    scheduler.subscribe(() => {
      notified += 1;
    });
    scheduler.dispose();
    scheduler.dispose();
    expect(client.calls[1]?.signal.aborted).toBe(true);
    expect(client.active).toBe(0);
    expect(env.pendingCount).toBe(0);
    const frozen = scheduler.getSnapshot();
    expect(frozen.requestInFlight).toBe(false);
    scheduler.start();
    scheduler.retryNow();
    scheduler.resume();
    scheduler.setVisible(false);
    scheduler.setVisible(true);
    scheduler.setOnlineHint(false);
    scheduler.setOnlineHint(true);
    await env.advance(600_000);
    expect(client.calls).toHaveLength(2);
    expect(scheduler.getSnapshot()).toBe(frozen);
    expect(notified).toBe(0);
    expect(env.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A04 ordering through the scheduler
// ---------------------------------------------------------------------------

describe('A04 scheduler ordering and late results', () => {
  it('A04 duplicate does not reanchor age but resets failures', async () => {
    const { scheduler, env, client } = setup();
    const first = sample({ positionTimeMs: Math.floor(env.wall / 1000) * 1000 });
    client.script.push(
      { delayMs: 100, outcome: () => ({ ok: true, sample: first, issues: [] }) },
      { delayMs: 100, outcome: failWith({ kind: 'network' }) },
      { delayMs: 100, outcome: () => ({ ok: true, sample: first, issues: [] }) },
    );
    await env.advance(100);
    const anchor = scheduler.getSnapshot().anchor;
    await env.advance(5_000); // network failure at 5.1 s
    expect(scheduler.getSnapshot().consecutiveFailures).toBe(1);
    await env.advance(10_100); // duplicate after the 10 s backoff from settlement
    const snap = scheduler.getSnapshot();
    expect(client.calls).toHaveLength(3);
    expect(snap.anchor).toBe(anchor);
    expect(snap.consecutiveFailures).toBe(0);
    expect(snap.lastFailure).toBeNull();
    expect(snap.trail.points).toHaveLength(1);
  });

  it('A04 conflict keeps the current sample and records a diagnostic', async () => {
    const { scheduler, env, client } = setup();
    const t = Math.floor(env.wall / 1000) * 1000;
    client.script.push(
      {
        delayMs: 100,
        outcome: () => ({ ok: true, sample: sample({ positionTimeMs: t }), issues: [] }),
      },
      {
        delayMs: 100,
        outcome: () => ({
          ok: true,
          sample: sample({ positionTimeMs: t, latitudeDeg: -1 }),
          issues: [],
        }),
      },
    );
    await env.advance(100);
    const anchor = scheduler.getSnapshot().anchor;
    await env.advance(5_000);
    expect(scheduler.getSnapshot().anchor).toBe(anchor);
    expect(codes(scheduler)).toContain('conflicting-sample');
  });

  it('A04 older sample is ignored', async () => {
    const { scheduler, env, client } = setup();
    const t = Math.floor(env.wall / 1000) * 1000;
    client.script.push(
      {
        delayMs: 100,
        outcome: () => ({ ok: true, sample: sample({ positionTimeMs: t }), issues: [] }),
      },
      {
        delayMs: 100,
        outcome: () => ({ ok: true, sample: sample({ positionTimeMs: t - 1000 }), issues: [] }),
      },
    );
    await env.advance(100);
    const anchor = scheduler.getSnapshot().anchor;
    await env.advance(5_000);
    expect(scheduler.getSnapshot().anchor).toBe(anchor);
    expect(codes(scheduler)).toContain('older-sample-ignored');
  });

  it.each(['pause', 'hide', 'offline'] as const)(
    'A04 result arriving after %s (generation change) is ignored',
    async (action) => {
      const { scheduler, client } = setup();
      client.script.push({ delayMs: 0, outcome: 'hang' });
      const call = client.calls[0];
      const before = scheduler.getSnapshot();
      if (action === 'pause') scheduler.pause();
      if (action === 'hide') scheduler.setVisible(false);
      if (action === 'offline') scheduler.setOnlineHint(false);
      const afterAction = scheduler.getSnapshot();
      expect(afterAction.requestInFlight).toBe(false);
      expect(before.anchor).toBeNull();
      // The aborted promise resolved as 'aborted' → late → ignored.
      await flushMicrotasks();
      expect(call?.signal.aborted).toBe(true);
      const snap = scheduler.getSnapshot();
      expect(snap.anchor).toBeNull();
      expect(snap.consecutiveFailures).toBe(0);
      expect(snap.lastFailure).toBeNull();
      expect(codes(scheduler)).toContain('late-result-ignored');
    },
  );

  it('A04 a late success after abort never changes anchor or transport', async () => {
    const env = new FakeEnv();
    let deliver: ((o: FetchOutcome) => void) | undefined;
    const client: IssClient = {
      fetchPosition: () =>
        new Promise<FetchOutcome>((resolve) => {
          deliver = resolve; // ignores the signal on purpose
        }),
    };
    const scheduler = createPollingScheduler({
      client,
      clock: env.clock,
      timers: env.timers,
      random: () => 0,
      initialVisible: true,
      initialOnline: true,
    });
    scheduler.start();
    scheduler.setVisible(false);
    deliver?.({ ok: true, sample: liveSample(env), issues: [] });
    await flushMicrotasks();
    const snap = scheduler.getSnapshot();
    expect(snap.anchor).toBeNull();
    expect(snap.transport).toBe('hidden');
    expect(codes(scheduler)).toEqual(['late-result-ignored']);
  });

  it('A04 a late result after dispose does nothing at all', async () => {
    const env = new FakeEnv();
    let deliver: ((o: FetchOutcome) => void) | undefined;
    const client: IssClient = {
      fetchPosition: () =>
        new Promise<FetchOutcome>((resolve) => {
          deliver = resolve;
        }),
    };
    const scheduler = createPollingScheduler({
      client,
      clock: env.clock,
      timers: env.timers,
      random: () => 0,
      initialVisible: true,
      initialOnline: true,
    });
    scheduler.start();
    scheduler.dispose();
    const frozen = scheduler.getSnapshot();
    deliver?.({ ok: true, sample: liveSample(env), issues: [] });
    await flushMicrotasks();
    expect(scheduler.getSnapshot()).toBe(frozen);
    expect(env.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A05 freshness inputs held by the scheduler
// ---------------------------------------------------------------------------

describe('A05 scheduler keeps the anchor through failures and pause', () => {
  it('A05 anchor is kept (age keeps advancing) during failures and while paused', async () => {
    const { scheduler, env, client } = setup();
    await env.advance(100);
    const anchor = scheduler.getSnapshot().anchor;
    client.fallback = { delayMs: 100, outcome: failWith({ kind: 'network' }) };
    await env.advance(60_000);
    expect(scheduler.getSnapshot().anchor).toBe(anchor);
    scheduler.pause();
    await env.advance(60_000);
    expect(scheduler.getSnapshot().anchor).toBe(anchor);
  });

  it('A05 future-skewed accept records future-skew-accepted', async () => {
    const { scheduler, env, client } = setup();
    client.script.push({ delayMs: 100, outcome: ok({ positionTimeMs: env.wall + 20_000 }) });
    await env.advance(100);
    expect(scheduler.getSnapshot().anchor?.futureSkew).toBe(true);
    expect(codes(scheduler)).toContain('future-skew-accepted');
  });

  it('A05 wall jump between checks sets clockSuspect; next accept clears it', async () => {
    const { scheduler, env } = setup();
    await env.advance(100);
    env.jumpWall(10_000);
    await env.advance(4_900); // wake at 5 s runs the clock check
    expect(scheduler.getSnapshot().clockSuspect).toBe(true);
    expect(scheduler.getSnapshot().diagnostics.some((d) => d.detail === 'wall-mono-mismatch')).toBe(
      true,
    );
    await env.advance(100); // the request it started is accepted
    expect(scheduler.getSnapshot().clockSuspect).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A06 cadence
// ---------------------------------------------------------------------------

describe('A06 cadence', () => {
  it('A06 fast responses: starts exactly 5 s apart, never two in flight', async () => {
    const { env, client } = setup();
    await env.advance(60_000);
    expect(client.maxActive).toBe(1);
    expect(gaps(client.starts).every((g) => g === 5_000)).toBe(true);
    expect(client.calls).toHaveLength(13);
  });

  it('A06 slow 7 s responses: next start at settlement, never two in flight', async () => {
    const { env, client } = setup();
    client.fallback = { delayMs: 7_000, outcome: ok() };
    await env.advance(70_000);
    expect(client.maxActive).toBe(1);
    expect(gaps(client.starts).every((g) => g === 7_000)).toBe(true);
  });

  it('A06 30 simulated minutes: expected request count, no bursts, ≥ 5 s spacing', async () => {
    for (const delayMs of [100, 7_000]) {
      const { env, client, scheduler } = setup();
      client.fallback = { delayMs, outcome: ok() };
      const minutes30 = 30 * 60_000;
      await env.advance(minutes30);
      const period = Math.max(5_000, delayMs);
      const expected = Math.floor(minutes30 / period) + 1;
      expect(Math.abs(client.calls.length - expected)).toBeLessThanOrEqual(1);
      expect(Math.min(...gaps(client.starts))).toBeGreaterThanOrEqual(5_000);
      expect(client.maxActive).toBe(1);
      expect(scheduler.getSnapshot().trail.points.length).toBeLessThanOrEqual(120);
      scheduler.dispose();
      expect(env.pendingCount).toBe(0);
    }
  });

  it('A06 hide/show flapping never bursts requests', async () => {
    const { env, client, scheduler } = setup();
    for (let i = 0; i < 50; i += 1) {
      scheduler.setVisible(false);
      scheduler.setVisible(true);
      await env.advance(200);
    }
    expect(Math.min(...gaps(client.starts))).toBeGreaterThanOrEqual(5_000);
    expect(client.calls.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// A07 failures
// ---------------------------------------------------------------------------

describe('A07 failure handling', () => {
  it.each<[string, FetchFailure]>([
    ['timeout', { kind: 'timeout' }],
    ['network', { kind: 'network' }],
    ['500', http(500)],
    ['503', http(503)],
    ['408', http(408)],
    ['invalid-json', { kind: 'invalid-json' }],
    ['body-too-large', { kind: 'body-too-large' }],
  ])('A07 %s → retry-wait with backoff 10 s, 20 s, 40 s, 60 s, 60 s', async (_label, failure) => {
    const { scheduler, env, client } = setup({ random: 0 });
    client.fallback = { delayMs: 0, outcome: failWith(failure) };
    await env.advance(0);
    expect(scheduler.getSnapshot()).toMatchObject({
      transport: 'retry-wait',
      consecutiveFailures: 1,
      lastFailure: failure,
      retryBlockedBy: 'backoff',
    });
    await env.advance(10_000 + 20_000 + 40_000 + 60_000 + 60_000);
    expect(gaps(client.starts)).toEqual([10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(codes(scheduler)).toContain('fetch-failed');
  });

  it('A07 timeout settled at 8 s backs off from settlement', async () => {
    const { env, client } = setup({ random: 0 });
    client.script.push({ delayMs: 8_000, outcome: failWith({ kind: 'timeout' }) });
    await env.advance(8_000 + 10_000);
    expect(client.starts).toEqual([1_000, 1_000 + 18_000]);
  });

  it.each([401, 403, 404, 400, 410])(
    'A07 HTTP %d → blocked with no automatic retry; manual retry allowed after spacing',
    async (status) => {
      const { scheduler, env, client } = setup();
      client.script.push({ delayMs: 100, outcome: failWith(http(status)) });
      await env.advance(100);
      expect(scheduler.getSnapshot()).toMatchObject({
        transport: 'blocked',
        retryBlockedBy: 'spacing',
      });
      await env.advance(3_600_000);
      expect(client.calls).toHaveLength(1);
      expect(scheduler.getSnapshot()).toMatchObject({
        transport: 'blocked',
        retryBlockedBy: null,
        nextEligibleMonoMs: null,
      });
      expect(env.pendingCount).toBe(0);
      scheduler.retryNow();
      expect(client.calls).toHaveLength(2);
      await env.advance(100);
      expect(scheduler.getSnapshot().transport).toBe('polling');
    },
  );
});

// ---------------------------------------------------------------------------
// A08 rate limiting and jitter
// ---------------------------------------------------------------------------

describe('A08 429 and jitter', () => {
  async function waitAfter429(
    failure: FetchFailure,
    prepare?: (s: Setup) => Promise<void>,
  ): Promise<{ wait: number; s: Setup }> {
    const s = setup({ random: 0 });
    if (prepare) await prepare(s);
    s.client.script.push({ delayMs: 0, outcome: failWith(failure) });
    if (prepare === undefined) {
      // first request is the 429
    }
    await s.env.advance(0);
    const settle = s.env.mono;
    await s.env.advance(SERVER_WAIT_MAX_MS + 1);
    const next = s.client.starts.find((t) => t > settle) ?? Number.NaN;
    return { wait: next - settle, s };
  }

  it('A08 429 without Retry-After waits at least 60 s', async () => {
    const { wait } = await waitAfter429(http(429));
    expect(wait).toBe(60_000);
  });

  it('A08 429 with seconds Retry-After 120 waits 120 s (not capped to 60 s)', async () => {
    const { wait, s } = await waitAfter429(http(429, { kind: 'seconds', seconds: 120 }));
    expect(wait).toBe(120_000);
    expect(s.scheduler.getSnapshot().lastFailure).toBeNull();
  });

  it('A08 429 with a short seconds Retry-After still respects our own backoff', async () => {
    const { wait } = await waitAfter429(http(429, { kind: 'seconds', seconds: 1 }));
    expect(wait).toBe(10_000);
  });

  it('A08 429 with HTTP-date uses the server Date as "now"', async () => {
    const serverNow = Date.UTC(2020, 0, 1, 0, 0, 0);
    const { wait } = await waitAfter429(
      http(429, { kind: 'date', epochMs: serverNow + 90_000 }, serverNow),
    );
    expect(wait).toBe(90_000);
  });

  it('A08 429 with HTTP-date and no server Date uses the local wall clock', async () => {
    const env = new FakeEnv();
    const { wait } = await waitAfter429(http(429, { kind: 'date', epochMs: env.wall + 75_000 }));
    expect(wait).toBe(75_000);
  });

  it('G1-v2 429 with a past HTTP-date → ordinary backoff only', async () => {
    const { wait } = await waitAfter429(http(429, { kind: 'date', epochMs: 0 }));
    expect(wait).toBe(10_000);
  });

  it('G1-v2 429 with a far-future HTTP-date is capped at 1 h', async () => {
    const env = new FakeEnv();
    const { wait, s } = await waitAfter429(
      http(429, { kind: 'date', epochMs: env.wall + 30 * 86_400_000 }),
    );
    expect(wait).toBe(SERVER_WAIT_MAX_MS);
    expect(s.env.requestedDelays.every((d) => d >= 0 && d <= MAX_TIMER_DELAY_MS)).toBe(true);
  });

  it('G1-v2 429 seconds above the cap (from a non-parser source) is capped at 1 h', async () => {
    const { wait } = await waitAfter429(http(429, { kind: 'seconds', seconds: 1e9 }));
    expect(wait).toBe(SERVER_WAIT_MAX_MS);
  });

  it('A08 429 date form with clockSuspect and no server Date → time-unverified, no auto retry', async () => {
    const s = setup({ random: 0 });
    await s.env.advance(100); // accept
    s.env.jumpWall(60_000); // wall jumps; detected at the next wake
    s.client.script.push({
      delayMs: 0,
      outcome: failWith(http(429, { kind: 'date', epochMs: s.env.wall + 120_000 })),
    });
    await s.env.advance(4_900);
    const snap = s.scheduler.getSnapshot();
    expect(snap.clockSuspect).toBe(true);
    expect(snap.retryBlockedBy).toBe('time-unverified');
    expect(snap.transport).toBe('retry-wait');
    const callsBefore = s.client.calls.length;
    s.scheduler.retryNow();
    expect(s.client.calls).toHaveLength(callsBefore);
    await s.env.advance(SERVER_WAIT_MAX_MS);
    expect(s.client.calls).toHaveLength(callsBefore); // automatic retry stays paused
    expect(s.scheduler.getSnapshot().retryBlockedBy).toBeNull();
    s.scheduler.retryNow(); // manual probe after the 60 s minimum
    expect(s.client.calls).toHaveLength(callsBefore + 1);
  });

  it('R2 time-unverified hold stays exposed after the deadline; manual-only, never automatic', async () => {
    const s = setup({ random: 0 });
    await s.env.advance(100); // good sample accepted
    s.env.jumpWall(60_000); // wall jumps; detected at the next wake → clockSuspect
    s.client.script.push({
      delayMs: 0,
      outcome: failWith(http(429, { kind: 'date', epochMs: s.env.wall + 120_000 })),
    });
    await s.env.advance(4_900); // second request → 429, date form, no server Date
    expect(s.client.calls).toHaveLength(2);

    // Before the deadline: hold exposed, Retry blocked with a countdown target.
    const before = s.scheduler.getSnapshot();
    expect(before.clockSuspect).toBe(true);
    expect(before.automaticHold).toBe('time-unverified');
    expect(before.retryBlockedBy).toBe('time-unverified');
    const deadline = before.nextEligibleMonoMs;
    expect(deadline).not.toBeNull();
    await s.env.advance((deadline ?? 0) - s.env.mono - 1);
    expect(s.scheduler.getSnapshot()).toMatchObject({
      automaticHold: 'time-unverified',
      retryBlockedBy: 'time-unverified',
    });

    // At the deadline: Retry allowed, hold still exposed, nothing scheduled.
    await s.env.advance(1);
    expect(s.scheduler.getSnapshot()).toMatchObject({
      transport: 'retry-wait',
      automaticHold: 'time-unverified',
      retryBlockedBy: null,
      nextEligibleMonoMs: null,
    });
    expect(s.client.calls).toHaveLength(2);
    expect(s.env.pendingCount).toBe(0);

    // After the deadline and one simulated hour later: still no automatic request.
    await s.env.advance(1_000);
    expect(s.scheduler.getSnapshot().automaticHold).toBe('time-unverified');
    await s.env.advance(3_600_000);
    expect(s.client.calls).toHaveLength(2);
    expect(s.env.pendingCount).toBe(0);
    expect(s.scheduler.getSnapshot()).toMatchObject({
      automaticHold: 'time-unverified',
      retryBlockedBy: null,
    });

    // Hide/show, pause/resume and offline/online neither clear the hold nor start a request.
    s.scheduler.setVisible(false);
    expect(s.scheduler.getSnapshot()).toMatchObject({
      transport: 'hidden',
      automaticHold: 'time-unverified',
    });
    s.scheduler.setVisible(true);
    await s.env.advance(10_000);
    s.scheduler.pause();
    expect(s.scheduler.getSnapshot()).toMatchObject({
      transport: 'paused',
      automaticHold: 'time-unverified',
    });
    s.scheduler.resume();
    await s.env.advance(10_000);
    s.scheduler.setOnlineHint(false);
    s.scheduler.setOnlineHint(true);
    await s.env.advance(10_000);
    expect(s.client.calls).toHaveLength(2);
    expect(s.env.pendingCount).toBe(0);
    expect(s.scheduler.getSnapshot()).toMatchObject({
      transport: 'retry-wait',
      automaticHold: 'time-unverified',
      retryBlockedBy: null,
    });

    // Exactly one manual Retry starts one request and clears the hold.
    s.scheduler.retryNow();
    s.scheduler.retryNow(); // second press is blocked by the in-flight request
    expect(s.client.calls).toHaveLength(3);
    expect(s.scheduler.getSnapshot().automaticHold).toBeNull();
    await s.env.advance(100); // fallback: ok
    expect(s.scheduler.getSnapshot()).toMatchObject({
      transport: 'polling',
      automaticHold: null,
      lastFailure: null,
    });
    // Normal polling resumes.
    await s.env.advance(4_900);
    expect(s.client.calls).toHaveLength(4);
    await s.env.advance(10_000);
    expect(s.client.calls).toHaveLength(6);
  });

  it('A08 server deadline survives pause, hide and offline', async () => {
    const s = setup({ random: 0 });
    s.client.script.push({
      delayMs: 0,
      outcome: failWith(http(429, { kind: 'seconds', seconds: 120 })),
    });
    await s.env.advance(0);
    s.scheduler.pause();
    s.scheduler.resume();
    s.scheduler.setVisible(false);
    s.scheduler.setVisible(true);
    s.scheduler.setOnlineHint(false);
    s.scheduler.setOnlineHint(true);
    await s.env.advance(119_999);
    expect(s.client.calls).toHaveLength(1);
    expect(s.scheduler.getSnapshot().retryBlockedBy).toBe('server-wait');
    await s.env.advance(1);
    expect(s.client.calls).toHaveLength(2);
  });

  it.each([
    [0, [10_000, 20_000, 40_000, 60_000]],
    [0.999999, [11_999.998, 23_999.996, 47_999.992, 60_000]],
    [1, [12_000, 24_000, 48_000, 60_000]],
  ])('A08 jitter with r = %d', async (r, expected) => {
    const { env, client } = setup({ random: r });
    client.fallback = { delayMs: 0, outcome: failWith({ kind: 'network' }) };
    await env.advance(0);
    await env.advance(200_000);
    const observed = gaps(client.starts).slice(0, 4);
    observed.forEach((g, i) => expect(g).toBeCloseTo(Math.ceil(expected[i] ?? 0), -1));
    expect(observed.every((g, i) => g >= (expected[i] ?? 0))).toBe(true);
    expect(Math.max(...gaps(client.starts))).toBeLessThanOrEqual(60_000);
  });

  it('A08 hostile random values (NaN, negative, >1) never exceed the retry cap', async () => {
    for (const value of [Number.NaN, -5, 50]) {
      const { env, client } = setup({ random: value });
      client.fallback = { delayMs: 0, outcome: failWith({ kind: 'network' }) };
      await env.advance(300_000);
      const g = gaps(client.starts);
      expect(Math.min(...g)).toBeGreaterThanOrEqual(10_000);
      expect(Math.max(...g)).toBeLessThanOrEqual(60_000);
    }
  });
});

// ---------------------------------------------------------------------------
// A09 manual retry and lifecycle events
// ---------------------------------------------------------------------------

describe('A09 retryNow and lifecycle events', () => {
  it('A09 rapid retryNow calls produce at most one request', async () => {
    const { scheduler, env, client } = setup();
    client.script.push({ delayMs: 0, outcome: failWith(http(404)) });
    await env.advance(5_000);
    for (let i = 0; i < 20; i += 1) scheduler.retryNow();
    expect(client.calls).toHaveLength(2);
    expect(scheduler.getSnapshot().retryBlockedBy).toBe('in-flight');
  });

  it('A09 retryNow respects spacing, backoff and server deadlines', async () => {
    const { scheduler, env, client } = setup({ random: 0 });
    // spacing
    await env.advance(100);
    scheduler.retryNow();
    expect(client.calls).toHaveLength(1);
    expect(scheduler.getSnapshot().retryBlockedBy).toBe('spacing');
    // backoff
    client.script.push({ delayMs: 0, outcome: failWith({ kind: 'network' }) });
    await env.advance(4_900);
    scheduler.retryNow();
    expect(client.calls).toHaveLength(2);
    expect(scheduler.getSnapshot().retryBlockedBy).toBe('backoff');
    // server wait
    client.script.push({ delayMs: 0, outcome: failWith(http(429)) });
    await env.advance(10_000);
    expect(client.calls).toHaveLength(3);
    await env.advance(30_000);
    scheduler.retryNow();
    expect(client.calls).toHaveLength(3);
    expect(scheduler.getSnapshot().retryBlockedBy).toBe('server-wait');
  });

  it('A09 pause persists across setVisible and setOnlineHint', async () => {
    const { scheduler, env, client } = setup();
    await env.advance(100);
    scheduler.pause();
    scheduler.setVisible(false);
    scheduler.setVisible(true);
    scheduler.setOnlineHint(false);
    scheduler.setOnlineHint(true);
    await env.advance(120_000);
    expect(client.calls).toHaveLength(1);
    expect(scheduler.getSnapshot()).toMatchObject({
      transport: 'paused',
      retryBlockedBy: 'paused',
    });
    scheduler.retryNow();
    expect(client.calls).toHaveLength(1);
    expect(env.pendingCount).toBe(0);
    scheduler.resume();
    expect(client.calls).toHaveLength(2);
  });

  it('A09 hidden aborts the request and does not count as a failure', async () => {
    const { scheduler, env, client } = setup();
    scheduler.setVisible(false);
    expect(client.calls[0]?.signal.aborted).toBe(true);
    await flushMicrotasks();
    expect(scheduler.getSnapshot()).toMatchObject({
      transport: 'hidden',
      consecutiveFailures: 0,
      lastFailure: null,
      requestInFlight: false,
      retryBlockedBy: 'hidden',
    });
    expect(env.pendingCount).toBe(0);
    await env.advance(600_000);
    expect(client.calls).toHaveLength(1);
  });

  it('A09 becoming visible issues at most one request, no catch-up of missed intervals', async () => {
    const { scheduler, env, client } = setup();
    await env.advance(100);
    scheduler.setVisible(false);
    await env.advance(600_000);
    scheduler.setVisible(true);
    expect(client.calls).toHaveLength(2);
    await env.advance(4_999);
    expect(client.calls).toHaveLength(2);
    await env.advance(1);
    expect(client.calls).toHaveLength(3);
  });

  it('A09 becoming visible before spacing waits for the deadline instead of requesting', async () => {
    const { scheduler, env, client } = setup();
    await env.advance(1_000);
    scheduler.setVisible(false);
    scheduler.setVisible(true);
    expect(client.calls).toHaveLength(1);
    await env.advance(4_000);
    expect(client.calls).toHaveLength(2);
  });

  it('A09 online after offline issues at most one request', async () => {
    const { scheduler, env, client } = setup();
    await env.advance(100);
    scheduler.setOnlineHint(false);
    expect(scheduler.getSnapshot().transport).toBe('offline');
    await env.advance(300_000);
    expect(client.calls).toHaveLength(1);
    scheduler.setOnlineHint(true);
    scheduler.setOnlineHint(true);
    expect(client.calls).toHaveLength(2);
  });

  it('A09 offline still allows an eligible manual probe (but not before spacing)', async () => {
    const { scheduler, env, client } = setup({ online: false });
    expect(client.calls).toHaveLength(0);
    scheduler.retryNow();
    expect(client.calls).toHaveLength(1);
    await env.advance(100);
    scheduler.retryNow();
    expect(client.calls).toHaveLength(1);
    expect(scheduler.getSnapshot().retryBlockedBy).toBe('spacing');
    await env.advance(4_900);
    expect(scheduler.getSnapshot().retryBlockedBy).toBeNull();
    expect(client.calls).toHaveLength(1); // no automatic attempts while offline
    scheduler.retryNow();
    expect(client.calls).toHaveLength(2);
  });

  it('A09 nextEligibleMonoMs matches the scheduled start', async () => {
    const { scheduler, env } = setup({ random: 0 });
    await env.advance(100);
    expect(scheduler.getSnapshot().nextEligibleMonoMs).toBe(1_000 + 5_000);
  });
});

// ---------------------------------------------------------------------------
// G1-v2 hardening
// ---------------------------------------------------------------------------

describe('G1-v2 timers and clocks', () => {
  it('G1-v2 an early timer fire re-arms instead of fetching', async () => {
    const { env, client } = setup();
    await env.advance(100);
    expect(env.pendingCount).toBe(1);
    await env.fireEarliestEarly();
    expect(client.calls).toHaveLength(1);
    expect(env.pendingCount).toBe(1);
    expect(env.nextTimer()?.at).toBe(6_000);
    await env.advance(4_900);
    expect(client.calls).toHaveLength(2);
  });

  it('G1-v2 delays above 2^31 − 1 are clamped', () => {
    expect(clampTimerDelay(2 ** 31 + 10)).toBe(MAX_TIMER_DELAY_MS);
    expect(clampTimerDelay(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_DELAY_MS);
    expect(clampTimerDelay(-50)).toBe(0);
    expect(clampTimerDelay(Number.NaN)).toBe(0);
    expect(clampTimerDelay(10.2)).toBe(11);
  });

  it('G1-v2 every delay the scheduler requests is within [0, 2^31 − 1]', async () => {
    const { env, client } = setup({ random: 0.5 });
    client.script.push(
      { delayMs: 0, outcome: failWith(http(429, { kind: 'seconds', seconds: 86_400 })) },
      { delayMs: 0, outcome: failWith({ kind: 'network' }) },
    );
    await env.advance(2 * SERVER_WAIT_MAX_MS);
    expect(env.requestedDelays.length).toBeGreaterThan(0);
    expect(env.requestedDelays.every((d) => d >= 0 && d <= MAX_TIMER_DELAY_MS)).toBe(true);
  });

  it('G1-v2 three consecutive too-far-future results mark the clock suspect', async () => {
    const { scheduler, env, client } = setup({ random: 0 });
    client.fallback = { delayMs: 0, outcome: (e) => ok({ positionTimeMs: e.wall + 3_600_000 })(e) };
    await env.advance(0);
    await env.advance(10_000 + 20_000);
    const snap = scheduler.getSnapshot();
    expect(client.calls).toHaveLength(CLOCK_SUSPECT_STREAK);
    expect(snap.consecutiveFailures).toBe(3);
    expect(snap.clockSuspect).toBe(true);
    expect(snap.lastFailure).toEqual({
      kind: 'invalid-payload',
      rejection: 'timestamp-implausible',
    });
    expect(snap.transport).toBe('retry-wait');
    expect(snap.anchor).toBeNull();
    expect(codes(scheduler).filter((c) => c === 'future-sample-rejected')).toHaveLength(3);
    expect(snap.diagnostics.filter((d) => d.detail === 'future-streak')).toHaveLength(1);
  });

  it('G1-v2 two too-far-future results do not mark the clock suspect', async () => {
    const { scheduler, env, client } = setup({ random: 0 });
    client.script.push(
      { delayMs: 0, outcome: (e) => ok({ positionTimeMs: e.wall + 3_600_000 })(e) },
      { delayMs: 0, outcome: (e) => ok({ positionTimeMs: e.wall + 3_600_000 })(e) },
    );
    await env.advance(10_000);
    expect(scheduler.getSnapshot().clockSuspect).toBe(false);
  });

  it('G1-v2 three self-consistent older results re-anchor to the newest', async () => {
    const { scheduler, env, client } = setup();
    const base = Math.floor(env.wall / 1000) * 1000;
    // First accepted sample is 29 s in the future (within skew), then reality resumes.
    client.fallback = { delayMs: 0, outcome: ok() };
    client.script.push({ delayMs: 0, outcome: ok({ positionTimeMs: base + 29_000 }) });
    await env.advance(0);
    const bad = scheduler.getSnapshot().anchor;
    expect(bad?.futureSkew).toBe(true);
    await env.advance(5_000); // older #1
    await env.advance(5_000); // older #2
    expect(scheduler.getSnapshot().anchor).toBe(bad);
    await env.advance(5_000); // older #3 → re-anchor
    const snap = scheduler.getSnapshot();
    expect(snap.anchor).not.toBe(bad);
    expect(snap.anchor?.sample.positionTimeMs).toBe(base + 15_000);
    expect(snap.trail.points).toEqual([expect.objectContaining({ positionTimeMs: base + 15_000 })]);
    expect(snap.diagnostics.some((d) => d.detail === 'reanchored-older-streak')).toBe(true);
  });

  it('G1-v2 older results that are not increasing do not re-anchor', async () => {
    const { scheduler, env, client } = setup();
    const base = Math.floor(env.wall / 1000) * 1000;
    const fixedOlder = (): FetchOutcome => ({
      ok: true,
      sample: sample({ positionTimeMs: base }),
      issues: [],
    });
    client.script.push(
      { delayMs: 0, outcome: ok({ positionTimeMs: base + 29_000 }) },
      { delayMs: 0, outcome: fixedOlder },
      { delayMs: 0, outcome: fixedOlder },
      { delayMs: 0, outcome: fixedOlder },
    );
    await env.advance(0);
    const bad = scheduler.getSnapshot().anchor;
    await env.advance(15_000);
    expect(scheduler.getSnapshot().anchor).toBe(bad);
  });

  it('G1-v2 diagnostic details are short fixed codes', async () => {
    const { scheduler, env, client } = setup({ random: 0 });
    client.script.push(
      { delayMs: 0, outcome: failWith(http(503)) },
      { delayMs: 0, outcome: failWith({ kind: 'invalid-payload', rejection: 'wrong-identity' }) },
      {
        delayMs: 0,
        outcome: (e) => ({
          ok: true,
          sample: liveSample(e),
          issues: ['altitude-invalid', 'velocity-invalid'],
        }),
      },
    );
    await env.advance(60_000);
    const details = scheduler
      .getSnapshot()
      .diagnostics.flatMap((d) => (d.detail ? [d.detail] : []));
    expect(details).toEqual(
      expect.arrayContaining(['http-503', 'invalid-payload', 'altitude-invalid,velocity-invalid']),
    );
    expect(details.every((d) => d.length <= 40 && /^[a-z0-9,-]+$/.test(d))).toBe(true);
  });

  it('diagnostics ring is bounded', async () => {
    const { scheduler, env, client } = setup();
    client.fallback = { delayMs: 0, outcome: failWith({ kind: 'network' }) };
    await env.advance(3_600_000);
    expect(scheduler.getSnapshot().diagnostics.length).toBeLessThanOrEqual(
      trackerPolicy.diagnosticsLimit,
    );
  });
});
