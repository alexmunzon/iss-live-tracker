// Pure text formatting for the status panel. No clocks, no DOM.
import type {
  DataState,
  FetchFailure,
  RetryBlockReason,
  TrackerSnapshot,
  FreshnessView,
} from '../../domain/position';
import { trackerPolicy } from '../../config/trackerPolicy';

function hemisphere(value: number, positive: string, negative: string, limit: number): string {
  const rounded = Math.abs(value).toFixed(2);
  const magnitude = Number(rounded);
  // The equator, the prime meridian and the antimeridian have no hemisphere letter.
  if (magnitude === 0 || magnitude === limit) return `${rounded}°`;
  return `${rounded}° ${value > 0 ? positive : negative}`;
}

/** "45.01° N", "0.00°". Never clamps: values beyond the map's projection stay truthful. */
export function formatLatitude(latDeg: number): string {
  return hemisphere(latDeg, 'N', 'S', 90);
}

/** "18.40° W", "180.00°". */
export function formatLongitude(lonDeg: number): string {
  return hemisphere(lonDeg, 'E', 'W', 180);
}

/** "45.01° N, 18.40° W" */
export function formatCoordinates(latDeg: number, lonDeg: number): string {
  return `${formatLatitude(latDeg)}, ${formatLongitude(lonDeg)}`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "14:01:23 UTC, 11 Oct 2026" */
export function formatUtc(epochMs: number): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return 'Unknown time';
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  return `${time} UTC, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCFullYear()}`;
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** Whole seconds, rounded down: 0 → "just now", 1 → "1 second ago", 60 → "1 minute ago". */
export function formatAge(ageMs: number): string {
  const s = Math.floor(Math.max(0, ageMs) / 1000);
  if (s < 1) return 'just now';
  if (s < 60) return `${plural(s, 'second')} ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${plural(m, 'minute')} ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${plural(h, 'hour')} ago`;
  return `${plural(Math.floor(h / 24), 'day')} ago`;
}

export const DATA_STATE_LABEL: Record<DataState, string> = {
  empty: 'Waiting for first position',
  fresh: 'Fresh',
  delayed: 'Delayed',
  stale: 'Stale',
  unverified: 'Time could not be verified',
};

/** Short plain-language description of a failure, for "Last problem: …". */
export function describeFailure(failure: FetchFailure): string {
  switch (failure.kind) {
    case 'timeout':
      return 'the request timed out';
    case 'network':
      return 'the network request failed';
    case 'aborted':
      return 'the request was cancelled';
    case 'redirect':
      return 'the source tried to redirect';
    case 'http':
      return failure.status === 429
        ? 'the source is limiting requests (HTTP 429)'
        : `the source answered HTTP ${failure.status}`;
    case 'unexpected-content-type':
      return 'the source sent something other than JSON';
    case 'body-too-large':
      return 'the response was too large';
    case 'body-read-failed':
      return 'the response could not be read';
    case 'invalid-json':
      return 'the response was not valid JSON';
    case 'invalid-payload':
      return 'the response did not contain a valid ISS position';
  }
}

function inSeconds(seconds: number | null): string {
  return seconds === null ? 'shortly' : `in ${seconds} s`;
}

/** Connection line, independent of how old the data is. */
export function describeConnection(
  snapshot: TrackerSnapshot,
  freshness: FreshnessView,
  secondsUntilEligible: number | null,
): string {
  const { transport, lastFailure, anchor } = snapshot;
  const lastCalculated = (): string => {
    if (anchor === null) return 'No position received yet.';
    if (freshness.state === 'unverified' || freshness.ageMs === null) {
      return `Last position calculated at ${formatUtc(anchor.sample.positionTimeMs)}.`;
    }
    return `Last position calculated ${formatAge(freshness.ageMs)}.`;
  };
  switch (transport) {
    case 'idle':
      return 'Starting.';
    case 'polling':
      if (anchor === null) return 'Connecting to the source.';
      return `Connected. Updating every ${trackerPolicy.healthyIntervalMs / 1000} s.`;
    case 'retry-wait':
      if (snapshot.retryBlockedBy === 'time-unverified') {
        return 'The source asked us to wait, but this device’s clock could not be verified. Automatic retry paused.';
      }
      if (lastFailure?.kind === 'http' && lastFailure.status === 429) {
        return `The source is limiting requests, retrying ${inSeconds(secondsUntilEligible)}`;
      }
      return `Connection problem, retrying ${inSeconds(secondsUntilEligible)}`;
    case 'paused':
      return 'Paused';
    case 'hidden':
      return 'Paused while this tab is in the background.';
    case 'offline':
      return `Offline. ${lastCalculated()}`;
    case 'blocked':
      return lastFailure?.kind === 'http'
        ? `Source unavailable (HTTP ${lastFailure.status}). Automatic retry stopped.`
        : 'Source unavailable. Automatic retry stopped.';
  }
}

export const CLOCK_SUSPECT_MESSAGE =
  'Your device clock looks wrong, so position times can’t be verified. Check your date and time settings.';

/** G1-v2: the device clock is suspect and we either have no position or rejected one as implausible. */
export function showClockSuspect(snapshot: TrackerSnapshot): boolean {
  if (!snapshot.clockSuspect) return false;
  if (snapshot.anchor === null) return true;
  const f = snapshot.lastFailure;
  return f?.kind === 'invalid-payload' && f.rejection === 'timestamp-implausible';
}

/** Visible explanation next to a disabled Retry button. */
export function describeRetryBlock(
  reason: RetryBlockReason,
  secondsUntilEligible: number | null,
): string {
  const when = secondsUntilEligible === null ? '' : ` Available in ${secondsUntilEligible} s.`;
  switch (reason) {
    case 'in-flight':
      return 'A request is in progress.';
    case 'spacing':
      return `Updates already run every ${trackerPolicy.healthyIntervalMs / 1000} s.${when}`;
    case 'backoff':
      return `Waiting before trying again.${when}`;
    case 'server-wait':
      return `The source asked us to wait.${when}`;
    case 'time-unverified':
      return 'The source asked us to wait, and this device’s clock could not be verified.';
    case 'paused':
      return 'Resume updates to retry.';
    case 'hidden':
      return 'Unavailable while this tab is in the background.';
  }
}
