import { useId, type RefObject } from 'react';
import type { TrackerView } from '../../domain/position';
import { trackerPolicy } from '../../config/trackerPolicy';
import { describeRetryBlock } from './format';

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

/** Pause/Resume, Retry, Recenter and Replay. Map zoom/pan buttons live on the map itself (IssMap). */
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
  const recenterNoteId = useId();
  const paused = snapshot.transport === 'paused';
  const retryBlocked = snapshot.retryBlockedBy;
  const hasPosition = snapshot.anchor !== null;

  return (
    <div className="controls" role="group" aria-label="Tracker controls">
      <div className="controls__row">
        <button
          type="button"
          className="button button--primary"
          onClick={paused ? actions.resume : actions.pause}
        >
          {paused ? 'Resume updates' : 'Pause updates'}
        </button>

        <button
          type="button"
          className="button"
          onClick={actions.retry}
          disabled={retryBlocked !== null}
          aria-describedby={retryBlocked !== null ? retryReasonId : undefined}
        >
          Retry now
        </button>

        <button
          type="button"
          className="button"
          onClick={onRecenter}
          disabled={!hasPosition}
          aria-describedby={recenterNoteId}
        >
          Recenter on ISS
        </button>

        {onEnterReplay !== undefined && (
          <button
            ref={replayButtonRef}
            type="button"
            className="button"
            onClick={onEnterReplay}
            disabled={!replayAvailable}
          >
            Replay
          </button>
        )}
      </div>

      {retryBlocked !== null && (
        <p id={retryReasonId} className="controls__reason" data-testid="retry-reason">
          {snapshot.transport === 'polling' &&
          (retryBlocked === 'spacing' || retryBlocked === 'in-flight')
            ? `Updating automatically every ${trackerPolicy.healthyIntervalMs / 1000} s.`
            : `Retry unavailable: ${describeRetryBlock(retryBlocked, secondsUntilEligible)}`}
        </p>
      )}
      <p id={recenterNoteId} className="controls__reason" data-testid="follow-state">
        {!hasPosition
          ? 'Recenter becomes available after the first position.'
          : follow
            ? 'Following: the map moves with the ISS.'
            : 'Not following. Recenter to follow the ISS again.'}
      </p>
    </div>
  );
}
