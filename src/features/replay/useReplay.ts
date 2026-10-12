// Mission Replay session state. In memory only: no storage, no timers, no fetches.
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { TrackerView } from '../../domain/position';
import type { ReplayLog } from '../../domain/replay';
import { REPLAY_ENTERED_ANNOUNCEMENT, backToLiveAnnouncement } from '../status/announce';

export interface ReplaySession {
  /** The log as it was when Replay opened. Immutable, so keeping the reference freezes it. */
  readonly log: ReplayLog;
  /** Selected event index into log.events. */
  readonly index: number;
  /** Whether the user had already paused live updates before opening Replay. */
  readonly wasPaused: boolean;
}

export interface ReplayController {
  readonly session: ReplaySession | null;
  /** Text for the polite live region that announces Replay transitions. */
  readonly announcement: string;
  /** The Replay button in the live controls; focus returns here on "Back to live". */
  readonly replayButtonRef: RefObject<HTMLButtonElement | null>;
  readonly canEnter: boolean;
  enter(): void;
  select(index: number): void;
  exit(): void;
}

export function useReplay(view: TrackerView): ReplayController {
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const replayButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef(false);
  /** Set by exit(); the next render reads the resumed live snapshot and announces from it. */
  const [returning, setReturning] = useState<{ readonly wasPaused: boolean } | null>(null);

  // After "Back to live" the live panel (and its Replay button) mounts again; focus it then.
  useEffect(() => {
    if (session !== null || !returnFocusRef.current) return;
    returnFocusRef.current = false;
    replayButtonRef.current?.focus();
  }, [session]);

  const { replayLog, snapshot, actions } = view;
  if (returning !== null && session === null) {
    // Adjusting state during render (React's documented pattern): this render already has the
    // snapshot from after resume(), so the announcement describes what is really happening.
    setReturning(null);
    setAnnouncement(backToLiveAnnouncement(returning.wasPaused, snapshot));
  }
  const canEnter = replayLog.events.length > 0;

  return {
    session,
    announcement,
    replayButtonRef,
    canEnter,
    enter() {
      if (session !== null || replayLog.events.length === 0) return;
      const wasPaused = snapshot.transport === 'paused';
      // Freeze first, so the pause below is not part of what is replayed.
      setSession({ log: replayLog, index: replayLog.events.length - 1, wasPaused });
      setAnnouncement(REPLAY_ENTERED_ANNOUNCEMENT);
      if (!wasPaused) actions.pause();
    },
    select(index) {
      setSession((current) => {
        if (current === null) return current;
        const max = current.log.events.length - 1;
        const next = Math.min(max, Math.max(0, Math.round(index)));
        return next === current.index ? current : { ...current, index: next };
      });
    },
    exit() {
      if (session === null) return;
      // Restore exactly the live-update state from before Replay.
      if (!session.wasPaused) actions.resume();
      setSession(null);
      returnFocusRef.current = true;
      setReturning({ wasPaused: session.wasPaused });
    },
  };
}
