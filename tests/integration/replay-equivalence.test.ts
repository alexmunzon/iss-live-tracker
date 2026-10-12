// Mission Replay slice 1: replaying a recorded event reproduces exactly what the live view
// computed at that commit. Drives the REAL scheduler + client with the QA harness.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trackerPolicy } from '../../src/config/trackerPolicy';
import { createIssClient } from '../../src/data/issClient';
import { createPollingScheduler } from '../../src/data/pollingMachine';
import { computeFreshness } from '../../src/domain/freshness';
import type {
  FreshnessAnchor,
  FreshnessView,
  PollingScheduler,
  TrackerSnapshot,
  TrailState,
  TransportStatus,
} from '../../src/domain/position';
import {
  EMPTY_REPLAY_LOG,
  recordSnapshot,
  replayStateAt,
  type ReplayLog,
} from '../../src/domain/replay';
import { describeConnection } from '../../src/features/status/format';
import { replayConnection } from '../../src/features/replay/replayFormat';
import { payloadAt } from '../fixtures/adversarial/payloads';
import { T0_MS } from '../fixtures/canonical/index';
import {
  createFakeFetch,
  fixedRandom,
  installVirtualTime,
  json,
  uninstallVirtualTime,
  type FakeFetch,
  type Reply,
  type VirtualEnv,
} from './harness';

let env: VirtualEnv;
let fake: FakeFetch;
let scheduler: PollingScheduler | undefined;

const fresh = (lat?: number, lon?: number): Reply => json(payloadAt(Date.now(), lat, lon));
const status = (code: number, headers: Record<string, string> = {}): Reply => ({
  kind: 'respond',
  status: code,
  headers,
  body: '',
});

interface LiveCapture {
  readonly transport: TransportStatus;
  readonly anchor: FreshnessAnchor | null;
  readonly trail: TrailState;
  readonly freshness: FreshnessView;
  /** The connection line exactly as useTracker would render it at this commit. */
  readonly connection: string;
}

interface Recorder {
  log(): ReplayLog;
  captures: Map<number, LiveCapture>;
  /** Every live capture, in commit order (pruning never removes these). */
  history: LiveCapture[];
  /** Asserts replayStateAt(log, i) equals the live capture for every retained event. */
  assertEquivalent(): void;
}

function setup(): { s: PollingScheduler; rec: Recorder } {
  const client = createIssClient({ fetch: fake.fetch, clock: env.clock, timers: env.timers });
  const s = createPollingScheduler({
    client,
    clock: env.clock,
    timers: env.timers,
    random: fixedRandom(0),
    initialVisible: true,
    initialOnline: true,
  });
  scheduler = s;

  let log = EMPTY_REPLAY_LOG;
  let prev: TrackerSnapshot = s.getSnapshot();
  const captures = new Map<number, LiveCapture>();
  const history: LiveCapture[] = [];
  s.subscribe(() => {
    const next = s.getSnapshot();
    // What the live view shows at this commit.
    const freshness = computeFreshness(next.anchor, env.clock);
    const due = next.nextEligibleMonoMs;
    const seconds =
      due === null ? null : Math.ceil(Math.max(0, due - env.clock.monotonicNowMs()) / 1000);
    const live: LiveCapture = {
      transport: next.transport,
      anchor: next.anchor,
      trail: next.trail,
      freshness,
      connection: describeConnection(next, freshness, seconds),
    };
    history.push(live);
    const firstSeq = log.nextSeq;
    log = recordSnapshot(log, prev, next, env.clock);
    for (let seq = firstSeq; seq < log.nextSeq; seq += 1) captures.set(seq, live);
    prev = next;
  });

  const rec: Recorder = {
    log: () => log,
    captures,
    history,
    assertEquivalent() {
      expect(log.events.length).toBeGreaterThan(0);
      log.events.forEach((event, i) => {
        const state = replayStateAt(log, i);
        const live = captures.get(event.seq);
        expect(state).not.toBeNull();
        expect(live).toBeDefined();
        if (!state || !live) return;
        expect(state.freshness).toEqual(live.freshness);
        expect(state.anchor).toBe(live.anchor);
        expect(state.trail).toBe(live.trail);
        expect(state.transport).toBe(live.transport);
        expect(replayConnection(log, i)).toBe(live.connection);
      });
    },
  };
  return { s, rec };
}

const kinds = (rec: Recorder) => rec.log().events.map((e) => e.kind);
const states = (rec: Recorder) => rec.history.map((c) => c.freshness.state);

beforeEach(() => {
  env = installVirtualTime();
  fake = createFakeFetch(env, () => fresh());
});

afterEach(() => {
  scheduler?.dispose();
  scheduler = undefined;
  uninstallVirtualTime();
});

describe('Mission Replay equivalence with the live view (real scheduler)', () => {
  it('steady tracking', async () => {
    const { s, rec } = setup();
    s.start();
    await env.flush();
    await env.advance(60_000);
    expect(kinds(rec)).toContain('transport-changed');
    expect(kinds(rec)).toContain('request-started');
    expect(kinds(rec)).toContain('request-ended');
    expect(kinds(rec).filter((k) => k === 'sample-accepted').length).toBeGreaterThanOrEqual(12);
    expect(rec.log().events.every((e) => e.diagnostic === null)).toBe(true);
    expect(states(rec).every((st) => st === 'empty' || st === 'fresh')).toBe(true);
    rec.assertEquivalent();
  });

  for (const [name, from, to] of [
    ['eastward', 179.2, -179.2],
    ['westward', -179.2, 179.2],
  ] as const) {
    it(`antimeridian crossing ${name}`, async () => {
      let n = 0;
      fake.setFallback(() => {
        n += 1;
        return fresh(10, n <= 3 ? from : to);
      });
      const { s, rec } = setup();
      s.start();
      await env.flush();
      await env.advance(30_000);
      const lons = rec
        .log()
        .events.filter((e) => e.kind === 'sample-accepted')
        .map((e) => e.anchor?.sample.longitudeDeg);
      expect(lons.slice(0, 4)).toEqual([from, from, from, to]);
      const last = rec.log().events.at(-1);
      expect(last?.trail.points.some((p) => p.lonDeg === from)).toBe(true);
      expect(last?.trail.points.some((p) => p.lonDeg === to)).toBe(true);
      rec.assertEquivalent();
    });
  }

  it('outage → stale → recovery', async () => {
    const { s, rec } = setup();
    s.start();
    await env.flush();
    await env.advance(10_000);
    fake.setFallback(() => ({ kind: 'network' }));
    await env.advance(180_000);
    expect(s.getSnapshot().transport).toBe('retry-wait');
    fake.setFallback(() => fresh());
    await env.advance(120_000);
    expect(s.getSnapshot().transport).toBe('polling');

    const seen = states(rec);
    const staleAt = seen.indexOf('stale');
    expect(staleAt).toBeGreaterThan(0);
    expect(seen.slice(staleAt).includes('fresh')).toBe(true);
    const diags = rec.log().events.filter((e) => e.kind === 'diagnostic');
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((e) => e.diagnostic?.code === 'fetch-failed')).toBe(true);
    expect(diags.every((e) => e.diagnostic?.detail === 'network')).toBe(true);
    rec.assertEquivalent();
  });

  it('wall-clock jump', async () => {
    const { s, rec } = setup();
    s.start();
    await env.flush();
    await env.advance(7_000);
    env.jumpWall(600_000);
    await env.advance(40_000);
    expect(states(rec)).toContain('unverified');
    expect(rec.log().events.some((e) => e.diagnostic?.code === 'clock-jump-detected')).toBe(true);
    rec.assertEquivalent();
  });

  it('date-form 429 hold (time-unverified)', async () => {
    fake.queue(
      fresh(),
      status(429, { 'Retry-After': new Date(T0_MS + 600_000 + 90_000).toUTCString() }),
    );
    const { s, rec } = setup();
    s.start();
    await env.flush();
    await env.advance(2_000);
    env.jumpWall(600_000);
    await env.advance(3_000);
    expect(s.getSnapshot().retryBlockedBy).toBe('time-unverified');
    await env.advance(120_000);
    expect(fake.calls).toHaveLength(2);
    expect(rec.log().events.some((e) => e.transport === 'retry-wait')).toBe(true);
    expect(rec.log().events.some((e) => e.diagnostic?.detail === 'http-429')).toBe(true);
    rec.assertEquivalent();
  });

  it('long run stays within the event cap and the time window', async () => {
    const { s, rec } = setup();
    s.start();
    await env.flush();
    for (let minute = 0; minute < 30; minute += 1) {
      await env.advance(60_000);
      const events = rec.log().events;
      expect(events.length).toBeLessThanOrEqual(trackerPolicy.replayMaxEvents);
      const first = events[0];
      const last = events.at(-1);
      if (first && last) {
        expect(last.monoMs - first.monoMs).toBeLessThanOrEqual(trackerPolicy.replayWindowMs);
      }
    }
    expect(rec.log().nextSeq).toBeGreaterThan(rec.log().events.length);
    rec.assertEquivalent();
  });
});
