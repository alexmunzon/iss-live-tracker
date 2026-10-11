import { describe, expect, it } from 'vitest';
import {
  describeConnection,
  describeRetryBlock,
  formatAge,
  formatCoordinates,
  formatLatitude,
  formatLongitude,
  formatUtc,
  showClockSuspect,
} from '../../../src/features/status/format';
import { announcementFor } from '../../../src/features/status/announce';
import { makeSnapshot, makeView } from '../../../src/features/status/fixtures';
import { T0_MS } from '../../fixtures/canonical/index';

describe('A15 formatting helpers', () => {
  it('coordinates use 2 decimals with N/S and E/W', () => {
    expect(formatCoordinates(45.005782935448, -18.396323801261)).toBe('45.01° N, 18.40° W');
    expect(formatCoordinates(-33.9, 151.2)).toBe('33.90° S, 151.20° E');
    expect(formatLatitude(-0.001)).toBe('0.00°');
  });

  it('0° and ±180° carry no hemisphere letter', () => {
    expect(formatLatitude(0)).toBe('0.00°');
    expect(formatLongitude(0)).toBe('0.00°');
    expect(formatLongitude(-0)).toBe('0.00°');
    expect(formatLongitude(180)).toBe('180.00°');
    expect(formatLongitude(-180)).toBe('180.00°');
    expect(formatLongitude(179.999)).toBe('180.00°');
    expect(formatLongitude(179.99)).toBe('179.99° E');
    expect(formatLatitude(90)).toBe('90.00°');
  });

  it('latitude beyond the Mercator limit stays truthful (not clamped)', () => {
    expect(formatLatitude(86.5)).toBe('86.50° N');
  });

  it('UTC time format', () => {
    expect(formatUtc(T0_MS)).toBe('14:01:23 UTC, 11 Oct 2026');
    expect(formatUtc(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('03:04:05 UTC, 2 Jan 2026');
    expect(formatUtc(Number.NaN)).toBe('Unknown time');
  });

  it.each([
    [0, 'just now'],
    [999, 'just now'],
    [1_000, '1 second ago'],
    [5_000, '5 seconds ago'],
    [59_000, '59 seconds ago'],
    [59_999, '59 seconds ago'],
    [60_000, '1 minute ago'],
    [120_000, '2 minutes ago'],
    [3_599_000, '59 minutes ago'],
    [3_600_000, '1 hour ago'],
    [-5_000, 'just now'],
  ])('age %i ms → %s', (ms, words) => {
    expect(formatAge(ms)).toBe(words);
  });
});

describe('connection and retry text', () => {
  const fresh = { state: 'fresh', ageMs: 24_000, clockWarning: null } as const;

  it('offline names how long ago the last position was calculated', () => {
    const snap = makeSnapshot({ transport: 'offline' });
    expect(describeConnection(snap, fresh, null)).toBe(
      'Offline. Last position calculated 24 seconds ago.',
    );
  });

  it('retry wait shows the countdown', () => {
    const snap = makeSnapshot({ transport: 'retry-wait', lastFailure: { kind: 'timeout' } });
    expect(describeConnection(snap, fresh, 18)).toBe('Connection problem, retrying in 18 s');
  });

  it('R2 time-unverified hold: Retry waits before the deadline, Retry available after', () => {
    const limited = {
      kind: 'http',
      status: 429,
      retryAfter: { kind: 'date', epochMs: T0_MS + 120_000 },
      serverDateMs: null,
    } as const;
    const waiting = makeSnapshot({
      transport: 'retry-wait',
      lastFailure: limited,
      automaticHold: 'time-unverified',
      retryBlockedBy: 'time-unverified',
      clockSuspect: true,
    });
    expect(describeConnection(waiting, fresh, 42)).toBe(
      'The source asked us to wait, but this device’s clock could not be verified. Automatic retry paused.',
    );
    const expired = makeSnapshot({
      transport: 'retry-wait',
      lastFailure: limited,
      automaticHold: 'time-unverified',
      retryBlockedBy: null,
      clockSuspect: true,
    });
    const text = describeConnection(expired, fresh, null);
    expect(text).toBe(
      'This device’s clock could not be verified, so automatic updates are paused. Retry is available now.',
    );
    expect(text).not.toMatch(/retrying/i);
    // Without the hold, an ordinary 429 still counts down.
    const ordinary = makeSnapshot({ transport: 'retry-wait', lastFailure: limited });
    expect(describeConnection(ordinary, fresh, 30)).toBe(
      'The source is limiting requests, retrying in 30 s',
    );
  });

  it('blocked names the HTTP status', () => {
    const snap = makeSnapshot({
      transport: 'blocked',
      lastFailure: { kind: 'http', status: 404, retryAfter: null, serverDateMs: null },
    });
    expect(describeConnection(snap, fresh, null)).toBe(
      'Source unavailable (HTTP 404). Automatic retry stopped.',
    );
  });

  it('paused', () => {
    expect(describeConnection(makeSnapshot({ transport: 'paused' }), fresh, null)).toBe('Paused');
  });

  it('retry block reasons include the countdown', () => {
    expect(describeRetryBlock('backoff', 12)).toBe(
      'Waiting before trying again. Available in 12 s.',
    );
    expect(describeRetryBlock('paused', null)).toBe('Resume updates to retry.');
  });
});

describe('G1-v2 clock suspect', () => {
  it('shows with no anchor, or after a timestamp-implausible rejection', () => {
    expect(showClockSuspect(makeSnapshot({ clockSuspect: true, anchor: null }))).toBe(true);
    expect(
      showClockSuspect(
        makeSnapshot({
          clockSuspect: true,
          lastFailure: { kind: 'invalid-payload', rejection: 'timestamp-implausible' },
        }),
      ),
    ).toBe(true);
    expect(showClockSuspect(makeSnapshot({ clockSuspect: true }))).toBe(false);
    expect(showClockSuspect(makeSnapshot({ clockSuspect: false, anchor: null }))).toBe(false);
  });
});

describe('announcement policy', () => {
  const base = { hasPosition: true, data: 'fresh', transport: 'polling' } as const;
  it.each([
    [{ ...base, hasPosition: false, data: 'empty' }, base, 'First position received.'],
    [base, { ...base, data: 'delayed' }, 'Position data is delayed.'],
    [base, { ...base, data: 'stale' }, 'Position data is stale.'],
    [{ ...base, data: 'stale' }, base, 'Position data is current again.'],
    [base, { ...base, transport: 'offline' }, 'Offline.'],
    [{ ...base, transport: 'offline' }, base, 'Connection recovered.'],
    [base, { ...base, transport: 'blocked' }, 'Source unavailable. Automatic retry stopped.'],
    [base, { ...base, transport: 'paused' }, 'Updates paused.'],
    [{ ...base, transport: 'paused' }, base, 'Updates resumed.'],
  ] as const)('%o → %o', (prev, next, text) => {
    expect(announcementFor(prev, next)).toBe(text);
  });

  it('says nothing for hidden ↔ polling or a no-op', () => {
    expect(announcementFor(base, { ...base, transport: 'hidden' })).toBeNull();
    expect(announcementFor(base, base)).toBeNull();
    expect(makeView().freshness.state).toBe('fresh');
  });
});
