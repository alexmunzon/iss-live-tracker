import { useEffect, useId, useRef, type ChangeEvent } from 'react';
import { replayStateAt, type ReplayLog } from '../../domain/replay';
import { DATA_STATE_LABEL, formatAge, formatCoordinates, formatUtc } from '../status/format';
import {
  describeReplayEvent,
  formatUtcTime,
  replayConnection,
  replayValueText,
} from './replayFormat';

export interface ReplayPanelProps {
  readonly log: ReplayLog;
  readonly index: number;
  readonly onSelect: (index: number) => void;
  readonly onExit: () => void;
}

/** Replaces the live status panel while replaying. Shows one recorded instant, never live data. */
export function ReplayPanel({ log, index, onSelect, onExit }: ReplayPanelProps) {
  const headingId = useId();
  const sliderId = useId();
  const listHeadingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Opening Replay moves focus here so the mode change is the first thing heard and seen.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const state = replayStateAt(log, index);
  const count = log.events.length;
  if (state === null) return null;

  const { event, freshness, anchor } = state;
  const sample = anchor?.sample ?? null;
  const received =
    anchor === null
      ? null
      : Number.isFinite(anchor.sample.receivedAtMs)
        ? anchor.sample.receivedAtMs
        : anchor.anchorWallMs;
  const showAbsoluteOnly = freshness.state === 'unverified' || freshness.ageMs === null;

  const onSlider = (e: ChangeEvent<HTMLInputElement>) => onSelect(Number(e.target.value));

  // Newest first, matching the slider's default (the newest event).
  const order = log.events.map((_, i) => i).reverse();

  return (
    <section className="status-panel replay-panel" aria-labelledby={headingId}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1} className="status-panel__title">
        Replay — not live
      </h2>
      <p className="notice notice--warning replay-panel__banner" data-testid="replay-not-live">
        Not live: this is what the tracker knew at a recorded moment of this session. Live updates
        are paused until you go back to live.
      </p>

      <div className="replay-scrubber">
        <label htmlFor={sliderId} className="replay-scrubber__label">
          Recorded moment
        </label>
        <input
          id={sliderId}
          type="range"
          className="replay-scrubber__input"
          min={0}
          max={count - 1}
          step={1}
          value={index}
          onChange={onSlider}
          aria-valuetext={replayValueText(log, index)}
        />
        <p className="controls__reason" data-testid="replay-index">
          Event {index + 1} of {count} (oldest on the left, newest on the right)
        </p>
      </div>

      <dl className="status-list">
        <div className="status-list__row">
          <dt>Recorded</dt>
          <dd data-testid="replay-recorded">{formatUtc(event.wallMs)}</dd>
        </div>
        <div className="status-list__row">
          <dt>Event</dt>
          <dd data-testid="replay-event">{describeReplayEvent(event)}</dd>
        </div>
        <div className="status-list__row">
          <dt>Data then</dt>
          <dd>
            <span
              className={`status-badge status-badge--${freshness.state}`}
              data-testid="replay-data-state"
            >
              {DATA_STATE_LABEL[freshness.state]}
            </span>
          </dd>
        </div>
        <div className="status-list__row">
          <dt>Position</dt>
          <dd className="status-list__coords" data-testid="replay-coordinates">
            {sample === null
              ? 'Not available yet'
              : formatCoordinates(sample.latitudeDeg, sample.longitudeDeg)}
          </dd>
        </div>
        <div className="status-list__row">
          <dt>Age then</dt>
          <dd data-testid="replay-age">
            {sample === null
              ? '—'
              : showAbsoluteOnly
                ? 'Unknown (see calculated time)'
                : formatAge(freshness.ageMs ?? 0)}
          </dd>
        </div>
        <div className="status-list__row">
          <dt>Connection then</dt>
          <dd data-testid="replay-connection">{replayConnection(log, index)}</dd>
        </div>
      </dl>

      <dl className="replay-times">
        <div className="replay-times__item">
          <dt>Calculated</dt>
          <dd data-testid="replay-calculated">
            {sample === null ? '—' : formatUtc(sample.positionTimeMs)}
          </dd>
        </div>
        <div className="replay-times__item">
          <dt>Received</dt>
          <dd data-testid="replay-received">{received === null ? '—' : formatUtc(received)}</dd>
        </div>
      </dl>

      <h3 id={listHeadingId} className="replay-events__title">
        Recorded events (newest first)
      </h3>
      <div className="replay-events">
        <ol className="replay-events__list" aria-labelledby={listHeadingId}>
          {order.map((i) => {
            const e = log.events[i];
            if (e === undefined) return null;
            const selected = i === index;
            return (
              <li key={e.seq}>
                <button
                  type="button"
                  className="replay-events__item"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(i)}
                >
                  <span className="replay-events__time">{formatUtcTime(e.wallMs)}</span>{' '}
                  <span>{describeReplayEvent(e)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="controls">
        <div className="controls__row">
          <button type="button" className="button button--primary" onClick={onExit}>
            Back to live
          </button>
        </div>
      </div>
    </section>
  );
}
