// Live-region policy: announce state transitions only. Never age ticks or coordinates.
import type { DataState, TrackerSnapshot, TransportStatus } from '../../domain/position';

export interface AnnounceState {
  readonly hasPosition: boolean;
  readonly data: DataState;
  readonly transport: TransportStatus;
}

export function sameAnnounceState(a: AnnounceState, b: AnnounceState): boolean {
  return a.hasPosition === b.hasPosition && a.data === b.data && a.transport === b.transport;
}

const TROUBLE: ReadonlySet<TransportStatus> = new Set(['retry-wait', 'offline', 'blocked']);

/** Text to announce when moving from `prev` to `next`, or null when nothing worth saying changed. */
export function announcementFor(prev: AnnounceState, next: AnnounceState): string | null {
  const parts: string[] = [];

  if (prev.transport !== next.transport) {
    if (next.transport === 'paused') parts.push('Updates paused.');
    else if (prev.transport === 'paused') parts.push('Updates resumed.');
    else if (next.transport === 'offline') parts.push('Offline.');
    else if (next.transport === 'blocked')
      parts.push('Source unavailable. Automatic retry stopped.');
    else if (next.transport === 'polling' && TROUBLE.has(prev.transport)) {
      parts.push('Connection recovered.');
    }
  }

  if (!prev.hasPosition && next.hasPosition) {
    parts.push('First position received.');
  } else if (prev.data !== next.data && next.hasPosition) {
    if (next.data === 'delayed') parts.push('Position data is delayed.');
    else if (next.data === 'stale') parts.push('Position data is stale.');
    else if (next.data === 'unverified') parts.push('Position time could not be verified.');
    else if (next.data === 'fresh') parts.push('Position data is current again.');
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

/** Mission Replay: announced once when Replay opens. */
export const REPLAY_ENTERED_ANNOUNCEMENT =
  'Replay opened. Showing recorded data from this session, not live.';

/**
 * Mission Replay: announced once on "Back to live", from the live snapshot right after the
 * switch, so it never claims updates resumed when the tab is hidden, offline or held (R2).
 */
export function backToLiveAnnouncement(wasPaused: boolean, snapshot: TrackerSnapshot): string {
  if (wasPaused) return 'Back to live. Updates are still paused.';
  switch (snapshot.transport) {
    case 'idle':
    case 'polling':
    case 'paused':
      return 'Back to live. Live updates resumed.';
    case 'hidden':
      return 'Back to live. Updates resume when this tab is in the foreground.';
    case 'offline':
      return 'Back to live. Offline: updates resume when the connection returns.';
    case 'blocked':
      return 'Back to live. The source is unavailable, so automatic updates are stopped.';
    case 'retry-wait':
      return snapshot.automaticHold === null
        ? 'Back to live. Waiting before retrying the source.'
        : 'Back to live. Automatic updates are paused; use Retry when ready.';
  }
}
