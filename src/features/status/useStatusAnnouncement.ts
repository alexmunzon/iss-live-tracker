// Text for the single polite live region (App renders it). Derived during render with the
// "previous value in state" pattern, so it changes only when the transition category changes,
// never on age ticks, coordinate updates or countdown seconds.
import { useState } from 'react';
import type { TrackerView } from '../../domain/position';
import { announcementFor, sameAnnounceState, type AnnounceState } from './announce';

export function useStatusAnnouncement(view: TrackerView): string {
  const current: AnnounceState = {
    hasPosition: view.snapshot.anchor !== null,
    data: view.freshness.state,
    transport: view.snapshot.transport,
  };
  const [prev, setPrev] = useState<AnnounceState>(current);
  const [announcement, setAnnouncement] = useState('');
  if (!sameAnnounceState(prev, current)) {
    const text = announcementFor(prev, current);
    setPrev(current);
    if (text !== null) setAnnouncement(text);
  }
  return announcement;
}

/**
 * Merges the live-status and Replay announcements into one region. Replay text wins when both
 * change in the same render (its "Back to live" line already describes the resumed state), and
 * live-status text is held back while Replay is open, because the live panel is not on screen.
 */
export function useLiveRegionText(statusText: string, replayText: string, inReplay: boolean) {
  const [prevStatus, setPrevStatus] = useState(statusText);
  const [prevReplay, setPrevReplay] = useState(replayText);
  const [text, setText] = useState('');
  const statusChanged = statusText !== prevStatus;
  const replayChanged = replayText !== prevReplay;
  if (statusChanged) setPrevStatus(statusText);
  if (replayChanged) setPrevReplay(replayText);
  if (replayChanged) {
    if (replayText !== text) setText(replayText);
  } else if (statusChanged && !inReplay && statusText !== text) {
    setText(statusText);
  }
  return text;
}
