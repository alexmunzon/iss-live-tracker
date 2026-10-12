import { useId, type RefObject } from 'react';
import type { TrackerView } from '../../domain/position';
import { describeRetryBlock, retryRelevant } from './format';

/** Mission Replay entry point, shown with the live controls when onEnterReplay is given. */
export interface ReplayEntryProps {
  /** True once at least one event has been recorded. */
  readonly replayAvailable?: boolean | undefined;
  readonly onEnterReplay?: (() => void) | undefined;
  /** Focus returns to this button on "Back to live". */
  readonly replayButtonRef?: RefObject<HTMLButtonElement | null> | undefined;
}

export interface ControlsProps extends ReplayEntryProps {
  readonly view: TrackerView;
  readonly follow: boolean;
  readonly onRecenter: () => void;
}

/**
 * The one action row below the map: Recenter, Pause/Resume, Retry (only when relevant) and
 * Replay. Zoom and pan live on the map itself (IssMap). Follow is a map behaviour and stays
 * independent of Pause: pausing never changes Follow, and recentering never resumes updates.
 */
export function Controls({
  view,
  follow,
  onRecenter,
  replayAvailable = false,
  onEnterReplay,
  replayButtonRef,
}: ControlsProps) {
  const { snapshot, secondsUntilEligible, actions } = view;
  const retryReasonId = useId();
  const paused = snapshot.transport === 'paused';
  const retryBlocked = snapshot.retryBlockedBy;
  const hasPosition = snapshot.anchor !== null;
  const showRetry = retryRelevant(snapshot);
  const exploring = hasPosition && !follow;

  return (
    <div className="actions">
      <div className="actions__row" role="group" aria-label="Tracker controls">
        <button
          type="button"
          className={`button${exploring ? ' button--primary' : ''}`}
          onClick={onRecenter}
          disabled={!hasPosition}
        >
          Recenter on ISS
        </button>

        <button
          type="button"
          className={`button${paused ? ' button--primary' : ''}`}
          onClick={paused ? actions.resume : actions.pause}
        >
          {paused ? 'Resume updates' : 'Pause updates'}
        </button>

        {showRetry && (
          <button
            type="button"
            className="button"
            onClick={actions.retry}
            disabled={retryBlocked !== null}
            aria-describedby={retryBlocked !== null ? retryReasonId : undefined}
          >
            Retry now
          </button>
        )}

        {onEnterReplay !== undefined && (
          <button
            ref={replayButtonRef}
            type="button"
            className="button button--quiet"
            onClick={onEnterReplay}
            disabled={!replayAvailable}
          >
            Replay
          </button>
        )}
      </div>

      {showRetry && retryBlocked !== null && (
        <p id={retryReasonId} className="actions__reason" data-testid="retry-reason">
          Retry unavailable: {describeRetryBlock(retryBlocked, secondsUntilEligible)}
        </p>
      )}
      {!hasPosition && (
        <p className="actions__reason" data-testid="recenter-hint">
          Recenter and Replay become available after the first position.
        </p>
      )}
    </div>
  );
}
