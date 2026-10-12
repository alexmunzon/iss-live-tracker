// TrackerView builders for UI tests and the dev preview. Pure data; no clocks or timers.
import {
  ISS_NORAD_ID,
  PROVIDER_ID,
  type FreshnessAnchor,
  type FreshnessView,
  type PositionSample,
  type TrackerActions,
  type TrackerSnapshot,
  type TrackerView,
  type TrailSegment,
} from '../../domain/position';
import { EMPTY_REPLAY_LOG, type ReplayLog } from '../../domain/replay';

/** 2026-10-11T14:01:23Z, same base time as the canonical fixtures. */
export const PREVIEW_T0_MS = 1791727283000;

export function previewSample(overrides: Partial<PositionSample> = {}): PositionSample {
  return {
    provider: PROVIDER_ID,
    satelliteId: ISS_NORAD_ID,
    latitudeDeg: 45.005782935448,
    longitudeDeg: -18.396323801261,
    positionTimeMs: PREVIEW_T0_MS,
    receivedAtMs: PREVIEW_T0_MS,
    ...overrides,
  };
}

export function previewAnchor(sample: PositionSample = previewSample()): FreshnessAnchor {
  return {
    sample,
    anchorWallMs: sample.receivedAtMs,
    anchorMonoMs: 1_000,
    sourceAgeAtReceiptMs: 0,
    futureSkew: false,
  };
}

export function makeSnapshot(overrides: Partial<TrackerSnapshot> = {}): TrackerSnapshot {
  return {
    transport: 'polling',
    requestInFlight: false,
    anchor: previewAnchor(),
    trail: { points: [] },
    lastFailure: null,
    consecutiveFailures: 0,
    nextEligibleMonoMs: null,
    retryBlockedBy: null,
    automaticHold: null,
    clockSuspect: false,
    diagnostics: [],
    ...overrides,
  };
}

const noop = (): void => undefined;
export const noopActions: TrackerActions = { pause: noop, resume: noop, retry: noop };

export interface ViewOverrides {
  readonly snapshot?: Partial<TrackerSnapshot>;
  readonly freshness?: Partial<FreshnessView>;
  readonly trailSegments?: readonly TrailSegment[];
  readonly secondsUntilEligible?: number | null;
  readonly replayLog?: ReplayLog;
  readonly actions?: TrackerActions;
}

export function makeView(overrides: ViewOverrides = {}): TrackerView {
  return {
    snapshot: makeSnapshot(overrides.snapshot),
    freshness: { state: 'fresh', ageMs: 5_000, clockWarning: null, ...overrides.freshness },
    trailSegments: overrides.trailSegments ?? [],
    secondsUntilEligible: overrides.secondsUntilEligible ?? null,
    replayLog: overrides.replayLog ?? EMPTY_REPLAY_LOG,
    actions: overrides.actions ?? noopActions,
  };
}

const previewTrail: readonly TrailSegment[] = [
  [
    [44.2, -21.6],
    [44.6, -20.0],
    [45.0, -18.4],
  ],
];

/** Named states for the dev preview and tests. */
export const previewViews = {
  waiting: () =>
    makeView({
      snapshot: { anchor: null, requestInFlight: true },
      freshness: { state: 'empty', ageMs: null },
    }),
  fresh: () =>
    makeView({
      trailSegments: previewTrail,
      snapshot: { retryBlockedBy: 'spacing' },
      secondsUntilEligible: 3,
    }),
  delayed: () =>
    makeView({
      freshness: { state: 'delayed', ageMs: 24_000 },
      snapshot: {
        transport: 'retry-wait',
        lastFailure: { kind: 'timeout' },
        consecutiveFailures: 1,
        retryBlockedBy: 'backoff',
      },
      secondsUntilEligible: 18,
      trailSegments: previewTrail,
    }),
  staleOffline: () =>
    makeView({
      freshness: { state: 'stale', ageMs: 84_000 },
      snapshot: { transport: 'offline', lastFailure: { kind: 'network' }, retryBlockedBy: null },
      trailSegments: previewTrail,
    }),
  blocked: () =>
    makeView({
      freshness: { state: 'stale', ageMs: 125_000 },
      snapshot: {
        transport: 'blocked',
        lastFailure: { kind: 'http', status: 404, retryAfter: null, serverDateMs: null },
      },
    }),
  paused: () =>
    makeView({
      freshness: { state: 'delayed', ageMs: 40_000 },
      snapshot: { transport: 'paused', retryBlockedBy: 'paused' },
    }),
  clockSuspect: () =>
    makeView({
      snapshot: {
        anchor: null,
        clockSuspect: true,
        transport: 'retry-wait',
        lastFailure: { kind: 'invalid-payload', rejection: 'timestamp-implausible' },
        retryBlockedBy: 'backoff',
      },
      freshness: { state: 'empty', ageMs: null },
      secondsUntilEligible: 9,
    }),
} as const;

export type PreviewViewName = keyof typeof previewViews;
