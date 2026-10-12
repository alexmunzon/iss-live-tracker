import { describe, expect, it } from 'vitest';
import type {
  DiagnosticCode,
  FreshnessAnchor,
  TrackerSnapshot,
  TransportStatus,
} from '../../../src/domain/position';
import type { ReplayEvent, ReplayEventKind, ReplayLog } from '../../../src/domain/replay';
import { EMPTY_TRAIL } from '../../../src/domain/trail';
import {
  DIAGNOSTIC_EVENT_LABEL,
  REQUEST_EVENT_LABEL,
  TRANSPORT_EVENT_LABEL,
  describeReplayEvent,
  replayConnection,
  replayValueText,
  formatUtcTime,
} from '../../../src/features/replay/replayFormat';
import {
  REPLAY_ENTERED_ANNOUNCEMENT,
  backToLiveAnnouncement,
} from '../../../src/features/status/announce';
import { makeSnapshot } from '../../../src/features/status/fixtures';
import { T0_MS } from '../../fixtures/canonical/index';

const ALL_TRANSPORTS: readonly TransportStatus[] = [
  'idle',
  'polling',
  'retry-wait',
  'paused',
  'hidden',
  'offline',
  'blocked',
];
const ALL_CODES: readonly DiagnosticCode[] = [
  'conflicting-sample',
  'older-sample-ignored',
  'future-sample-rejected',
  'future-skew-accepted',
  'optional-field-dropped',
  'clock-jump-detected',
  'late-result-ignored',
  'fetch-failed',
];

const MONO = 500_000;

function anchorAt(positionTimeMs: number, wallMs = positionTimeMs): FreshnessAnchor {
  return {
    sample: {
      provider: 'where-the-iss-at',
      satelliteId: 25544,
      latitudeDeg: 45.005782935448,
      longitudeDeg: -18.396323801261,
      positionTimeMs,
      receivedAtMs: wallMs,
    },
    anchorWallMs: wallMs,
    anchorMonoMs: MONO,
    sourceAgeAtReceiptMs: Math.max(0, wallMs - positionTimeMs),
    futureSkew: false,
  };
}

function event(kind: ReplayEventKind, overrides: Partial<ReplayEvent> = {}, seq = 0): ReplayEvent {
  const base = {
    seq,
    kind,
    monoMs: MONO,
    wallMs: T0_MS,
    transport: 'polling' as TransportStatus,
    anchor: null,
    trail: EMPTY_TRAIL,
    diagnostic: null,
    ...overrides,
  };
  const snapshot =
    overrides.snapshot ??
    makeSnapshot({ transport: base.transport, anchor: base.anchor, trail: base.trail });
  return { ...base, snapshot };
}

describe('Replay event labels', () => {
  it('every transport, request kind and diagnostic code has a plain-language label', () => {
    for (const t of ALL_TRANSPORTS) {
      expect(TRANSPORT_EVENT_LABEL[t]).toMatch(/^[A-Z][^-]*$/);
      expect(describeReplayEvent(event('transport-changed', { transport: t }))).toBe(
        TRANSPORT_EVENT_LABEL[t],
      );
    }
    for (const code of ALL_CODES) {
      const label = DIAGNOSTIC_EVENT_LABEL[code];
      expect(label.length).toBeGreaterThan(5);
      expect(label).not.toContain(code);
      expect(describeReplayEvent(event('diagnostic', { diagnostic: { code, detail: null } }))).toBe(
        label,
      );
    }
    expect(describeReplayEvent(event('request-started'))).toBe(REQUEST_EVENT_LABEL.started);
    expect(describeReplayEvent(event('request-ended'))).toBe(REQUEST_EVENT_LABEL.ended);
    expect(describeReplayEvent(event('sample-accepted'))).toBe('New position received');
  });

  it('labels are distinct so the list is scannable', () => {
    const all = [
      ...Object.values(TRANSPORT_EVENT_LABEL),
      ...Object.values(DIAGNOSTIC_EVENT_LABEL),
      ...Object.values(REQUEST_EVENT_LABEL),
      'New position received',
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('fetch failures add a closed, human detail and never show the raw code', () => {
    const failed = (detail: string | null) =>
      describeReplayEvent(event('diagnostic', { diagnostic: { code: 'fetch-failed', detail } }));
    expect(failed('http-503')).toBe('Request failed (HTTP 503)');
    expect(failed('http-429')).toBe('Request failed (HTTP 429)');
    expect(failed('timeout')).toBe('Request failed (timed out)');
    expect(failed('network')).toBe('Request failed (network error)');
    expect(failed('invalid-json')).toBe('Request failed (response was not valid JSON)');
    expect(failed('http-other')).toBe('Request failed (HTTP error)');
    // Unknown or malformed details fall back to the plain label; nothing raw leaks through.
    expect(failed('<img src=x>')).toBe('Request failed');
    expect(failed('http-12345')).toBe('Request failed');
    expect(failed(null)).toBe('Request failed');
  });
});

describe('Replay slider aria-valuetext', () => {
  it('recorded time, data state and age in words', () => {
    const at = T0_MS + 22_000;
    const e = event('sample-accepted', {
      wallMs: at,
      monoMs: MONO + 22_000,
      anchor: anchorAt(T0_MS),
    });
    const log: ReplayLog = { events: [e], nextSeq: 1 };
    expect(replayValueText(log, 0)).toBe('14:01:45 UTC, Delayed, position 22 seconds old');
  });

  it('fresh, just received', () => {
    const e = event('sample-accepted', { anchor: anchorAt(T0_MS) });
    expect(replayValueText({ events: [e], nextSeq: 1 }, 0)).toBe(
      '14:01:23 UTC, Fresh, position received just now',
    );
  });

  it('stale after minutes', () => {
    const e = event('diagnostic', {
      wallMs: T0_MS + 125_000,
      monoMs: MONO + 125_000,
      anchor: anchorAt(T0_MS),
      diagnostic: { code: 'fetch-failed', detail: 'http-503' },
    });
    expect(replayValueText({ events: [e], nextSeq: 1 }, 0)).toBe(
      '14:03:28 UTC, Stale, position 2 minutes old',
    );
  });

  it('no position yet', () => {
    expect(replayValueText({ events: [event('transport-changed')], nextSeq: 1 }, 0)).toBe(
      '14:01:23 UTC, Waiting, no position yet',
    );
  });

  it('unverified time: age is not stated', () => {
    const e = event('diagnostic', {
      wallMs: T0_MS + 3_600_000, // wall jumped an hour; monotonic did not
      anchor: anchorAt(T0_MS),
      diagnostic: { code: 'clock-jump-detected', detail: 'wall-mono-mismatch' },
    });
    expect(replayValueText({ events: [e], nextSeq: 1 }, 0)).toBe(
      '15:01:23 UTC, Time could not be verified, position age unknown',
    );
  });

  it('out of range index gives an empty string', () => {
    expect(replayValueText({ events: [], nextSeq: 0 }, 0)).toBe('');
  });

  it('formatUtcTime is the time part of formatUtc', () => {
    expect(formatUtcTime(T0_MS)).toBe('14:01:23 UTC');
  });
});

describe('Replay connection line', () => {
  it('reuses the live connection copy for the recorded transport', () => {
    const log: ReplayLog = {
      events: [
        event('transport-changed', { transport: 'paused', anchor: anchorAt(T0_MS) }),
        event('transport-changed', { transport: 'polling', anchor: anchorAt(T0_MS) }, 1),
      ],
      nextSeq: 2,
    };
    expect(replayConnection(log, 0)).toBe('Updates paused.');
    expect(replayConnection(log, 1)).toBe('Updates running every 5 s.');
  });

  it('a recorded 429 reads as it did then, with the countdown at that moment', () => {
    const snapshot = makeSnapshot({
      transport: 'retry-wait',
      lastFailure: { kind: 'http', status: 429, retryAfter: null, serverDateMs: null },
      nextEligibleMonoMs: MONO + 12_000,
    });
    const log: ReplayLog = { events: [event('transport-changed', { snapshot })], nextSeq: 1 };
    expect(replayConnection(log, 0)).toBe(
      'The source is limiting requests. Next attempt in 12 seconds.',
    );
  });

  it('a recorded time-unverified hold never reads as an automatic retry (R2)', () => {
    const lastFailure = {
      kind: 'http',
      status: 429,
      retryAfter: { kind: 'date', epochMs: T0_MS + 60_000 },
      serverDateMs: null,
    } as const;
    const held = makeSnapshot({
      transport: 'retry-wait',
      lastFailure,
      automaticHold: 'time-unverified',
      retryBlockedBy: 'time-unverified',
      nextEligibleMonoMs: MONO + 60_000,
    });
    const expired = makeSnapshot({
      transport: 'retry-wait',
      lastFailure,
      automaticHold: 'time-unverified',
      retryBlockedBy: null,
      nextEligibleMonoMs: null,
    });
    const log: ReplayLog = {
      events: [
        event('transport-changed', { snapshot: held }),
        event('request-ended', { snapshot: expired }, 1),
      ],
      nextSeq: 2,
    };
    expect(replayConnection(log, 0)).toBe(
      'Automatic updates paused because retry timing could not be verified.',
    );
    expect(replayConnection(log, 1)).toBe(
      'Automatic updates paused because retry timing could not be verified. Retry now is available.',
    );
    for (const i of [0, 1]) expect(replayConnection(log, i)).not.toMatch(/retrying/i);
  });

  it('a recorded blocked status names the HTTP status it had then', () => {
    const snapshot = makeSnapshot({
      transport: 'blocked',
      anchor: anchorAt(T0_MS),
      lastFailure: { kind: 'http', status: 404, retryAfter: null, serverDateMs: null },
    });
    const log: ReplayLog = { events: [event('transport-changed', { snapshot })], nextSeq: 1 };
    expect(replayConnection(log, 0)).toBe(
      'Source unavailable (HTTP 404). Automatic updates stopped.',
    );
  });
});

describe('Replay announcements', () => {
  it('entering and leaving are announced in plain words', () => {
    expect(REPLAY_ENTERED_ANNOUNCEMENT).toMatch(/replay/i);
    expect(REPLAY_ENTERED_ANNOUNCEMENT).toMatch(/not live/i);
    const live = (overrides: Partial<TrackerSnapshot>) => makeSnapshot(overrides);
    expect(backToLiveAnnouncement(true, live({ transport: 'paused' }))).toBe(
      'Back to live. Updates are still paused.',
    );
    expect(backToLiveAnnouncement(false, live({ transport: 'polling' }))).toBe(
      'Back to live. Live updates resumed.',
    );
    // Resumed, but something else still holds updates: say so, never "resumed" (R2).
    const held: Partial<TrackerSnapshot>[] = [
      { transport: 'hidden' },
      { transport: 'offline' },
      { transport: 'blocked' },
      { transport: 'retry-wait' },
      { transport: 'retry-wait', automaticHold: 'time-unverified' },
    ];
    for (const overrides of held) {
      expect(backToLiveAnnouncement(false, live(overrides))).not.toMatch(/resumed\./);
    }
    expect(
      backToLiveAnnouncement(
        false,
        live({ transport: 'retry-wait', automaticHold: 'time-unverified' }),
      ),
    ).toMatch(/use Retry/);
  });
});
