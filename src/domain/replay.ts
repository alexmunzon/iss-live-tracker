// Mission Replay (session-only). A bounded log of what the tracker knew and when, derived from
// scheduler snapshots. Pure: no timers, no fetches, no storage. Never holds remote text.

import { trackerPolicy } from '../config/trackerPolicy';
import { computeFreshness } from './freshness';
import type {
  Clock,
  DiagnosticCode,
  FreshnessAnchor,
  FreshnessView,
  Diagnostic,
  TrackerSnapshot,
  TrailState,
  TransportStatus,
} from './position';

export type ReplayEventKind =
  /** requestInFlight went false → true. */
  | 'request-started'
  /** requestInFlight went true → false (settled, aborted or cancelled). */
  | 'request-ended'
  /** snapshot.anchor changed to a new accepted sample. */
  | 'sample-accepted'
  /** A new entry appeared in snapshot.diagnostics (closed codes and details only). */
  | 'diagnostic'
  /** snapshot.transport changed. */
  | 'transport-changed';

/**
 * Every event carries the complete state needed to replay that instant: the live anchor, trail
 * and transport as they were right after the change, plus both clock readings.
 * anchor and trail are references to the scheduler's immutable objects (no copies).
 */
export interface ReplayEvent {
  readonly seq: number;
  readonly kind: ReplayEventKind;
  readonly monoMs: number;
  readonly wallMs: number;
  readonly transport: TransportStatus;
  readonly anchor: FreshnessAnchor | null;
  readonly trail: TrailState;
  /** Only for kind 'diagnostic'. */
  readonly diagnostic: { readonly code: DiagnosticCode; readonly detail: string | null } | null;
}

/** Immutable. Oldest first. <= replayMaxEvents and spanning <= replayWindowMs of monotonic time. */
export interface ReplayLog {
  readonly events: readonly ReplayEvent[];
  readonly nextSeq: number;
}

/** What the tracker showed at one recorded instant, computed with the live freshness rules. */
export interface ReplayState {
  readonly event: ReplayEvent;
  readonly anchor: FreshnessAnchor | null;
  readonly freshness: FreshnessView;
  readonly transport: TransportStatus;
  readonly trail: TrailState;
}

export type { Clock, TrackerSnapshot };

export const EMPTY_REPLAY_LOG: ReplayLog = Object.freeze({
  events: Object.freeze([]) as readonly ReplayEvent[],
  nextSeq: 0,
});

/**
 * Compares two consecutive scheduler snapshots and appends what changed, in this order:
 * transport-changed, request-started / request-ended, sample-accepted, then one 'diagnostic'
 * per new diagnostics entry. Every event carries both clock readings taken now and the NEXT
 * snapshot's transport, anchor and trail. Returns `log` itself when nothing changed.
 * The result is pruned to replayWindowMs of monotonic time and replayMaxEvents (newest kept).
 */
export function recordSnapshot(
  log: ReplayLog,
  prev: TrackerSnapshot,
  next: TrackerSnapshot,
  clock: Clock,
): ReplayLog {
  if (prev === next) return log;

  const kinds: ReplayEventKind[] = [];
  if (prev.transport !== next.transport) kinds.push('transport-changed');
  if (prev.requestInFlight !== next.requestInFlight) {
    kinds.push(next.requestInFlight ? 'request-started' : 'request-ended');
  }
  if (prev.anchor !== next.anchor && next.anchor !== null) kinds.push('sample-accepted');

  // The ring is capped and sliced, so indexes shift: a new entry is one whose object identity
  // was not in the previous ring.
  let fresh: readonly Diagnostic[] = [];
  if (prev.diagnostics !== next.diagnostics) {
    const seen = new Set(prev.diagnostics);
    fresh = next.diagnostics.filter((d) => !seen.has(d));
  }

  if (kinds.length === 0 && fresh.length === 0) return log;

  const monoMs = clock.monotonicNowMs();
  const wallMs = clock.wallNowMs();
  let seq = log.nextSeq;
  const make = (kind: ReplayEventKind, diagnostic: ReplayEvent['diagnostic']): ReplayEvent => {
    const event: ReplayEvent = Object.freeze({
      seq,
      kind,
      monoMs,
      wallMs,
      transport: next.transport,
      anchor: next.anchor,
      trail: next.trail,
      diagnostic,
    });
    seq += 1;
    return event;
  };

  const added: ReplayEvent[] = kinds.map((kind) => make(kind, null));
  for (const d of fresh) {
    // Only our own closed code and closed detail strings are kept, never remote text.
    added.push(make('diagnostic', Object.freeze({ code: d.code, detail: d.detail ?? null })));
  }

  const oldest = monoMs - trackerPolicy.replayWindowMs;
  const combined = [...log.events, ...added].filter((e) => e.monoMs >= oldest);
  const events =
    combined.length > trackerPolicy.replayMaxEvents
      ? combined.slice(-trackerPolicy.replayMaxEvents)
      : combined;
  return Object.freeze({ events: Object.freeze(events), nextSeq: seq });
}

/** The clock pair an event was recorded with, so freshness is what the live view computed then. */
function clockAt(event: ReplayEvent): Clock {
  return { monotonicNowMs: () => event.monoMs, wallNowMs: () => event.wallMs };
}

/** What the tracker showed at log.events[index]; null when index is out of range. */
export function replayStateAt(log: ReplayLog, index: number): ReplayState | null {
  if (!Number.isInteger(index) || index < 0 || index >= log.events.length) return null;
  const event = log.events[index];
  if (event === undefined) return null;
  return {
    event,
    anchor: event.anchor,
    freshness: computeFreshness(event.anchor, clockAt(event)),
    transport: event.transport,
    trail: event.trail,
  };
}
