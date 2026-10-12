// The single owner of request timing, the active request and every deadline
// (docs/contracts.md §5, amended by G1-v2). All time comes from the injected Clock/TimerApi.

import { trackerPolicy } from '../config/trackerPolicy';
import { createAnchor, decideAcceptance } from '../domain/freshness';
import type {
  Diagnostic,
  DiagnosticCode,
  FetchFailure,
  FetchOutcome,
  FreshnessAnchor,
  OptionalFieldIssue,
  PollingScheduler,
  PollingSchedulerDeps,
  PositionSample,
  RetryBlockReason,
  TimerHandle,
  TrackerSnapshot,
  TrailState,
  TransportStatus,
} from '../domain/position';
import { appendTrail, EMPTY_TRAIL } from '../domain/trail';

/** G1-v2: every server-requested wait is capped at 1 hour. */
export const SERVER_WAIT_MAX_MS = trackerPolicy.serverWaitMaxMs;
/** G1-v2: browsers fire longer setTimeout delays immediately; clamp every delay. */
export const MAX_TIMER_DELAY_MS = trackerPolicy.maxTimerDelayMs;
/** G1-v2: consecutive too-far-future results that mark the local clock suspect. */
export const CLOCK_SUSPECT_STREAK = trackerPolicy.clockSuspectStreak;
/** G1-v2: consecutive self-consistent 'older' results that force a re-anchor. */
export const OLDER_REANCHOR_STREAK = trackerPolicy.olderReanchorStreak;

/** Closed set of diagnostic details. Never remote content. Each ≤ 40 characters. */
type DiagnosticDetail =
  | 'wall-mono-mismatch'
  | 'future-streak'
  | 'reanchored-older-streak'
  | 'timeout'
  | 'network'
  | 'redirect'
  | `http-${number}`
  | 'http-other'
  | 'unexpected-content-type'
  | 'body-too-large'
  | 'body-read-failed'
  | 'invalid-json'
  | 'invalid-payload'
  | 'too-far-future'
  | 'units-not-kilometers'
  | 'altitude-invalid'
  | 'velocity-invalid'
  | 'altitude-invalid,velocity-invalid';

/** Too-far-future has no rejection code of its own in G1; this is the agreed stand-in. */
const FUTURE_FAILURE: FetchFailure = {
  kind: 'invalid-payload',
  rejection: 'timestamp-implausible',
};

function failureDetail(failure: FetchFailure): DiagnosticDetail {
  switch (failure.kind) {
    case 'http':
      return Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599
        ? `http-${failure.status}`
        : 'http-other';
    case 'aborted':
      return 'network';
    default:
      return failure.kind;
  }
}

function issuesDetail(issues: readonly OptionalFieldIssue[]): DiagnosticDetail | null {
  const has = (issue: OptionalFieldIssue): boolean => issues.includes(issue);
  if (has('units-not-kilometers')) return 'units-not-kilometers';
  if (has('altitude-invalid') && has('velocity-invalid'))
    return 'altitude-invalid,velocity-invalid';
  if (has('altitude-invalid')) return 'altitude-invalid';
  if (has('velocity-invalid')) return 'velocity-invalid';
  return null;
}

function isBlockingStatus(status: number): boolean {
  if ((trackerPolicy.blockingStatuses as readonly number[]).includes(status)) return true;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function clampTimerDelay(ms: number): number {
  if (!Number.isFinite(ms)) return ms > 0 ? MAX_TIMER_DELAY_MS : 0;
  return Math.min(MAX_TIMER_DELAY_MS, Math.max(0, Math.ceil(ms)));
}

type Mode = 'normal' | 'retry' | 'blocked';

interface InFlight {
  readonly generation: number;
  readonly controller: AbortController;
}

export function createPollingScheduler(deps: PollingSchedulerDeps): PollingScheduler {
  const { client, clock, timers, random } = deps;
  const listeners = new Set<() => void>();

  // Lifecycle and environment
  let started = false;
  let disposed = false;
  let visible = deps.initialVisible;
  let online = deps.initialOnline;
  let paused = false;
  let generation = 0;

  // Request and timing
  let inFlight: InFlight | null = null;
  let wakeHandle: TimerHandle | null = null;
  let wakeArmed = false;
  let lastStartMono: number | null = null;
  let backoffUntilMono: number | null = null;
  let serverUntilMono: number | null = null;
  /** Date-form 429 with an untrusted clock: no automatic retry until a request is made. */
  let timeUnverifiedHold = false;
  let mode: Mode = 'normal';

  // Data
  let anchor: FreshnessAnchor | null = null;
  let trail: TrailState = EMPTY_TRAIL;
  let lastFailure: FetchFailure | null = null;
  let consecutiveFailures = 0;
  let clockSuspect = false;
  let diagnostics: readonly Diagnostic[] = [];
  let lastIssuesDetail: DiagnosticDetail | null = null;

  // Clock checks and streaks
  let lastCheckWall: number | null = null;
  let lastCheckMono: number | null = null;
  let futureStreak = 0;
  let olderStreak: PositionSample[] = [];

  let snapshot: TrackerSnapshot = buildSnapshot();

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  function eligibleAtMono(): number {
    let at = Number.NEGATIVE_INFINITY;
    if (lastStartMono !== null) at = Math.max(at, lastStartMono + trackerPolicy.healthyIntervalMs);
    if (backoffUntilMono !== null) at = Math.max(at, backoffUntilMono);
    if (serverUntilMono !== null) at = Math.max(at, serverUntilMono);
    return at;
  }

  function automaticAllowed(): boolean {
    return (
      started &&
      !disposed &&
      !paused &&
      visible &&
      online &&
      mode !== 'blocked' &&
      !timeUnverifiedHold
    );
  }

  function transport(): TransportStatus {
    if (!started) return 'idle';
    if (paused) return 'paused';
    if (!visible) return 'hidden';
    if (!online) return 'offline';
    if (mode === 'blocked') return 'blocked';
    if (mode === 'retry' || timeUnverifiedHold) return 'retry-wait';
    return 'polling';
  }

  function retryBlockedBy(now: number): RetryBlockReason | null {
    if (!started || disposed) return null;
    if (paused) return 'paused';
    if (!visible) return 'hidden';
    if (inFlight !== null) return 'in-flight';
    if (serverUntilMono !== null && now < serverUntilMono) {
      return timeUnverifiedHold ? 'time-unverified' : 'server-wait';
    }
    if (backoffUntilMono !== null && now < backoffUntilMono) return 'backoff';
    if (lastStartMono !== null && now < lastStartMono + trackerPolicy.healthyIntervalMs) {
      return 'spacing';
    }
    return null;
  }

  function nextEligible(now: number): number | null {
    if (!started || disposed || paused || !visible || inFlight !== null) return null;
    const at = eligibleAtMono();
    if (automaticAllowed()) return Number.isFinite(at) ? Math.max(at, now) : now;
    // Manual-only modes (offline, blocked, time-unverified): a countdown while Retry waits.
    return at > now ? at : null;
  }

  function buildSnapshot(): TrackerSnapshot {
    const now = clock.monotonicNowMs();
    return {
      transport: transport(),
      requestInFlight: inFlight !== null,
      anchor,
      trail,
      lastFailure,
      consecutiveFailures,
      nextEligibleMonoMs: nextEligible(now),
      retryBlockedBy: retryBlockedBy(now),
      automaticHold: timeUnverifiedHold ? 'time-unverified' : null,
      clockSuspect,
      diagnostics,
    };
  }

  function sameSnapshot(a: TrackerSnapshot, b: TrackerSnapshot): boolean {
    return (
      a.transport === b.transport &&
      a.requestInFlight === b.requestInFlight &&
      a.anchor === b.anchor &&
      a.trail === b.trail &&
      a.lastFailure === b.lastFailure &&
      a.consecutiveFailures === b.consecutiveFailures &&
      a.nextEligibleMonoMs === b.nextEligibleMonoMs &&
      a.retryBlockedBy === b.retryBlockedBy &&
      a.automaticHold === b.automaticHold &&
      a.clockSuspect === b.clockSuspect &&
      a.diagnostics === b.diagnostics
    );
  }

  function commit(): void {
    if (disposed) return;
    const next = buildSnapshot();
    if (sameSnapshot(snapshot, next)) return;
    snapshot = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        // One broken listener must not corrupt scheduler state or starve the others.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  function addDiagnostic(code: DiagnosticCode, detail?: DiagnosticDetail): void {
    const entry: Diagnostic =
      detail === undefined
        ? { code, atWallMs: clock.wallNowMs() }
        : { code, atWallMs: clock.wallNowMs(), detail };
    diagnostics = [...diagnostics, entry].slice(-trackerPolicy.diagnosticsLimit);
  }

  // -------------------------------------------------------------------------
  // Timers and requests
  // -------------------------------------------------------------------------

  function clearWake(): void {
    if (wakeArmed) timers.clear(wakeHandle);
    wakeArmed = false;
    wakeHandle = null;
  }

  function armWake(atMono: number): void {
    clearWake();
    wakeHandle = timers.set(onWake, clampTimerDelay(atMono - clock.monotonicNowMs()));
    wakeArmed = true;
  }

  function onWake(): void {
    wakeArmed = false;
    wakeHandle = null;
    if (disposed) return;
    checkClock();
    // Re-checks every deadline against the monotonic clock: an early or clamped fire re-arms.
    reschedule();
  }

  /** Decide what happens next. Starts at most one request; otherwise arms at most one wake. */
  function reschedule(): void {
    if (disposed) return;
    if (!started || paused || !visible || inFlight !== null) {
      clearWake();
      commit();
      return;
    }
    const now = clock.monotonicNowMs();
    const at = eligibleAtMono();
    if (automaticAllowed() && at <= now) {
      startRequest();
      return;
    }
    // Automatic: wake at the deadline. Manual-only: wake when Retry becomes available.
    if (at > now) armWake(at);
    else clearWake();
    commit();
  }

  function abortActive(): void {
    generation += 1;
    if (inFlight !== null) {
      inFlight.controller.abort();
      inFlight = null;
    }
  }

  function startRequest(): void {
    clearWake();
    const controller = new AbortController();
    const requestGeneration = generation;
    inFlight = { generation: requestGeneration, controller };
    lastStartMono = clock.monotonicNowMs();
    timeUnverifiedHold = false;
    commit();

    let pending: Promise<FetchOutcome>;
    try {
      pending = client.fetchPosition(controller.signal);
    } catch {
      pending = Promise.resolve({ ok: false, failure: { kind: 'network' } });
    }
    pending.then(
      (outcome) => onSettled(requestGeneration, outcome),
      () => onSettled(requestGeneration, { ok: false, failure: { kind: 'network' } }),
    );
  }

  function checkClock(): void {
    const wall = clock.wallNowMs();
    const mono = clock.monotonicNowMs();
    if (lastCheckWall !== null && lastCheckMono !== null) {
      const drift = wall - lastCheckWall - (mono - lastCheckMono);
      if (Math.abs(drift) > trackerPolicy.clockMismatchThresholdMs) {
        clockSuspect = true;
        addDiagnostic('clock-jump-detected', 'wall-mono-mismatch');
      }
    }
    lastCheckWall = wall;
    lastCheckMono = mono;
  }

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------

  function onSettled(requestGeneration: number, outcome: FetchOutcome): void {
    if (disposed) return;
    if (requestGeneration !== generation || inFlight?.generation !== requestGeneration) {
      // Never changes transport, data, failures or deadlines.
      addDiagnostic('late-result-ignored');
      commit();
      return;
    }
    inFlight = null;
    checkClock();

    if (outcome.ok) {
      const decision = decideAcceptance(anchor?.sample ?? null, outcome.sample, clock.wallNowMs());
      if (decision === 'too-far-future') onTooFarFuture();
      else onValidated(decision, outcome.sample, outcome.issues);
    } else if (outcome.failure.kind !== 'aborted') {
      futureStreak = 0;
      onFailure(outcome.failure);
    }
    reschedule();
  }

  function markValidated(): void {
    consecutiveFailures = 0;
    lastFailure = null;
    backoffUntilMono = null;
    mode = 'normal';
    futureStreak = 0;
  }

  function acceptSample(sample: PositionSample, freshTrail: boolean): void {
    anchor = createAnchor(sample, clock);
    trail = appendTrail(freshTrail ? EMPTY_TRAIL : trail, sample);
    clockSuspect = false;
    olderStreak = [];
    if (anchor.futureSkew) addDiagnostic('future-skew-accepted');
  }

  function onValidated(
    decision: 'accept' | 'duplicate' | 'conflict' | 'older',
    sample: PositionSample,
    issues: readonly OptionalFieldIssue[],
  ): void {
    markValidated();
    if (decision !== 'older') olderStreak = [];

    switch (decision) {
      case 'accept': {
        acceptSample(sample, false);
        const detail = issuesDetail(issues);
        if (detail !== null && detail !== lastIssuesDetail) {
          addDiagnostic('optional-field-dropped', detail);
        }
        lastIssuesDetail = detail;
        break;
      }
      case 'duplicate':
        break;
      case 'conflict':
        addDiagnostic('conflicting-sample');
        break;
      case 'older':
        onOlder(sample);
        break;
    }
  }

  function onOlder(sample: PositionSample): void {
    const previous = olderStreak[olderStreak.length - 1];
    olderStreak =
      previous !== undefined && sample.positionTimeMs > previous.positionTimeMs
        ? [...olderStreak, sample].slice(-OLDER_REANCHOR_STREAK)
        : [sample];
    const consistent = olderStreak.length >= OLDER_REANCHOR_STREAK;
    const nearWall =
      Math.abs(sample.positionTimeMs - clock.wallNowMs()) <= trackerPolicy.maxFutureSkewMs;
    if (consistent && nearWall) {
      // A bad (future-dated) anchor must not freeze the marker forever.
      acceptSample(sample, true);
      addDiagnostic('clock-jump-detected', 'reanchored-older-streak');
    } else {
      addDiagnostic('older-sample-ignored');
    }
  }

  function onTooFarFuture(): void {
    addDiagnostic('future-sample-rejected');
    futureStreak += 1;
    if (futureStreak === CLOCK_SUSPECT_STREAK) {
      clockSuspect = true;
      addDiagnostic('clock-jump-detected', 'future-streak');
    }
    recordFailure(FUTURE_FAILURE, 'too-far-future');
    backoffUntilMono = clock.monotonicNowMs() + ordinaryDelay();
    mode = 'retry';
  }

  function ordinaryDelay(): number {
    const baselines = trackerPolicy.retryBaselinesMs;
    const index = Math.min(Math.max(consecutiveFailures, 1) - 1, baselines.length - 1);
    const baseline = baselines[index] ?? trackerPolicy.retryMaxMs;
    const raw = random();
    const r = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0;
    return Math.min(trackerPolicy.retryMaxMs, baseline * (1 + trackerPolicy.jitterFraction * r));
  }

  function recordFailure(failure: FetchFailure, detail: DiagnosticDetail): void {
    consecutiveFailures += 1;
    lastFailure = failure;
    addDiagnostic('fetch-failed', detail);
  }

  function onFailure(failure: FetchFailure): void {
    recordFailure(failure, failureDetail(failure));
    const settle = clock.monotonicNowMs();

    if (failure.kind === 'http' && isBlockingStatus(failure.status)) {
      mode = 'blocked';
      backoffUntilMono = null;
      return;
    }
    const ordinary = ordinaryDelay();
    mode = 'retry';

    if (failure.kind !== 'http' || failure.status !== 429) {
      backoffUntilMono = settle + ordinary;
      return;
    }

    // 429: server-requested wait, never shortened by our backoff, capped at one hour.
    backoffUntilMono = null;
    const retryAfter = failure.retryAfter;
    let wait: number;
    if (retryAfter === null) {
      wait = Math.max(ordinary, trackerPolicy.rateLimitMinWaitMs);
    } else if (retryAfter.kind === 'seconds') {
      wait = Math.max(ordinary, retryAfter.seconds * 1000);
    } else if (clockSuspect && failure.serverDateMs === null) {
      timeUnverifiedHold = true;
      wait = Math.max(ordinary, trackerPolicy.rateLimitMinWaitMs);
    } else {
      const reference = failure.serverDateMs ?? clock.wallNowMs();
      wait = Math.max(ordinary, retryAfter.epochMs - reference); // A past date → ordinary only.
    }
    const deadline = settle + Math.min(wait, SERVER_WAIT_MAX_MS);
    serverUntilMono = serverUntilMono === null ? deadline : Math.max(serverUntilMono, deadline);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function onEnvironmentWake(): void {
    checkClock();
    reschedule();
  }

  return {
    start() {
      if (disposed || started) return;
      started = true;
      lastCheckWall = clock.wallNowMs();
      lastCheckMono = clock.monotonicNowMs();
      reschedule();
    },

    dispose() {
      if (disposed) return;
      abortActive();
      clearWake();
      disposed = true;
      listeners.clear();
      // Final, listener-free snapshot: nothing in flight, nothing scheduled.
      snapshot = { ...snapshot, requestInFlight: false, nextEligibleMonoMs: null };
    },

    getSnapshot() {
      return snapshot;
    },

    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    pause() {
      if (disposed || paused) return;
      paused = true;
      abortActive();
      reschedule();
    },

    resume() {
      if (disposed || !paused) return;
      paused = false;
      onEnvironmentWake();
    },

    retryNow() {
      if (disposed || !started) return;
      if (retryBlockedBy(clock.monotonicNowMs()) !== null) {
        commit();
        return;
      }
      startRequest();
    },

    setVisible(next) {
      if (disposed || visible === next) return;
      visible = next;
      if (!next) {
        abortActive();
        reschedule();
      } else {
        onEnvironmentWake();
      }
    },

    setOnlineHint(next) {
      if (disposed || online === next) return;
      online = next;
      if (!next) {
        abortActive();
        reschedule();
      } else {
        onEnvironmentWake();
      }
    },
  };
}
