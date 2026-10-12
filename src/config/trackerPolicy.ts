// Single reviewed home for every timing, size and threshold value.
// Changing a value here is a contract change: it needs coordinator review and
// re-running the affected acceptance checks (see docs/contracts.md).

export const trackerPolicy = {
  /** Fixed, approved upstream. No query string; the app never builds other URLs. */
  endpointUrl: 'https://api.wheretheiss.at/v1/satellites/25544',

  /** Healthy request-start cadence: next start = max(lastStart + 5 s, previous settlement). */
  healthyIntervalMs: 5_000,
  /** Covers connecting, headers and reading the body. */
  requestTimeoutMs: 8_000,
  /** Bounded body read. Larger bodies are rejected without parsing. */
  maxBodyBytes: 64 * 1024,

  /** Ordinary retry baselines, measured from failure settlement. Index = consecutive failures - 1, clamped. */
  retryBaselinesMs: [10_000, 20_000, 40_000, 60_000] as const,
  /** Ordinary jittered delay never exceeds this. Server-requested waits may. */
  retryMaxMs: 60_000,
  /** delay = min(retryMaxMs, baseline * (1 + jitterFraction * r)), r in [0, 1). */
  jitterFraction: 0.2,
  /** 429 without a readable valid Retry-After waits at least this long. */
  rateLimitMinWaitMs: 60_000,
  /** G1-v2: every server-requested wait is capped at 1 hour. */
  serverWaitMaxMs: 3_600_000,
  /** G1-v2: Retry-After seconds above this are ignored as invalid. */
  retryAfterMaxSeconds: 86_400,
  /** G1-v2: browsers fire longer setTimeout delays immediately; every delay is clamped to this. */
  maxTimerDelayMs: 2_147_483_647,
  /** G1-v2: consecutive too-far-future samples that mark the local clock suspect. */
  clockSuspectStreak: 3,
  /** G1-v2: consecutive self-consistent older samples that force a re-anchor. */
  olderReanchorStreak: 3,
  /** HTTP statuses that stop automatic retry (configuration/access problem). */
  blockingStatuses: [401, 403, 404] as const,

  /** Freshness is product policy, not an accuracy claim. age <= 15 s fresh; <= 60 s delayed; else stale. */
  freshMaxAgeMs: 15_000,
  delayedMaxAgeMs: 60_000,
  /**
   * Samples at most this far ahead of local time count as on time (no skew warning, can be fresh).
   * The provider's timestamp has 1 s resolution and device clocks drift slightly, so a real,
   * current sample often arrives up to ~1 s "in the future" (observed live, 2026-10-11).
   */
  futureSkewToleranceMs: 2_000,
  /** A sample up to 30 s in the future is kept with a clock-skew warning; beyond that it is rejected. */
  maxFutureSkewMs: 30_000,
  /** Wall vs monotonic elapsed-time mismatch beyond this marks freshness unverified. */
  clockMismatchThresholdMs: 5_000,

  /** Plausibility bounds for the provider's Unix-seconds timestamp. */
  minTimestampSec: 946_684_800, // 2000-01-01T00:00:00Z
  /** Values at or above this in a seconds field are treated as milliseconds and rejected. */
  millisecondsHeuristicSec: 100_000_000_000,

  /** Observed session trail bounds. */
  trailMaxPoints: 120,
  trailMaxAgeMs: 10 * 60_000,
  /** A gap in position time larger than this starts a new trail segment. */
  trailGapSplitMs: 30_000,

  /** Bounded diagnostics ring kept in the snapshot. */
  diagnosticsLimit: 20,

  /**
   * Mission Replay (session-only, in memory): how far back a visitor can scrub, in monotonic
   * time measured from the newest recorded event.
   */
  replayWindowMs: 10 * 60_000,
  /** Mission Replay: at most this many events are kept (newest win), whatever the window. */
  replayMaxEvents: 600,

  /** Display refresh for the age text. Not a network timer. */
  ageDisplayTickMs: 1_000,

  /** Map tiles: OpenStreetMap Standard, used under its tile usage policy. */
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileMaxZoom: 19,
  tileAttributionHref: 'https://www.openstreetmap.org/copyright',
  tileAttributionText: '© OpenStreetMap contributors',

  /** Source credit shown in the UI. */
  providerName: 'Where the ISS at',
  providerHref: 'https://wheretheiss.at/',
} as const;

export type TrackerPolicy = typeof trackerPolicy;
