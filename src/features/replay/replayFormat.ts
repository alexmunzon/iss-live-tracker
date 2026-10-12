// Mission Replay text. Pure: no clocks, no DOM. Reuses the live formatting rules in
// ../status/format so a replayed instant reads exactly as the live panel read it then.
import type {
  DiagnosticCode,
  FetchFailure,
  TrackerSnapshot,
  TransportStatus,
} from '../../domain/position';
import { replayStateAt, type ReplayEvent, type ReplayLog } from '../../domain/replay';
import { DATA_STATE_LABEL, describeConnection, formatAge, formatUtc } from '../status/format';

/** Label for a 'transport-changed' event, by the transport it changed to. */
export const TRANSPORT_EVENT_LABEL: Record<TransportStatus, string> = {
  idle: 'Tracker starting',
  polling: 'Live updates running',
  'retry-wait': 'Waiting to retry after a problem',
  paused: 'Updates paused',
  hidden: 'Updates paused while the tab was in the background',
  offline: 'Device went offline',
  blocked: 'Source unavailable, automatic retry stopped',
};

export const REQUEST_EVENT_LABEL = {
  started: 'Request sent to the source',
  ended: 'Request finished',
} as const;

const SAMPLE_ACCEPTED_LABEL = 'New position received';

/** Label for a 'diagnostic' event, by its closed code. Never shows the code itself. */
export const DIAGNOSTIC_EVENT_LABEL: Record<DiagnosticCode, string> = {
  'conflicting-sample': 'Conflicting position ignored',
  'older-sample-ignored': 'Older position ignored',
  'future-sample-rejected': 'Position dated too far ahead was rejected',
  'future-skew-accepted': 'Position slightly ahead of this device’s clock accepted',
  'optional-field-dropped': 'Altitude or speed values ignored',
  'clock-jump-detected': 'Device clock change detected',
  'late-result-ignored': 'Late response ignored',
  'fetch-failed': 'Request failed',
};

/** Closed mapping of the scheduler's fetch-failed details. Anything else adds nothing. */
const FETCH_FAILED_DETAIL: Readonly<Record<string, string>> = {
  timeout: 'timed out',
  network: 'network error',
  redirect: 'the source tried to redirect',
  'unexpected-content-type': 'response was not JSON',
  'body-too-large': 'response was too large',
  'body-read-failed': 'response could not be read',
  'invalid-json': 'response was not valid JSON',
  'invalid-payload': 'no valid ISS position',
  'too-far-future': 'position dated too far ahead',
  'http-other': 'HTTP error',
};

const HTTP_DETAIL = /^http-(\d{3})$/;

function fetchFailedDetail(detail: string | null): string | null {
  if (detail === null) return null;
  const http = HTTP_DETAIL.exec(detail);
  if (http) return `HTTP ${http[1]}`;
  return Object.hasOwn(FETCH_FAILED_DETAIL, detail) ? (FETCH_FAILED_DETAIL[detail] ?? null) : null;
}

/** Short human label for one recorded event. */
export function describeReplayEvent(event: ReplayEvent): string {
  switch (event.kind) {
    case 'request-started':
      return REQUEST_EVENT_LABEL.started;
    case 'request-ended':
      return REQUEST_EVENT_LABEL.ended;
    case 'sample-accepted':
      return SAMPLE_ACCEPTED_LABEL;
    case 'transport-changed':
      return TRANSPORT_EVENT_LABEL[event.transport];
    case 'diagnostic': {
      if (event.diagnostic === null) return 'Diagnostic recorded';
      const base = DIAGNOSTIC_EVENT_LABEL[event.diagnostic.code];
      if (event.diagnostic.code !== 'fetch-failed') return base;
      const detail = fetchFailedDetail(event.diagnostic.detail);
      return detail === null ? base : `${base} (${detail})`;
    }
  }
}

/** "14:01:23 UTC": the time part of formatUtc, for compact lists and the slider. */
export function formatUtcTime(epochMs: number): string {
  return formatUtc(epochMs).split(',')[0] ?? formatUtc(epochMs);
}

/** "position 22 seconds old", from formatAge's rounding rules. */
function agePhrase(ageMs: number): string {
  const age = formatAge(ageMs);
  return age.endsWith(' ago')
    ? `position ${age.slice(0, -' ago'.length)} old`
    : `position received ${age}`;
}

/** aria-valuetext for the scrubber: "14:03:12 UTC, Delayed, position 22 seconds old". */
export function replayValueText(log: ReplayLog, index: number): string {
  const state = replayStateAt(log, index);
  if (state === null) return '';
  const { freshness } = state;
  const time = formatUtcTime(state.event.wallMs);
  const label = DATA_STATE_LABEL[freshness.state];
  if (freshness.state === 'empty') return `${time}, ${label}, no position yet`;
  if (freshness.state === 'unverified' || freshness.ageMs === null) {
    return `${time}, ${label}, position age unknown`;
  }
  return `${time}, ${label}, ${agePhrase(freshness.ageMs)}`;
}

/**
 * The HTTP failure the live view knew about at log.events[index]: the most recent recorded
 * 'fetch-failed' since the last accepted sample. Only HTTP failures change the connection copy
 * (429 and blocked statuses), so other failures are not reconstructed.
 */
function lastHttpFailureAt(log: ReplayLog, index: number): FetchFailure | null {
  for (let i = index; i >= 0; i -= 1) {
    const e = log.events[i];
    if (e === undefined || e.kind === 'sample-accepted') return null;
    if (e.kind === 'diagnostic' && e.diagnostic?.code === 'fetch-failed') {
      const http = HTTP_DETAIL.exec(e.diagnostic.detail ?? '');
      return http
        ? { kind: 'http', status: Number(http[1]), retryAfter: null, serverDateMs: null }
        : null;
    }
  }
  return null;
}

/**
 * Connection line at a recorded instant, using the live describeConnection rules.
 * No countdown is shown (secondsUntilEligible is null): a replayed wait has no live deadline.
 */
export function replayConnection(log: ReplayLog, index: number): string {
  const state = replayStateAt(log, index);
  if (state === null) return '';
  const snapshot: TrackerSnapshot = {
    transport: state.transport,
    requestInFlight: false,
    anchor: state.anchor,
    trail: state.trail,
    lastFailure: lastHttpFailureAt(log, index),
    consecutiveFailures: 0,
    nextEligibleMonoMs: null,
    retryBlockedBy: null,
    automaticHold: null,
    clockSuspect: false,
    diagnostics: [],
  };
  return describeConnection(snapshot, state.freshness, null);
}
