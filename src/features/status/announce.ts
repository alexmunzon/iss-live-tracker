// Live-region policy: announce state transitions only. Never age ticks or coordinates.
import type { DataState, TransportStatus } from '../../domain/position';

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
