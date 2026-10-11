import { useId, useState } from 'react';
import type { StatusPanelProps } from '../../domain/position';
import { trackerPolicy } from '../../config/trackerPolicy';
import {
  CLOCK_SUSPECT_MESSAGE,
  DATA_STATE_LABEL,
  describeConnection,
  describeFailure,
  formatAge,
  formatCoordinates,
  formatUtc,
  showClockSuspect,
} from './format';
import { announcementFor, sameAnnounceState, type AnnounceState } from './announce';
import { Controls } from './Controls';

const MERCATOR_LIMIT = 85.0511;

/** Complete text alternative to the map, plus the tracker controls. */
export function StatusPanel({ view, follow, mapStatus, onRecenter }: StatusPanelProps) {
  const { snapshot, freshness, trailSegments, secondsUntilEligible } = view;
  const headingId = useId();
  const sample = snapshot.anchor?.sample ?? null;

  // Live region: derived during render with the "previous value in state" pattern, so it
  // changes only when the transition category changes, never on age or coordinate updates.
  const current: AnnounceState = {
    hasPosition: snapshot.anchor !== null,
    data: freshness.state,
    transport: snapshot.transport,
  };
  const [prev, setPrev] = useState<AnnounceState>(current);
  const [announcement, setAnnouncement] = useState('');
  if (!sameAnnounceState(prev, current)) {
    const text = announcementFor(prev, current);
    setPrev(current);
    if (text !== null) setAnnouncement(text);
  }

  const showAbsoluteOnly = freshness.state === 'unverified' || freshness.ageMs === null;
  const stateClass = `status-badge status-badge--${freshness.state}`;
  const connection = describeConnection(snapshot, freshness, secondsUntilEligible);
  const degradedTransport =
    snapshot.transport === 'retry-wait' ||
    snapshot.transport === 'offline' ||
    snapshot.transport === 'blocked';

  return (
    <section className="status-panel" aria-labelledby={headingId}>
      <h2 id={headingId} className="status-panel__title">
        Current position
      </h2>

      {(mapStatus === 'tiles-failing' || mapStatus === 'init-failed') && (
        <p className="notice notice--warning" data-testid="map-unavailable">
          {mapStatus === 'init-failed'
            ? 'The map could not be started in this browser. All position details are listed here.'
            : 'Map tiles are not loading right now. The position details here are still updated.'}
        </p>
      )}

      {showClockSuspect(snapshot) && (
        <p className="notice notice--info" data-testid="clock-suspect">
          {CLOCK_SUSPECT_MESSAGE}
        </p>
      )}

      <dl className="status-list">
        <div className="status-list__row">
          <dt>Data</dt>
          <dd>
            <span className={stateClass} data-testid="data-state">
              {DATA_STATE_LABEL[freshness.state]}
            </span>
          </dd>
        </div>

        <div className="status-list__row">
          <dt>Position</dt>
          <dd className="status-list__coords" data-testid="coordinates">
            {sample === null
              ? 'Not available yet'
              : formatCoordinates(sample.latitudeDeg, sample.longitudeDeg)}
          </dd>
        </div>

        <div className="status-list__row">
          <dt>Calculated</dt>
          <dd data-testid="calculated">
            {sample === null ? '—' : formatUtc(sample.positionTimeMs)}
          </dd>
        </div>

        <div className="status-list__row">
          <dt>Age</dt>
          <dd data-testid="age">
            {sample === null
              ? '—'
              : showAbsoluteOnly
                ? 'Unknown (see calculated time)'
                : formatAge(freshness.ageMs ?? 0)}
          </dd>
        </div>

        <div className="status-list__row">
          <dt>Connection</dt>
          <dd
            data-testid="connection"
            className={degradedTransport ? 'status-list__warn' : undefined}
          >
            {connection}
            {snapshot.lastFailure !== null && snapshot.transport !== 'blocked' && (
              <span className="status-list__detail">
                {' '}
                Last problem: {describeFailure(snapshot.lastFailure)}.
              </span>
            )}
          </dd>
        </div>
      </dl>

      {freshness.clockWarning === 'future-skew' && (
        <p className="notice notice--info">
          The source’s time is slightly ahead of this device’s clock, so the age is approximate.
        </p>
      )}
      {freshness.clockWarning === 'time-unverified' && (
        <p className="notice notice--info">
          This device’s clock changed unexpectedly, so the age can’t be trusted. The calculated time
          above is the provider’s own time.
        </p>
      )}
      {sample !== null && Math.abs(sample.latitudeDeg) > MERCATOR_LIMIT && (
        <p className="notice notice--info">
          This latitude is beyond what the map can draw; the coordinates above are exact.
        </p>
      )}

      {trailSegments.length > 0 && (
        <p className="status-panel__note" data-testid="trail-note">
          Trail: observed during this session.
        </p>
      )}

      <Controls view={view} follow={follow} onRecenter={onRecenter} />

      <p className="status-panel__credit">
        Position data:{' '}
        <a href={trackerPolicy.providerHref} rel="noreferrer">
          {trackerPolicy.providerName}
        </a>
      </p>

      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
}
