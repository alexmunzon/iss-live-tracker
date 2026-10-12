// React adapter for the one polling scheduler (coordinator-owned).
// It wires browser events to the scheduler and recomputes freshness on a display tick.
// It never fetches or schedules requests itself.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { trackerPolicy } from '../../config/trackerPolicy';
import { createIssClient } from '../../data/issClient';
import { createPollingScheduler } from '../../data/pollingMachine';
import { computeFreshness } from '../../domain/freshness';
import { EMPTY_REPLAY_LOG, recordSnapshot, type ReplayLog } from '../../domain/replay';
import type {
  Clock,
  FetchLike,
  PollingScheduler,
  RandomSource,
  TimerApi,
  TrackerActions,
  TrackerSnapshot,
  TrackerView,
} from '../../domain/position';
import { EMPTY_TRAIL, toTrailSegments } from '../../domain/trail';

/** Injection seam for tests. Production uses browser globals. */
export interface TrackerEnvironment {
  readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly timers: TimerApi;
  readonly random: RandomSource;
  readonly isVisible: () => boolean;
  readonly isOnline: () => boolean;
}

export function browserEnvironment(): TrackerEnvironment {
  return {
    // Read the global at call time so tests can stub it.
    fetch: (input, init) => globalThis.fetch(input, init),
    clock: {
      wallNowMs: () => Date.now(),
      monotonicNowMs: () => performance.now(),
    },
    timers: {
      set: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    random: () => Math.random(),
    isVisible: () => document.visibilityState !== 'hidden',
    isOnline: () => navigator.onLine,
  };
}

/** Shown before the scheduler exists (first render). Nothing in flight, no data. */
const IDLE_SNAPSHOT: TrackerSnapshot = Object.freeze({
  transport: 'idle',
  requestInFlight: false,
  anchor: null,
  trail: EMPTY_TRAIL,
  lastFailure: null,
  consecutiveFailures: 0,
  nextEligibleMonoMs: null,
  retryBlockedBy: null,
  automaticHold: null,
  clockSuspect: false,
  diagnostics: Object.freeze([]),
});

/** One immutable store value: the snapshot and the replay log recorded up to it, together. */
interface TrackerStoreState {
  readonly snapshot: TrackerSnapshot;
  readonly replayLog: ReplayLog;
}

const IDLE_STATE: TrackerStoreState = Object.freeze({
  snapshot: IDLE_SNAPSHOT,
  replayLog: EMPTY_REPLAY_LOG,
});

/** Owns at most one scheduler at a time and exposes a stable external store to React. */
function createTrackerStore(env: TrackerEnvironment) {
  let scheduler: PollingScheduler | null = null;
  // Replaced as a whole, so React always reads a snapshot and the log recorded up to it.
  // A new object only when the scheduler's snapshot changed; same reference otherwise.
  let state: TrackerStoreState = IDLE_STATE;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  /** Scheduler commit: record the change against the previous snapshot, then tell React. */
  const sync = (): void => {
    const next = scheduler ? scheduler.getSnapshot() : IDLE_SNAPSHOT;
    if (next !== state.snapshot) {
      state = {
        snapshot: next,
        replayLog: recordSnapshot(state.replayLog, state.snapshot, next, env.clock),
      };
    }
    emit();
  };

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState(): TrackerStoreState {
      return state;
    },
    actions: {
      pause: () => scheduler?.pause(),
      resume: () => scheduler?.resume(),
      retry: () => scheduler?.retryNow(),
    } satisfies TrackerActions,
    /** Called from an effect. Returns the matching cleanup. Safe under Strict Mode. */
    connect(): () => void {
      const client = createIssClient({ fetch: env.fetch, clock: env.clock, timers: env.timers });
      const instance = createPollingScheduler({
        client,
        clock: env.clock,
        timers: env.timers,
        random: env.random,
        initialVisible: env.isVisible(),
        initialOnline: env.isOnline(),
      });
      const unsubscribe = instance.subscribe(sync);

      const onVisibility = (): void => instance.setVisible(env.isVisible());
      const onOnline = (): void => instance.setOnlineHint(true);
      const onOffline = (): void => instance.setOnlineHint(false);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);

      // Start on the next task. Strict Mode's immediate setup -> cleanup -> setup then cancels
      // the first instance before it sends anything, so development makes one request, not two.
      const startHandle = env.timers.set(() => instance.start(), 0);
      scheduler = instance;
      // A fresh log per connection: a Strict Mode remount never double-records. The first
      // entry compares the new scheduler's snapshot with the idle one shown before it.
      state = IDLE_STATE;
      sync();

      return () => {
        env.timers.clear(startHandle);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
        unsubscribe();
        instance.dispose();
        if (scheduler === instance) {
          scheduler = null;
          state = IDLE_STATE;
        }
        emit();
      };
    },
  };
}

export function useTracker(environment?: TrackerEnvironment): TrackerView {
  // The environment and store are fixed for the life of the component.
  const [env] = useState<TrackerEnvironment>(() => environment ?? browserEnvironment());
  const [store] = useState(() => createTrackerStore(env));

  useEffect(() => store.connect(), [store]);
  const { snapshot, replayLog } = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );

  // Display tick: re-render once per second so age text advances. Not a network timer.
  const [, setTick] = useState(0);
  useEffect(() => {
    let handle: unknown = null;
    const tick = (): void => {
      setTick((n) => (n + 1) % 1_000_000);
      handle = env.timers.set(tick, trackerPolicy.ageDisplayTickMs);
    };
    handle = env.timers.set(tick, trackerPolicy.ageDisplayTickMs);
    return () => env.timers.clear(handle);
  }, [env]);

  const freshness = computeFreshness(snapshot.anchor, env.clock);
  const trailSegments = useMemo(() => toTrailSegments(snapshot.trail), [snapshot.trail]);

  const next = snapshot.nextEligibleMonoMs;
  const secondsUntilEligible =
    next === null ? null : Math.ceil(Math.max(0, next - env.clock.monotonicNowMs()) / 1000);

  return {
    snapshot,
    freshness,
    trailSegments,
    secondsUntilEligible,
    replayLog,
    actions: store.actions,
  };
}
