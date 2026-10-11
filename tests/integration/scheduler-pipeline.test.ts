// Integration: pollingMachine + issClient + validatePosition + freshness + trail,
// driven by a fake fetch and virtual time. Contract G1-v2.
//
// All expected times/values are literal, derived by hand from docs/contracts.md
// §3–§5, trackerPolicy and the G1-v2 amendment. computeFreshness is called only
// to read the state of the pipeline; its expected outputs are literals.
// "t" = virtual ms since the test started (monotonic = MONO_BASE + t).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIssClient } from '../../src/data/issClient';
import { createPollingScheduler } from '../../src/data/pollingMachine';
import { computeFreshness } from '../../src/domain/freshness';
import type { PollingScheduler, TimerApi, TrackerSnapshot } from '../../src/domain/position';
import { T0_MS } from '../fixtures/canonical/index';
import { payloadAt } from '../fixtures/adversarial/payloads';
import {
  createFakeFetch,
  fixedRandom,
  installVirtualTime,
  json,
  MONO_BASE,
  uninstallVirtualTime,
  type FakeFetch,
  type Reply,
  type VirtualEnv,
} from './harness';

let env: VirtualEnv;
let fake: FakeFetch;
let scheduler: PollingScheduler | undefined;

/** Provider calculates the position at true time (unaffected by local wall jumps). */
const fresh = (lat?: number, lon?: number): Reply => json(payloadAt(Date.now(), lat, lon));
const at = (offsetMs: number, lat?: number, lon?: number): Reply =>
  json(payloadAt(T0_MS + offsetMs, lat, lon));
const status = (code: number, headers: Record<string, string> = {}): Reply => ({
  kind: 'respond',
  status: code,
  headers,
  body: '',
});

interface SetupOptions {
  r?: number;
  visible?: boolean;
  online?: boolean;
  schedulerTimers?: TimerApi;
}

function setup(opts: SetupOptions = {}): PollingScheduler {
  const client = createIssClient({ fetch: fake.fetch, clock: env.clock, timers: env.timers });
  const created = createPollingScheduler({
    client,
    clock: env.clock,
    timers: opts.schedulerTimers ?? env.timers,
    random: fixedRandom(opts.r ?? 0),
    initialVisible: opts.visible ?? true,
    initialOnline: opts.online ?? true,
  });
  scheduler = created;
  return created;
}

async function startAndSettle(s: PollingScheduler): Promise<TrackerSnapshot> {
  s.start();
  await env.flush();
  return s.getSnapshot();
}

const starts = () => fake.calls.map((c) => c.at);
const snap = () => {
  if (!scheduler) throw new Error('setup() not called');
  return scheduler.getSnapshot();
};
const freshnessNow = () => computeFreshness(snap().anchor, env.clock);
const codes = () => snap().diagnostics.map((d) => d.code);

beforeEach(() => {
  env = installVirtualTime();
  fake = createFakeFetch(env, () => fresh());
});

afterEach(() => {
  scheduler?.dispose();
  scheduler = undefined;
  uninstallVirtualTime();
});

// ---------------------------------------------------------------------------
describe('A06 healthy cadence', () => {
  it('first sample: exactly one request on start, anchored at receipt', async () => {
    const s = setup();
    const before = s.getSnapshot();
    expect(before.transport).toBe('idle');
    expect(before.anchor).toBeNull();
    const after = await startAndSettle(s);
    expect(starts()).toEqual([0]);
    expect(after.transport).toBe('polling');
    expect(after.requestInFlight).toBe(false);
    expect(after.anchor?.sample.latitudeDeg).toBe(45.005782935448);
    expect(after.anchor?.sample.longitudeDeg).toBe(-18.396323801261);
    expect(after.anchor?.sample.positionTimeMs).toBe(T0_MS);
    expect(after.anchor?.anchorMonoMs).toBe(MONO_BASE);
    expect(after.anchor?.anchorWallMs).toBe(T0_MS);
    expect(after.anchor?.sourceAgeAtReceiptMs).toBe(0);
    expect(after.anchor?.futureSkew).toBe(false);
    expect(after.nextEligibleMonoMs).toBe(MONO_BASE + 5_000);
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastFailure).toBeNull();
    expect(after.trail.points).toEqual([
      { latDeg: 45.005782935448, lonDeg: -18.396323801261, positionTimeMs: T0_MS },
    ]);
    expect(freshnessNow()).toEqual({ state: 'fresh', ageMs: 0, clockWarning: null });
  });

  it('start() is idempotent', async () => {
    const s = setup();
    s.start();
    s.start();
    s.start();
    await env.flush();
    expect(fake.calls).toHaveLength(1);
  });

  it('second sample arrives at exactly 5 000 ms and moves the anchor', async () => {
    const s = setup();
    fake.queue(at(0), at(5_000, 46.1, -16.2));
    await startAndSettle(s);
    await env.advance(4_999);
    expect(starts()).toEqual([0]);
    await env.advance(1);
    expect(starts()).toEqual([0, 5_000]);
    const after = snap();
    expect(after.anchor?.sample.latitudeDeg).toBe(46.1);
    expect(after.anchor?.sample.longitudeDeg).toBe(-16.2);
    expect(after.anchor?.anchorMonoMs).toBe(MONO_BASE + 5_000);
    expect(after.trail.points).toHaveLength(2);
  });

  it('slow 3.7 s response: next start still at lastStart + 5 s', async () => {
    const s = setup();
    fake.queue(json(payloadAt(T0_MS), { delayMs: 3_700 }));
    s.start();
    await env.flush();
    expect(snap().requestInFlight).toBe(true);
    await env.advance(3_700);
    expect(snap().requestInFlight).toBe(false);
    await env.advance(1_299);
    expect(starts()).toEqual([0]);
    await env.advance(1);
    expect(starts()).toEqual([0, 5_000]);
  });

  it('7 s response: next start waits for settlement (max(lastStart+5s, settlement))', async () => {
    const s = setup();
    fake.queue(json(payloadAt(T0_MS), { delayMs: 7_000 }));
    s.start();
    await env.advance(6_999);
    expect(starts()).toEqual([0]);
    expect(fake.maxConcurrentActive()).toBe(1);
    await env.advance(1);
    expect(starts()).toEqual([0, 7_000]);
  });

  it('timeout at 8 s is a failure with a 10 s backoff from settlement (r = 0)', async () => {
    const s = setup();
    fake.queue({ kind: 'hang' });
    await startAndSettle(s);
    await env.advance(8_000);
    expect(snap().lastFailure).toEqual({ kind: 'timeout' });
    expect(snap().transport).toBe('retry-wait');
    expect(snap().nextEligibleMonoMs).toBe(MONO_BASE + 18_000);
    await env.advance(9_999);
    expect(starts()).toEqual([0]);
    await env.advance(1);
    expect(starts()).toEqual([0, 18_000]);
  });

  it('snapshot identity is stable until something changes; listeners fire synchronously', async () => {
    const s = setup();
    fake.queue({ kind: 'hang' });
    const a = s.getSnapshot();
    expect(s.getSnapshot()).toBe(a);
    const listener = vi.fn();
    const unsubscribe = s.subscribe(listener);
    s.start();
    expect(listener).toHaveBeenCalled();
    expect(s.getSnapshot()).not.toBe(a);
    const b = s.getSnapshot();
    expect(s.getSnapshot()).toBe(b);
    unsubscribe();
    listener.mockClear();
    s.pause();
    expect(listener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('A07 outage backoff', () => {
  it('10/20/40/60/60 s from settlement with r = 0, anchor kept', async () => {
    const s = setup({ r: 0 });
    fake.queue(at(0));
    fake.setFallback(() => ({ kind: 'network' }));
    const first = await startAndSettle(s);
    const anchor = first.anchor;

    await env.advance(5_000);
    expect(snap().transport).toBe('retry-wait');
    expect(snap().consecutiveFailures).toBe(1);
    expect(snap().lastFailure).toEqual({ kind: 'network' });
    expect(snap().nextEligibleMonoMs).toBe(MONO_BASE + 15_000);
    expect(snap().anchor).toBe(anchor);

    await env.advance(190_000);
    expect(starts()).toEqual([0, 5_000, 15_000, 35_000, 75_000, 135_000, 195_000]);
    expect(snap().consecutiveFailures).toBe(6);
    expect(snap().anchor).toBe(anchor);
    expect(snap().anchor?.sample.latitudeDeg).toBe(45.005782935448);
  });

  it('jitter r = 0.5 → 11/22/44/60 s', async () => {
    const s = setup({ r: 0.5 });
    fake.setFallback(() => ({ kind: 'network' }));
    await startAndSettle(s);
    await env.advance(137_000);
    const expected = [0, 11_000, 33_000, 77_000, 137_000];
    expect(starts()).toHaveLength(expected.length);
    starts().forEach((value, i) =>
      expect(Math.abs(value - (expected[i] ?? NaN))).toBeLessThanOrEqual(1),
    );
  });

  it('jitter r = 0.999 never exceeds the 60 s ordinary cap', async () => {
    const s = setup({ r: 0.999 });
    fake.setFallback(() => ({ kind: 'network' }));
    await startAndSettle(s);
    await env.advance(400_000);
    const gaps = starts()
      .slice(1)
      .map((v, i) => v - (starts()[i] ?? 0));
    expect(gaps[0]).toBeCloseTo(11_998, -1);
    expect(gaps[1]).toBeCloseTo(23_996, -1);
    expect(gaps[2]).toBeCloseTo(47_992, -1);
    for (const g of gaps.slice(3)) expect(g).toBeLessThanOrEqual(60_000);
  });

  it('5xx, 408, invalid JSON, wrong content type and invalid payload are all retryable failures', async () => {
    const s = setup({ r: 0 });
    fake.queue(
      status(503),
      status(408),
      json('{not json'),
      { kind: 'respond', status: 200, headers: { 'Content-Type': 'text/html' }, body: '<html>' },
      json('{"id":25545}'),
    );
    await startAndSettle(s);
    await env.advance(150_000);
    expect(starts()).toEqual([0, 10_000, 30_000, 70_000, 130_000]);
    expect(snap().consecutiveFailures).toBe(5);
    expect(snap().transport).toBe('retry-wait');
  });

  it('recovery resets backoff: next failure starts at 10 s again', async () => {
    const s = setup({ r: 0 });
    fake.queue(
      { kind: 'network' }, // t=0      → +10s
      { kind: 'network' }, // t=10000  → +20s
      { kind: 'network' }, // t=30000  → +40s
      at(70_000), //          t=70000  recovered → +5s
      { kind: 'network' }, // t=75000  → +10s (not 60s)
    );
    await startAndSettle(s);
    await env.advance(70_000);
    expect(snap().consecutiveFailures).toBe(0);
    expect(snap().lastFailure).toBeNull();
    expect(snap().transport).toBe('polling');
    await env.advance(15_000);
    expect(starts()).toEqual([0, 10_000, 30_000, 70_000, 75_000, 85_000]);
  });

  it('30-minute outage stays bounded (no request storm)', async () => {
    const s = setup({ r: 0 });
    fake.setFallback(() => ({ kind: 'network' }));
    await startAndSettle(s);
    await env.advance(30 * 60_000);
    // 0, 10, 30, 70, 130, then every 60 s up to 1800 → 5 + 27 = 32
    expect(fake.calls.length).toBeGreaterThanOrEqual(31);
    expect(fake.calls.length).toBeLessThanOrEqual(33);
  });
});

// ---------------------------------------------------------------------------
describe('A08 rate limiting (429) and server waits (G1-v2)', () => {
  it('429 Retry-After 120 waits 120 s, not capped at 60 s', async () => {
    const s = setup({ r: 0 });
    fake.queue(at(0), status(429, { 'Retry-After': '120' }));
    await startAndSettle(s);
    await env.advance(5_000);
    expect(snap().lastFailure).toEqual({
      kind: 'http',
      status: 429,
      retryAfter: { kind: 'seconds', seconds: 120 },
      serverDateMs: null,
    });
    expect(snap().transport).toBe('retry-wait');
    expect(snap().nextEligibleMonoMs).toBe(MONO_BASE + 125_000);
    s.retryNow();
    expect(snap().retryBlockedBy).toBe('server-wait');
    await env.advance(119_999);
    expect(starts()).toEqual([0, 5_000]);
    await env.advance(1);
    expect(starts()).toEqual([0, 5_000, 125_000]);
  });

  it('429 without Retry-After waits at least 60 s', async () => {
    const s = setup({ r: 0 });
    fake.queue(at(0), status(429));
    await startAndSettle(s);
    await env.advance(5_000 + 59_999);
    expect(starts()).toEqual([0, 5_000]);
    await env.advance(1);
    expect(starts()).toEqual([0, 5_000, 65_000]);
  });

  for (const value of ['1e9', '99999999999', '-1', '+5', '1.5', '86401']) {
    it(`G1-v2: invalid Retry-After ${JSON.stringify(value)} → treated as absent → 60 s`, async () => {
      const s = setup({ r: 0 });
      fake.queue(at(0), status(429, { 'Retry-After': value }));
      await startAndSettle(s);
      await env.advance(5_000 + 59_999);
      expect(starts()).toEqual([0, 5_000]);
      await env.advance(1);
      expect(starts()).toEqual([0, 5_000, 65_000]);
    });
  }

  it('G1-v2: valid Retry-After 7200 s is capped at 1 h', async () => {
    const s = setup({ r: 0 });
    fake.queue(at(0), status(429, { 'Retry-After': '7200' }));
    await startAndSettle(s);
    await env.advance(5_000);
    expect(snap().nextEligibleMonoMs).toBe(MONO_BASE + 5_000 + 3_600_000);
    await env.advance(3_600_000 - 1);
    expect(starts()).toEqual([0, 5_000]);
    await env.advance(1);
    expect(starts()).toEqual([0, 5_000, 3_605_000]);
  });

  it('date-form Retry-After is measured against the server Date (server clock 1 h behind)', async () => {
    const s = setup({ r: 0 });
    const serverNow = T0_MS + 5_000 - 3_600_000;
    fake.queue(
      at(0),
      status(429, {
        Date: new Date(serverNow).toUTCString(),
        'Retry-After': new Date(serverNow + 90_000).toUTCString(),
      }),
    );
    await startAndSettle(s);
    await env.advance(5_000 + 89_999);
    expect(starts()).toEqual([0, 5_000]);
    await env.advance(1);
    expect(starts()).toEqual([0, 5_000, 95_000]);
  });

  it('G1-v2: past HTTP-date means wait 0, but the 429 ordinary backoff still applies', async () => {
    const s = setup({ r: 0 });
    fake.queue(
      at(0),
      status(429, {
        Date: new Date(T0_MS + 5_000).toUTCString(),
        'Retry-After': new Date(T0_MS - 3_600_000).toUTCString(),
      }),
    );
    await startAndSettle(s);
    await env.advance(5_000 + 9_999);
    expect(starts()).toEqual([0, 5_000]);
    await env.advance(1);
    expect(starts()).toEqual([0, 5_000, 15_000]);
  });

  it('G1-v2: far-future HTTP-date is capped at 1 h', async () => {
    const s = setup({ r: 0 });
    fake.queue(
      at(0),
      status(429, {
        Date: new Date(T0_MS + 5_000).toUTCString(),
        'Retry-After': new Date(T0_MS + 30 * 86_400_000).toUTCString(),
      }),
    );
    await startAndSettle(s);
    await env.advance(5_000);
    expect(snap().nextEligibleMonoMs).toBe(MONO_BASE + 5_000 + 3_600_000);
  });

  it('server deadline survives pause/resume, hide/show and offline/online', async () => {
    const s = setup({ r: 0 });
    fake.queue(at(0), status(429, { 'Retry-After': '120' }));
    await startAndSettle(s);
    await env.advance(5_000);
    s.pause();
    await env.advance(1_000);
    s.resume();
    s.setVisible(false);
    await env.advance(1_000);
    s.setVisible(true);
    s.setOnlineHint(false);
    await env.advance(1_000);
    s.setOnlineHint(true);
    await env.advance(1_000);
    expect(starts()).toEqual([0, 5_000]);
    await env.advance(125_000 - 9_000 - 1);
    expect(starts()).toEqual([0, 5_000]);
    await env.advance(1);
    expect(starts()).toEqual([0, 5_000, 125_000]);
  });

  it('date-form Retry-After + clock suspect + no server Date → automatic retry paused (time-unverified)', async () => {
    const s = setup({ r: 0 });
    fake.queue(
      at(0),
      status(429, { 'Retry-After': new Date(T0_MS + 600_000 + 90_000).toUTCString() }),
    );
    await startAndSettle(s);
    await env.advance(2_000);
    env.jumpWall(600_000); // local wall jumps 10 min forward; monotonic does not
    await env.advance(3_000); // wake at t=5000: clock check → clockSuspect, one request → 429
    expect(starts()).toEqual([0, 5_000]);
    expect(snap().clockSuspect).toBe(true);
    expect(codes()).toContain('clock-jump-detected');
    expect(snap().retryBlockedBy).toBe('time-unverified');
    await env.advance(600_000);
    expect(starts()).toEqual([0, 5_000]);
  });
});

// ---------------------------------------------------------------------------
describe('A09 blocking, visibility, offline, pause, retry', () => {
  for (const code of [401, 403, 404, 400]) {
    it(`${code} blocks automatic retry; manual Retry probes exactly once`, async () => {
      const s = setup({ r: 0 });
      fake.queue(status(code));
      await startAndSettle(s);
      expect(snap().transport).toBe('blocked');
      s.retryNow();
      await env.flush();
      expect(snap().retryBlockedBy).toBe('spacing');
      expect(starts()).toEqual([0]);
      await env.advance(600_000);
      expect(starts()).toEqual([0]);
      fake.queue({ kind: 'hang' });
      for (let i = 0; i < 10; i += 1) s.retryNow();
      await env.flush();
      expect(starts()).toEqual([0, 600_000]);
      s.retryNow();
      expect(snap().retryBlockedBy).toBe('in-flight');
      expect(fake.calls).toHaveLength(2);
    });
  }

  it('hidden: aborts in-flight (not a failure), clears every timer, no requests while hidden', async () => {
    const s = setup();
    fake.queue(at(0), { kind: 'hang' });
    await startAndSettle(s);
    await env.advance(6_000); // request #2 in flight since 5000
    expect(snap().requestInFlight).toBe(true);
    s.setVisible(false);
    await env.flush();
    expect(fake.calls[1]?.aborted).toBe(true);
    expect(snap().transport).toBe('hidden');
    expect(snap().requestInFlight).toBe(false);
    expect(snap().consecutiveFailures).toBe(0);
    expect(snap().lastFailure).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await env.advance(300_000);
    expect(fake.calls).toHaveLength(2);
  });

  it('visible again: exactly one request, no burst of missed intervals', async () => {
    const s = setup();
    await startAndSettle(s);
    await env.advance(7_000); // starts 0, 5000
    s.setVisible(false);
    await env.advance(300_000);
    s.setVisible(true);
    await env.flush();
    expect(starts()).toEqual([0, 5_000, 307_000]);
    await env.advance(4_999);
    expect(fake.calls).toHaveLength(3);
    await env.advance(1);
    expect(starts()).toEqual([0, 5_000, 307_000, 312_000]);
  });

  it('visible before spacing elapsed waits for the deadline instead of requesting', async () => {
    const s = setup();
    await startAndSettle(s);
    await env.advance(1_000);
    s.setVisible(false);
    await env.advance(1_000);
    s.setVisible(true);
    await env.advance(2_999);
    expect(starts()).toEqual([0]);
    await env.advance(1);
    expect(starts()).toEqual([0, 5_000]);
  });

  it('rapid visibility toggling never produces more than one request per 5 s', async () => {
    const s = setup();
    await startAndSettle(s);
    await env.advance(60_000);
    const before = fake.calls.length;
    for (let i = 0; i < 25; i += 1) {
      s.setVisible(false);
      s.setVisible(true);
      await env.advance(40);
    }
    expect(fake.calls.length - before).toBeLessThanOrEqual(1);
    expect(fake.maxConcurrentActive()).toBeLessThanOrEqual(1);
  });

  it('hidden at start: no request until visible', async () => {
    const s = setup({ visible: false });
    s.start();
    await env.advance(60_000);
    expect(fake.calls).toHaveLength(0);
    s.setVisible(true);
    await env.flush();
    expect(starts()).toEqual([60_000]);
  });

  it('pause persists across visibility and network events; resume makes one request', async () => {
    const s = setup();
    await startAndSettle(s);
    await env.advance(6_000);
    s.pause();
    expect(snap().transport).toBe('paused');
    s.setVisible(false);
    s.setVisible(true);
    s.setOnlineHint(false);
    s.setOnlineHint(true);
    expect(snap().transport).toBe('paused');
    s.retryNow();
    expect(snap().retryBlockedBy).toBe('paused');
    await env.advance(120_000);
    expect(starts()).toEqual([0, 5_000]);
    expect(snap().anchor).not.toBeNull();
    s.resume();
    await env.flush();
    expect(starts()).toEqual([0, 5_000, 126_000]);
    expect(snap().transport).toBe('polling');
  });

  it('offline hint: no automatic attempts; Retry may still probe', async () => {
    const s = setup();
    await startAndSettle(s);
    s.setOnlineHint(false);
    expect(snap().transport).toBe('offline');
    await env.advance(300_000);
    expect(starts()).toEqual([0]);
    s.retryNow();
    await env.flush();
    expect(starts()).toEqual([0, 300_000]);
    s.setOnlineHint(true);
    await env.advance(4_999);
    expect(fake.calls).toHaveLength(2);
  });

  it('rapid Retry presses during backoff and in flight never add requests', async () => {
    const s = setup({ r: 0 });
    fake.queue({ kind: 'network' }, { kind: 'hang' });
    await startAndSettle(s);
    for (let i = 0; i < 20; i += 1) s.retryNow();
    await env.flush();
    expect(starts()).toEqual([0]);
    expect(snap().retryBlockedBy).toBe('backoff');
    await env.advance(10_000);
    expect(starts()).toEqual([0, 10_000]);
    for (let i = 0; i < 20; i += 1) s.retryNow();
    await env.flush();
    expect(fake.calls).toHaveLength(2);
    expect(snap().retryBlockedBy).toBe('in-flight');
    expect(fake.maxConcurrentActive()).toBe(1);
  });

  it('dispose aborts, clears all timers, ignores late results, and later calls are no-ops', async () => {
    const s = setup();
    fake.queue(at(0), json(payloadAt(T0_MS + 5_000, 1, 1), { delayMs: 2_000, ignoreAbort: true }));
    await startAndSettle(s);
    await env.advance(5_500);
    const before = s.getSnapshot();
    s.dispose();
    s.dispose();
    await env.advance(3_000);
    expect(s.getSnapshot().anchor?.sample.latitudeDeg).toBe(before.anchor?.sample.latitudeDeg);
    s.start();
    s.resume();
    s.retryNow();
    s.setVisible(true);
    await env.advance(60_000);
    expect(fake.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a late result from an aborted generation never changes state', async () => {
    const s = setup();
    fake.queue(json(payloadAt(T0_MS, 10, 10), { delayMs: 2_000, ignoreAbort: true }));
    s.start();
    await env.advance(500);
    s.setVisible(false);
    await env.advance(5_000);
    expect(snap().anchor).toBeNull();
    expect(snap().trail.points).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('A04 ordering and A05 freshness through the pipeline', () => {
  it('fresh → delayed → stale boundaries at 15 000 / 15 001 / 60 000 / 60 001 ms', async () => {
    const s = setup({ r: 0 });
    fake.queue(at(0));
    fake.setFallback(() => status(503));
    await startAndSettle(s);
    await env.advance(15_000);
    expect(freshnessNow()).toEqual({ state: 'fresh', ageMs: 15_000, clockWarning: null });
    await env.advance(1);
    expect(freshnessNow()).toEqual({ state: 'delayed', ageMs: 15_001, clockWarning: null });
    await env.advance(44_999);
    expect(freshnessNow()).toEqual({ state: 'delayed', ageMs: 60_000, clockWarning: null });
    await env.advance(1);
    expect(freshnessNow()).toEqual({ state: 'stale', ageMs: 60_001, clockWarning: null });
    expect(snap().anchor?.sample.positionTimeMs).toBe(T0_MS);
  });

  it('source age at receipt counts: a 10 s old sample is delayed after 5.001 s', async () => {
    const s = setup();
    fake.queue(at(-10_000));
    fake.setFallback(() => status(503));
    await startAndSettle(s);
    expect(snap().anchor?.sourceAgeAtReceiptMs).toBe(10_000);
    await env.advance(5_000);
    expect(freshnessNow().state).toBe('fresh');
    await env.advance(1);
    expect(freshnessNow()).toEqual({ state: 'delayed', ageMs: 15_001, clockWarning: null });
  });

  it('duplicate resets backoff but does not reanchor age or extend the trail', async () => {
    const s = setup({ r: 0 });
    fake.queue(at(0), { kind: 'network' }, at(0));
    fake.setFallback(() => at(0));
    const first = await startAndSettle(s);
    await env.advance(5_000); // failure → +10s
    expect(snap().consecutiveFailures).toBe(1);
    await env.advance(10_000); // t=15000 duplicate
    expect(starts()).toEqual([0, 5_000, 15_000]);
    expect(snap().consecutiveFailures).toBe(0);
    expect(snap().lastFailure).toBeNull();
    expect(snap().anchor).toBe(first.anchor);
    expect(snap().anchor?.anchorMonoMs).toBe(MONO_BASE);
    expect(snap().trail.points).toHaveLength(1);
    expect(freshnessNow()).toEqual({ state: 'fresh', ageMs: 15_000, clockWarning: null });
    await env.advance(5_000);
    expect(starts()).toEqual([0, 5_000, 15_000, 20_000]);
    expect(freshnessNow()).toEqual({ state: 'delayed', ageMs: 20_000, clockWarning: null });
  });

  it('conflict (same time, different coordinates) keeps current and records a diagnostic', async () => {
    const s = setup();
    fake.queue(at(0), at(0, 1, 1));
    const first = await startAndSettle(s);
    await env.advance(5_000);
    expect(snap().anchor).toBe(first.anchor);
    expect(snap().consecutiveFailures).toBe(0);
    expect(codes()).toContain('conflicting-sample');
  });

  it('older sample is ignored with a diagnostic', async () => {
    const s = setup();
    fake.queue(at(0), at(-10_000, 2, 2));
    const first = await startAndSettle(s);
    await env.advance(5_000);
    expect(snap().anchor).toBe(first.anchor);
    expect(codes()).toContain('older-sample-ignored');
  });

  it('31 s in the future is rejected as an invalid-payload failure', async () => {
    const s = setup({ r: 0 });
    fake.queue(at(31_000));
    await startAndSettle(s);
    expect(snap().anchor).toBeNull();
    expect(snap().consecutiveFailures).toBe(1);
    expect(snap().transport).toBe('retry-wait');
    expect(snap().nextEligibleMonoMs).toBe(MONO_BASE + 10_000);
    expect(codes()).toContain('future-sample-rejected');
  });

  it('a sample exactly 30 s ahead is kept, never fresh, with future-skew warning', async () => {
    const s = setup();
    fake.queue(at(30_000));
    await startAndSettle(s);
    expect(snap().anchor?.futureSkew).toBe(true);
    expect(snap().anchor?.sourceAgeAtReceiptMs).toBe(0);
    expect(codes()).toContain('future-skew-accepted');
    expect(freshnessNow()).toEqual({ state: 'delayed', ageMs: 0, clockWarning: 'future-skew' });
  });

  it('a seconds timestamp just under the ms heuristic is rejected by ordering', async () => {
    const s = setup();
    fake.queue(
      json(JSON.stringify({ ...JSON.parse(payloadAt(T0_MS)), timestamp: 99_999_999_999 })),
    );
    await startAndSettle(s);
    expect(snap().anchor).toBeNull();
    expect(codes()).toContain('future-sample-rejected');
  });

  it('G1-v2: three consecutive too-far-future samples set clockSuspect', async () => {
    const s = setup({ r: 0 });
    fake.setFallback(() => json(payloadAt(Date.now() + 120_000)));
    await startAndSettle(s);
    expect(snap().clockSuspect).toBe(false);
    await env.advance(10_000);
    expect(fake.calls).toHaveLength(2);
    expect(snap().clockSuspect).toBe(false);
    await env.advance(20_000);
    expect(fake.calls).toHaveLength(3);
    expect(snap().clockSuspect).toBe(true);
  });

  it('G1-v2: three consecutive self-consistent older samples re-anchor to the newest', async () => {
    const s = setup();
    fake.queue(at(25_000), at(5_000), at(10_000), at(15_000));
    await startAndSettle(s);
    expect(snap().anchor?.sample.positionTimeMs).toBe(T0_MS + 25_000);
    await env.advance(5_000);
    await env.advance(5_000);
    expect(snap().anchor?.sample.positionTimeMs).toBe(T0_MS + 25_000);
    await env.advance(5_000);
    expect(starts()).toEqual([0, 5_000, 10_000, 15_000]);
    expect(snap().anchor?.sample.positionTimeMs).toBe(T0_MS + 15_000);
    expect(snap().anchor?.anchorMonoMs).toBe(MONO_BASE + 15_000);
  });

  it('G1-v2: older samples that are not self-consistent do not re-anchor', async () => {
    const s = setup();
    fake.queue(at(25_000), at(10_000), at(5_000), at(8_000));
    await startAndSettle(s);
    await env.advance(15_000);
    expect(snap().anchor?.sample.positionTimeMs).toBe(T0_MS + 25_000);
  });

  it('backward wall jump never makes data fresher; marks time unverified', async () => {
    const s = setup();
    fake.queue(at(0));
    fake.setFallback(() => status(503));
    await startAndSettle(s);
    await env.advance(2_000);
    env.jumpWall(-3_600_000);
    await env.advance(8_000);
    const f = freshnessNow();
    expect(f.state).toBe('unverified');
    expect(f.clockWarning).toBe('time-unverified');
    expect(f.ageMs).toBe(10_000);
    expect(snap().clockSuspect).toBe(true);
    expect(codes()).toContain('clock-jump-detected');
  });
});

// ---------------------------------------------------------------------------
describe('A17 long run and timer hygiene', () => {
  it('30-minute healthy run ≈ 360 requests, single flight, bounded state, zero leaked timers', async () => {
    const s = setup();
    await startAndSettle(s);
    for (let i = 0; i < 30; i += 1) await env.advance(60_000);
    expect(fake.calls.length).toBeGreaterThanOrEqual(359);
    expect(fake.calls.length).toBeLessThanOrEqual(361);
    expect(fake.maxConcurrentActive()).toBe(1);
    const points = snap().trail.points;
    expect(points).toHaveLength(120);
    const span = (points.at(-1)?.positionTimeMs ?? 0) - (points[0]?.positionTimeMs ?? 0);
    expect(span).toBeLessThanOrEqual(600_000);
    expect(snap().diagnostics.length).toBeLessThanOrEqual(20);
    s.dispose();
    expect(vi.getTimerCount()).toBe(0);
    const count = fake.calls.length;
    await env.advance(60_000);
    expect(fake.calls).toHaveLength(count);
  });

  it('G1-v2: every scheduled delay is finite and ≤ 2^31−1 ms', async () => {
    const delays: number[] = [];
    const recording: TimerApi = {
      set: (cb, d) => {
        delays.push(d);
        return env.timers.set(cb, d);
      },
      clear: (h) => env.timers.clear(h),
    };
    const s = setup({ r: 0, schedulerTimers: recording });
    fake.queue(at(0), status(429, { 'Retry-After': '86400' }));
    await startAndSettle(s);
    await env.advance(5_000);
    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) {
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(2_147_483_647);
    }
  });

  it('G1-v2: a timer that fires early makes the scheduler re-arm, not fetch', async () => {
    // Fires delays above 1 s at 50 % of the requested time; short delays exactly.
    const early: TimerApi = {
      set: (cb, d) => env.timers.set(cb, d > 1_000 ? Math.floor(d / 2) : d),
      clear: (h) => env.timers.clear(h),
    };
    const s = setup({ r: 0, schedulerTimers: early });
    fake.queue(at(0), { kind: 'network' });
    await startAndSettle(s);
    await env.advance(4_999);
    expect(starts()).toEqual([0]);
    await env.advance(1);
    expect(starts()).toEqual([0, 5_000]);
    await env.advance(9_999);
    expect(starts()).toEqual([0, 5_000]);
    await env.advance(1);
    expect(starts()).toEqual([0, 5_000, 15_000]);
  });
});
