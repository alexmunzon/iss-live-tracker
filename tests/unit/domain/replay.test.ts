// Mission Replay slice 1: pure event derivation, pruning and replay state.
import { describe, expect, it } from 'vitest';
import { trackerPolicy } from '../../../src/config/trackerPolicy';
import { computeFreshness, createAnchor } from '../../../src/domain/freshness';
import type {
  Clock,
  Diagnostic,
  FreshnessAnchor,
  TrackerSnapshot,
} from '../../../src/domain/position';
import {
  EMPTY_REPLAY_LOG,
  recordSnapshot,
  replayStateAt,
  type ReplayLog,
} from '../../../src/domain/replay';
import { makeSnapshot } from '../../../src/features/status/fixtures';
import { sample, T0_MS } from '../../fixtures/canonical';

const MONO0 = 1_000;

function clockAt(monoMs: number, wallMs: number = T0_MS + (monoMs - MONO0)): Clock {
  return { monotonicNowMs: () => monoMs, wallNowMs: () => wallMs };
}

function anchorAt(monoMs: number, positionTimeMs = T0_MS + (monoMs - MONO0)): FreshnessAnchor {
  return createAnchor(sample({ positionTimeMs }), clockAt(monoMs));
}

const base = makeSnapshot({ transport: 'idle', anchor: null, diagnostics: [] });
const diag = (i: number): Diagnostic => ({
  code: 'fetch-failed',
  atWallMs: T0_MS + i,
  detail: 'network',
});

describe('recordSnapshot: event kinds', () => {
  it('transport-changed carries the next transport, anchor and trail', () => {
    const next = makeSnapshot({ transport: 'polling', anchor: null });
    const log = recordSnapshot(EMPTY_REPLAY_LOG, base, next, clockAt(2_000));
    expect(log.events.map((e) => e.kind)).toEqual(['transport-changed']);
    const [e] = log.events;
    expect(e?.transport).toBe('polling');
    expect(e?.trail).toBe(next.trail);
    expect(e?.anchor).toBeNull();
    expect(e?.monoMs).toBe(2_000);
    expect(e?.wallMs).toBe(T0_MS + 1_000);
    expect(e?.diagnostic).toBeNull();
    expect(e?.seq).toBe(0);
    expect(log.nextSeq).toBe(1);
  });

  it('request-started and request-ended follow the requestInFlight edge', () => {
    const a = makeSnapshot({ ...base, requestInFlight: false });
    const b = makeSnapshot({ ...base, requestInFlight: true });
    const c = makeSnapshot({ ...base, requestInFlight: false });
    let log = recordSnapshot(EMPTY_REPLAY_LOG, a, b, clockAt(1_000));
    log = recordSnapshot(log, b, c, clockAt(1_500));
    expect(log.events.map((e) => e.kind)).toEqual(['request-started', 'request-ended']);
    expect(log.events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('sample-accepted when the anchor reference changes to non-null, not when it clears', () => {
    const anchor = anchorAt(1_000);
    const withAnchor = makeSnapshot({ ...base, anchor });
    let log = recordSnapshot(EMPTY_REPLAY_LOG, base, withAnchor, clockAt(1_000));
    expect(log.events.map((e) => e.kind)).toEqual(['sample-accepted']);
    expect(log.events[0]?.anchor).toBe(anchor);
    const cleared = makeSnapshot({ ...base, anchor: null });
    const before = log;
    log = recordSnapshot(log, withAnchor, cleared, clockAt(1_100));
    expect(log).toBe(before);
  });

  it('diagnostic events carry only the closed code and detail', () => {
    const d: Diagnostic = { code: 'conflicting-sample', atWallMs: T0_MS };
    const next = makeSnapshot({ ...base, diagnostics: [diag(0), d] });
    const prev = makeSnapshot({ ...base, diagnostics: [next.diagnostics[0] as Diagnostic] });
    const log = recordSnapshot(EMPTY_REPLAY_LOG, prev, next, clockAt(1_000));
    expect(log.events.map((e) => e.diagnostic)).toEqual([
      { code: 'conflicting-sample', detail: null },
    ]);
  });

  it('several changes at once are ordered transport, request, sample, diagnostics', () => {
    const d1 = diag(1);
    const d2 = diag(2);
    const next = makeSnapshot({
      transport: 'retry-wait',
      requestInFlight: false,
      anchor: anchorAt(1_000),
      diagnostics: [d1, d2],
    });
    const prev = makeSnapshot({
      transport: 'polling',
      requestInFlight: true,
      anchor: null,
      diagnostics: [],
    });
    const log = recordSnapshot(EMPTY_REPLAY_LOG, prev, next, clockAt(3_000));
    expect(log.events.map((e) => e.kind)).toEqual([
      'transport-changed',
      'request-ended',
      'sample-accepted',
      'diagnostic',
      'diagnostic',
    ]);
    expect(log.events.every((e) => e.monoMs === 3_000 && e.anchor === next.anchor)).toBe(true);
    expect(log.events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it('diagnostics are matched by identity across ring slicing (21+ entries)', () => {
    const limit = trackerPolicy.diagnosticsLimit;
    const all = Array.from({ length: limit + 3 }, (_, i) => diag(i));
    const prevRing = all.slice(0, limit); // full ring: entries 0..19
    const nextRing = all.slice(3, limit + 3); // slid by three: 3..22
    expect(nextRing).toHaveLength(limit);
    const prev = makeSnapshot({ ...base, diagnostics: prevRing });
    const next = makeSnapshot({ ...base, diagnostics: nextRing });
    const log = recordSnapshot(EMPTY_REPLAY_LOG, prev, next, clockAt(1_000));
    expect(log.events).toHaveLength(3);
    // Equal content but a different object is still new; identical objects are not.
    const copy = { ...(nextRing[19] as Diagnostic) };
    const again = makeSnapshot({ ...base, diagnostics: [...nextRing.slice(1), copy] });
    const log2 = recordSnapshot(log, next, again, clockAt(1_100));
    expect(log2.events).toHaveLength(4);
  });

  it('an unchanged or irrelevant change returns the same log reference', () => {
    const log = recordSnapshot(EMPTY_REPLAY_LOG, base, base, clockAt(1_000));
    expect(log).toBe(EMPTY_REPLAY_LOG);
    const onlyCountdown = makeSnapshot({
      ...base,
      nextEligibleMonoMs: 9_999,
      consecutiveFailures: 2,
    });
    expect(recordSnapshot(EMPTY_REPLAY_LOG, base, onlyCountdown, clockAt(1_000))).toBe(
      EMPTY_REPLAY_LOG,
    );
  });

  it('EMPTY_REPLAY_LOG and recorded logs are frozen', () => {
    expect(Object.isFrozen(EMPTY_REPLAY_LOG)).toBe(true);
    expect(Object.isFrozen(EMPTY_REPLAY_LOG.events)).toBe(true);
    const log = recordSnapshot(
      EMPTY_REPLAY_LOG,
      base,
      makeSnapshot({ ...base, transport: 'polling' }),
      clockAt(1_000),
    );
    expect(Object.isFrozen(log)).toBe(true);
    expect(Object.isFrozen(log.events)).toBe(true);
    expect(Object.isFrozen(log.events[0])).toBe(true);
  });
});

/** Toggle requestInFlight so each call appends exactly one event at `monoMs`. */
function toggleRun(times: readonly number[]): ReplayLog {
  let log = EMPTY_REPLAY_LOG;
  let prev: TrackerSnapshot = base;
  for (const t of times) {
    const next = makeSnapshot({ ...base, requestInFlight: !prev.requestInFlight });
    log = recordSnapshot(log, prev, next, clockAt(t));
    prev = next;
  }
  return log;
}

describe('recordSnapshot: bounds', () => {
  it('drops events older than newest − replayWindowMs (boundary kept)', () => {
    const w = trackerPolicy.replayWindowMs;
    const log = toggleRun([0, 1, 2, w + 1]);
    expect(log.events.map((e) => e.monoMs)).toEqual([1, 2, w + 1]);
    expect(log.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log.nextSeq).toBe(4);
  });

  it('keeps at most replayMaxEvents, newest first to survive', () => {
    const n = trackerPolicy.replayMaxEvents + 25;
    const log = toggleRun(Array.from({ length: n }, (_, i) => i));
    expect(log.events).toHaveLength(trackerPolicy.replayMaxEvents);
    expect(log.events[0]?.seq).toBe(25);
    expect(log.events.at(-1)?.seq).toBe(n - 1);
  });

  it('policy values', () => {
    expect(trackerPolicy.replayWindowMs).toBe(600_000);
    expect(trackerPolicy.replayMaxEvents).toBe(600);
  });
});

describe('replayStateAt', () => {
  it('returns null out of range', () => {
    const log = toggleRun([1, 2]);
    expect(replayStateAt(log, -1)).toBeNull();
    expect(replayStateAt(log, 2)).toBeNull();
    expect(replayStateAt(log, 0.5)).toBeNull();
    expect(replayStateAt(EMPTY_REPLAY_LOG, 0)).toBeNull();
  });

  it('empty when no anchor yet', () => {
    const state = replayStateAt(toggleRun([1]), 0);
    expect(state?.freshness).toEqual({ state: 'empty', ageMs: null, clockWarning: null });
  });

  const cases: ReadonlyArray<{
    name: string;
    anchor: FreshnessAnchor;
    mono: number;
    wall: number;
    expected: ReturnType<typeof computeFreshness>;
  }> = [
    {
      name: 'fresh',
      anchor: anchorAt(MONO0),
      mono: MONO0 + 15_000,
      wall: T0_MS + 15_000,
      expected: { state: 'fresh', ageMs: 15_000, clockWarning: null },
    },
    {
      name: 'delayed',
      anchor: anchorAt(MONO0),
      mono: MONO0 + 15_001,
      wall: T0_MS + 15_001,
      expected: { state: 'delayed', ageMs: 15_001, clockWarning: null },
    },
    {
      name: 'stale',
      anchor: anchorAt(MONO0),
      mono: MONO0 + 60_001,
      wall: T0_MS + 60_001,
      expected: { state: 'stale', ageMs: 60_001, clockWarning: null },
    },
    {
      name: 'unverified after a wall jump',
      anchor: anchorAt(MONO0),
      mono: MONO0 + 5_000,
      wall: T0_MS + 5_000 + 600_000,
      expected: { state: 'unverified', ageMs: 5_000, clockWarning: 'time-unverified' },
    },
    {
      name: 'future-skew',
      anchor: anchorAt(MONO0, T0_MS + 10_000),
      mono: MONO0 + 1_000,
      wall: T0_MS + 1_000,
      expected: { state: 'delayed', ageMs: 1_000, clockWarning: 'future-skew' },
    },
  ];

  for (const c of cases) {
    it(`freshness at an event equals computeFreshness with its clock pair: ${c.name}`, () => {
      const next = makeSnapshot({ ...base, transport: 'polling', anchor: c.anchor });
      const log = recordSnapshot(EMPTY_REPLAY_LOG, base, next, clockAt(c.mono, c.wall));
      const state = replayStateAt(log, 1);
      expect(state?.event.kind).toBe('sample-accepted');
      expect(state?.freshness).toEqual(computeFreshness(c.anchor, clockAt(c.mono, c.wall)));
      expect(state?.freshness).toEqual(c.expected);
      expect(state?.anchor).toBe(c.anchor);
      expect(state?.trail).toBe(next.trail);
      expect(state?.transport).toBe('polling');
    });
  }
});
