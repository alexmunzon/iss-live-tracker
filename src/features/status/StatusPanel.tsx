import { useId, type ReactNode } from 'react';
import type { MapStatus, TrackerView } from '../../domain/position';
import {
  CLOCK_SUSPECT_MESSAGE,
  DATA_STATE_LABEL,
  DATA_STATE_TONE,
  describeConnection,
  describeFailure,
  describeUpdates,
  formatAge,
  formatLatitude,
  formatLongitude,
  formatUtc,
  showClockSuspect,
  type Tone,
} from './format';

const MERCATOR_LIMIT = 85.0511;

export interface StatusPanelProps {
  readonly view: TrackerView;
  readonly mapStatus: MapStatus;
}

/** Small warning triangle. Decorative: the words next to it carry the meaning. */
export function WarnIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 1.5 15 14H1L8 1.5Z" fill="currentColor" />
      <path d="M8 6v4" stroke="var(--color-surface)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="12" r="0.9" fill="var(--color-surface)" />
    </svg>
  );
}

function Notice({ tone, testId, children }: { tone: Tone; testId?: string; children: ReactNode }) {
  return (
    <p className={`notice notice--${tone}`} data-testid={testId}>
      {tone !== 'neutral' && <WarnIcon />}
      <span>{children}</span>
    </p>
  );
}

/**
 * Position summary: the complete text alternative to the map. Position first, calculation age
 * second, then calculation state and update state, which are kept as separate facts.
 */
export function StatusPanel({ view, mapStatus }: StatusPanelProps) {
  const { snapshot, freshness, secondsUntilEligible } = view;
  const headingId = useId();
  const sample = snapshot.anchor?.sample ?? null;

  const ageUnknown = freshness.state === 'unverified' || freshness.ageMs === null;
  const updates = describeUpdates(snapshot);
  const showConnection = !(snapshot.transport === 'polling' && snapshot.anchor !== null);
  const connectionTone: Tone =
    snapshot.transport === 'polling' || snapshot.transport === 'idle'
      ? 'neutral'
      : snapshot.transport === 'blocked'
        ? 'error'
        : snapshot.transport === 'hidden'
          ? 'neutral'
          : 'warn';
  const badgeTone = DATA_STATE_TONE[freshness.state];
  const badgeIcon = freshness.state === 'stale' || freshness.state === 'unverified';

  return (
    <section className="summary" aria-labelledby={headingId}>
      <h2 id={headingId} className="visually-hidden">
        Position summary
      </h2>
      <div className="strip">
        <dl className="strip__list">
          <div className="strip__item strip__item--position">
            <dt>Position</dt>
            <dd className="strip__coords" data-testid="coordinates">
              {sample === null ? (
                <>
                  <span className="skeleton" aria-hidden="true" />
                  <span className="visually-hidden">Not available yet</span>
                </>
              ) : (
                <>
                  <span>{formatLatitude(sample.latitudeDeg)}</span>
                  <span className="visually-hidden">,</span>{' '}
                  <span>{formatLongitude(sample.longitudeDeg)}</span>
                </>
              )}
            </dd>
          </div>
          <div className="strip__item strip__item--age">
            <dt>Calculated</dt>
            <dd>
              <span className="strip__value strip__age" data-testid="age">
                {sample === null
                  ? '—'
                  : ageUnknown
                    ? 'Age unknown'
                    : formatAge(freshness.ageMs ?? 0)}
              </span>
              {sample !== null && (
                <span className="strip__sub" data-testid="calculated">
                  {formatUtc(sample.positionTimeMs)}
                </span>
              )}
            </dd>
          </div>
          <div className="strip__item">
            <dt>Calculation</dt>
            <dd>
              <span className={`badge badge--${badgeTone}`} data-testid="data-state">
                {badgeIcon && <WarnIcon />}
                {snapshot.transport === 'blocked' && sample === null
                  ? 'No position'
                  : DATA_STATE_LABEL[freshness.state]}
              </span>
            </dd>
          </div>
          <div className="strip__item">
            <dt>Updates</dt>
            <dd className={`strip__value tone--${updates.tone}`} data-testid="updates-state">
              {updates.label}
            </dd>
          </div>
        </dl>
        <p className="strip__note">A calculated position, not direct station telemetry.</p>
      </div>

      {showConnection && (
        <Notice tone={connectionTone} testId="connection">
          {describeConnection(snapshot, freshness, secondsUntilEligible)}
          {snapshot.lastFailure !== null &&
            snapshot.transport !== 'blocked' &&
            snapshot.transport !== 'polling' && (
              <span className="notice__detail" data-testid="last-problem">
                {' '}
                Last problem: {describeFailure(snapshot.lastFailure)}.
              </span>
            )}
        </Notice>
      )}

      {showClockSuspect(snapshot) && (
        <Notice tone="warn" testId="clock-suspect">
          {CLOCK_SUSPECT_MESSAGE}
        </Notice>
      )}
      {freshness.clockWarning === 'future-skew' && (
        <Notice tone="neutral" testId="clock-skew">
          The source’s time is slightly ahead of this device’s clock, so the age is approximate.
        </Notice>
      )}
      {freshness.clockWarning === 'time-unverified' && (
        <Notice tone="warn" testId="time-unverified">
          This device’s clock changed unexpectedly, so the age can’t be trusted. The calculated time
          shown is the source’s own time.
        </Notice>
      )}
      {sample !== null && Math.abs(sample.latitudeDeg) > MERCATOR_LIMIT && (
        <Notice tone="neutral">
          This latitude is beyond what the map can draw; the coordinates above are exact.
        </Notice>
      )}
      {(mapStatus === 'tiles-failing' || mapStatus === 'init-failed') && (
        <Notice tone="warn" testId="map-unavailable">
          {mapStatus === 'init-failed'
            ? 'Map unavailable: it could not be started in this browser. The position above is still updated.'
            : 'Map unavailable: map images are not loading. The position above is still updated.'}
        </Notice>
      )}
    </section>
  );
}
