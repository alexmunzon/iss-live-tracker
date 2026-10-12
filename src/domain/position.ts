// Shared contracts (coordinator-owned, frozen at G1).
// Workers implement against these types; changes go through the coordinator.
// Semantics are documented in docs/contracts.md.

// ---------------------------------------------------------------------------
// Identity and normalized sample
// ---------------------------------------------------------------------------

export const PROVIDER_ID = 'where-the-iss-at';
export const ISS_NORAD_ID = 25544;

export type ProviderId = typeof PROVIDER_ID;
export type SatelliteId = typeof ISS_NORAD_ID;

/** Serializable, validated position. Contains no monotonic timing anchors. */
export interface PositionSample {
  readonly provider: ProviderId;
  readonly satelliteId: SatelliteId;
  /** Finite, [-90, 90]. */
  readonly latitudeDeg: number;
  /** Finite, [-180, 180]. */
  readonly longitudeDeg: number;
  /** Provider calculation time: documented Unix seconds × 1000, converted once. Integer. */
  readonly positionTimeMs: number;
  /** Local wall-clock receipt time. Diagnostics only; never a substitute for positionTimeMs. */
  readonly receivedAtMs: number;
  /** Present only when finite, plausible and provider units are kilometers. */
  readonly altitudeKm?: number;
  /** Present only when finite, plausible and provider units are kilometers (km/h). */
  readonly velocityKmh?: number;
}

/** [latitude, longitude] in Leaflet order. Never GeoJSON order. */
export type LatLngTuple = readonly [latDeg: number, lonDeg: number];

// ---------------------------------------------------------------------------
// Injected environment (deterministic in tests)
// ---------------------------------------------------------------------------

export interface Clock {
  /** Wall time in ms since the Unix epoch (Date.now()). May jump. */
  wallNowMs(): number;
  /** Monotonic ms (performance.now()). Never jumps backwards. */
  monotonicNowMs(): number;
}

export type TimerHandle = unknown;

export interface TimerApi {
  set(callback: () => void, delayMs: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

/** Returns r in [0, 1). */
export type RandomSource = () => number;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// Validation (pure: unknown JSON -> sample)
// ---------------------------------------------------------------------------

export type ValidationRejection =
  | 'not-an-object'
  | 'wrong-identity'
  | 'invalid-latitude'
  | 'invalid-longitude'
  | 'invalid-timestamp'
  | 'timestamp-looks-like-milliseconds'
  | 'timestamp-implausible';

export type OptionalFieldIssue = 'altitude-invalid' | 'velocity-invalid' | 'units-not-kilometers';

export type ValidationResult =
  | {
      readonly ok: true;
      readonly sample: PositionSample;
      readonly issues: readonly OptionalFieldIssue[];
    }
  | { readonly ok: false; readonly rejection: ValidationRejection };

/** Implemented in src/domain/validatePosition.ts. receivedAtMs is the wall clock at receipt. */
export type ValidatePosition = (raw: unknown, receivedAtMs: number) => ValidationResult;

// ---------------------------------------------------------------------------
// Provider client (one request; HTTP, timeout, body limit)
// ---------------------------------------------------------------------------

export type RetryAfter =
  | { readonly kind: 'seconds'; readonly seconds: number }
  | { readonly kind: 'date'; readonly epochMs: number };

export type FetchFailure =
  /** Our 8 s timeout fired (before headers or during body). */
  | { readonly kind: 'timeout' }
  /** fetch rejected: DNS, TLS, CORS, connection reset. */
  | { readonly kind: 'network' }
  /** Caller's signal aborted (lifecycle). Never an outage. */
  | { readonly kind: 'aborted' }
  | { readonly kind: 'redirect' }
  | {
      readonly kind: 'http';
      readonly status: number;
      /** null when absent, invalid or not readable cross-origin. */
      readonly retryAfter: RetryAfter | null;
      /** Parsed response Date header in epoch ms, or null when unreadable. */
      readonly serverDateMs: number | null;
    }
  | { readonly kind: 'unexpected-content-type' }
  | { readonly kind: 'body-too-large' }
  | { readonly kind: 'body-read-failed' }
  | { readonly kind: 'invalid-json' }
  | { readonly kind: 'invalid-payload'; readonly rejection: ValidationRejection };

export type FetchOutcome =
  | {
      readonly ok: true;
      readonly sample: PositionSample;
      readonly issues: readonly OptionalFieldIssue[];
    }
  | { readonly ok: false; readonly failure: FetchFailure };

export interface IssClient {
  /** Never throws. Resolves to a typed outcome. Aborting `signal` yields { kind: 'aborted' }. */
  fetchPosition(signal: AbortSignal): Promise<FetchOutcome>;
}

export interface IssClientDeps {
  readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly timers: TimerApi;
}

// ---------------------------------------------------------------------------
// Ordering and freshness (pure)
// ---------------------------------------------------------------------------

export type AcceptanceDecision =
  | 'accept'
  /** Same positionTimeMs and same coordinates: no state change, no age reset. */
  | 'duplicate'
  /** Same positionTimeMs, different coordinates: keep current, record diagnostic. */
  | 'conflict'
  /** positionTimeMs older than the accepted sample. */
  | 'older'
  /** More than maxFutureSkewMs ahead of local wall time. */
  | 'too-far-future';

/** Timing anchor captured when a sample is accepted. Not serialized. */
export interface FreshnessAnchor {
  readonly sample: PositionSample;
  /** Wall clock at acceptance. */
  readonly anchorWallMs: number;
  /** Monotonic clock at acceptance. */
  readonly anchorMonoMs: number;
  /** wall-at-receipt − positionTimeMs, clamped to >= 0. */
  readonly sourceAgeAtReceiptMs: number;
  /** True when positionTimeMs was ahead of local wall time (within maxFutureSkewMs). */
  readonly futureSkew: boolean;
}

export type DataState = 'empty' | 'fresh' | 'delayed' | 'stale' | 'unverified';

export type ClockWarning = 'future-skew' | 'time-unverified';

export interface FreshnessView {
  readonly state: DataState;
  /** sourceAgeAtReceiptMs + monotonic elapsed since anchor. null when empty. */
  readonly ageMs: number | null;
  /** Present when age cannot be trusted or the sample was future-dated. */
  readonly clockWarning: ClockWarning | null;
}

// ---------------------------------------------------------------------------
// Observed session trail (pure)
// ---------------------------------------------------------------------------

export interface TrailPoint {
  readonly latDeg: number;
  readonly lonDeg: number;
  readonly positionTimeMs: number;
}

export interface TrailState {
  /** Oldest first. <= trailMaxPoints and spanning <= trailMaxAgeMs of position time. */
  readonly points: readonly TrailPoint[];
}

/** One drawable polyline. Never crosses the antimeridian or a long gap. */
export type TrailSegment = readonly LatLngTuple[];

// ---------------------------------------------------------------------------
// Scheduler (single owner of timers, the active request and deadlines)
// ---------------------------------------------------------------------------

export type TransportStatus =
  /** Created, start() not called yet. */
  | 'idle'
  /** Healthy cadence (a request may or may not be in flight). */
  | 'polling'
  /** Waiting out an ordinary backoff or a server-requested delay. */
  | 'retry-wait'
  /** User pressed Pause. Survives visibility and network events. */
  | 'paused'
  /** Tab hidden; work aborted. */
  | 'hidden'
  /** navigator.onLine hint says offline. */
  | 'offline'
  /** Definitive source/config error (401/403/404 or other non-retryable 4xx). No automatic retry. */
  | 'blocked';

/** Date-form Retry-After with an untrusted clock and no readable server Date: manual Retry only. */
export type AutomaticHoldReason = 'time-unverified';

export type RetryBlockReason =
  | 'in-flight'
  /** Less than healthyIntervalMs since the previous request start. */
  | 'spacing'
  /** Ordinary backoff deadline not reached. */
  | 'backoff'
  /** Server-requested (Retry-After / 429 minimum) deadline not reached. */
  | 'server-wait'
  /** Date-form Retry-After with an untrusted clock and no readable server Date. */
  | 'time-unverified'
  | 'paused'
  | 'hidden';

export type DiagnosticCode =
  | 'conflicting-sample'
  | 'older-sample-ignored'
  | 'future-sample-rejected'
  | 'future-skew-accepted'
  | 'optional-field-dropped'
  | 'clock-jump-detected'
  | 'late-result-ignored'
  | 'fetch-failed';

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly atWallMs: number;
  readonly detail?: string;
}

/** Immutable. A new object is produced on every change; same reference otherwise. */
export interface TrackerSnapshot {
  readonly transport: TransportStatus;
  readonly requestInFlight: boolean;
  /** Last accepted sample with its timing anchor, kept through failures. */
  readonly anchor: FreshnessAnchor | null;
  readonly trail: TrailState;
  /** Most recent failure since the last validated response; null after recovery. */
  readonly lastFailure: FetchFailure | null;
  readonly consecutiveFailures: number;
  /** Monotonic time at which the next request may start, or null when none is scheduled. */
  readonly nextEligibleMonoMs: number | null;
  /** Why Retry cannot run right now; null when Retry would start a request immediately. */
  readonly retryBlockedBy: RetryBlockReason | null;
  /**
   * Why automatic requests are held until a manual Retry, independent of retryBlockedBy;
   * null when the scheduler may poll on its own. Survives the server deadline.
   */
  readonly automaticHold: AutomaticHoldReason | null;
  /** Set when a wall/monotonic jump was observed and not yet resolved by a fresh accept. */
  readonly clockSuspect: boolean;
  /** Bounded ring, newest last, <= diagnosticsLimit. */
  readonly diagnostics: readonly Diagnostic[];
}

export interface PollingScheduler {
  /** Idempotent. Issues the first request immediately when visible, online and not paused. */
  start(): void;
  /** Aborts the active request, clears every timer, drops listeners. Idempotent. Late results are ignored. */
  dispose(): void;
  getSnapshot(): TrackerSnapshot;
  subscribe(listener: () => void): () => void;
  pause(): void;
  resume(): void;
  /** Starts one request only when eligible; otherwise a no-op (see retryBlockedBy). Never queues. */
  retryNow(): void;
  setVisible(visible: boolean): void;
  setOnlineHint(online: boolean): void;
}

export interface PollingSchedulerDeps {
  readonly client: IssClient;
  readonly clock: Clock;
  readonly timers: TimerApi;
  readonly random: RandomSource;
  readonly initialVisible: boolean;
  readonly initialOnline: boolean;
}

// ---------------------------------------------------------------------------
// React adapter and view props
// ---------------------------------------------------------------------------

export interface TrackerActions {
  pause(): void;
  resume(): void;
  retry(): void;
}

/** Return type of useTracker(). */
export interface TrackerView {
  readonly snapshot: TrackerSnapshot;
  /** Recomputed on each display tick (ageDisplayTickMs). */
  readonly freshness: FreshnessView;
  /** Trail split into drawable segments (antimeridian and gap splits applied). */
  readonly trailSegments: readonly TrailSegment[];
  /** Monotonic ms remaining until nextEligibleMonoMs, rounded up to whole seconds; null if none. */
  readonly secondsUntilEligible: number | null;
  readonly actions: TrackerActions;
}

export type MapStatus = 'loading' | 'ready' | 'tiles-failing' | 'init-failed';

export interface IssMapProps {
  /** null until the first accepted sample: no marker is drawn. */
  readonly position: LatLngTuple | null;
  readonly trailSegments: readonly TrailSegment[];
  /** When true, the map pans to each new position without changing the user's zoom. */
  readonly follow: boolean;
  /** Called on user drag, keyboard pan or manual zoom. Never on programmatic movement. */
  readonly onUserMoved: () => void;
  /** Incremented by the parent to request a recenter on the current position. */
  readonly recenterToken: number;
  readonly onStatusChange: (status: MapStatus) => void;
}

export interface StatusPanelProps {
  readonly view: TrackerView;
  readonly follow: boolean;
  readonly mapStatus: MapStatus;
  readonly onRecenter: () => void;
}
