import { useCallback, useMemo, useState } from 'react';
import '../styles/tokens.css';
import '../styles/app.css';
import { trackerPolicy } from '../config/trackerPolicy';
import type { LatLngTuple, MapStatus } from '../domain/position';
import { replayStateAt } from '../domain/replay';
import { toTrailSegments } from '../domain/trail';
import { IssMap } from '../features/map/IssMap';
import { ReplayPanel } from '../features/replay/ReplayPanel';
import { useReplay } from '../features/replay/useReplay';
import { Controls } from '../features/status/Controls';
import { StatusPanel } from '../features/status/StatusPanel';
import { TrackerLayout } from '../features/status/TrackerLayout';
import { useLiveRegionText, useStatusAnnouncement } from '../features/status/useStatusAnnouncement';
import { useTracker, type TrackerEnvironment } from '../features/tracker/useTracker';

export interface AppProps {
  /** Test seam only. Production omits it and uses browser globals. */
  readonly environment?: TrackerEnvironment;
}

export function App({ environment }: AppProps = {}) {
  const view = useTracker(environment);
  const [follow, setFollow] = useState(true);
  const [recenterToken, setRecenterToken] = useState(0);
  const [mapStatus, setMapStatus] = useState<MapStatus>('loading');

  const replay = useReplay(view);
  const session = replay.session;

  // In Replay the map shows the replayed instant (frozen log); otherwise the live snapshot.
  const replayState = session === null ? null : replayStateAt(session.log, session.index);
  const replayTrail = replayState?.trail ?? null;
  const replayTrailSegments = useMemo(
    () => (replayTrail === null ? null : toTrailSegments(replayTrail)),
    [replayTrail],
  );
  const sample = (session === null ? view.snapshot.anchor : replayState?.anchor)?.sample ?? null;
  const position = useMemo<LatLngTuple | null>(
    () => (sample ? [sample.latitudeDeg, sample.longitudeDeg] : null),
    [sample],
  );

  const onUserMoved = useCallback(() => setFollow(false), []);
  const onRecenter = useCallback(() => {
    setFollow(true);
    setRecenterToken((token) => token + 1);
  }, []);

  const statusAnnouncement = useStatusAnnouncement(view);
  const liveText = useLiveRegionText(statusAnnouncement, replay.announcement, session !== null);
  const trailShown = (replayTrailSegments ?? view.trailSegments).length > 0;

  return (
    <TrackerLayout
      summary={
        session === null ? (
          <StatusPanel view={view} mapStatus={mapStatus} />
        ) : (
          <ReplayPanel
            log={session.log}
            index={session.index}
            onSelect={replay.select}
            onExit={replay.exit}
          />
        )
      }
      map={
        <IssMap
          position={position}
          trailSegments={replayTrailSegments ?? view.trailSegments}
          follow={follow}
          onUserMoved={onUserMoved}
          recenterToken={recenterToken}
          onStatusChange={setMapStatus}
        />
      }
      actions={
        session === null ? (
          <Controls
            view={view}
            follow={follow}
            onRecenter={onRecenter}
            replayAvailable={replay.canEnter}
            onEnterReplay={replay.enter}
            replayButtonRef={replay.replayButtonRef}
          />
        ) : undefined
      }
      provenance={
        <div className="provenance">
          <p>
            Calculated by{' '}
            <a href={trackerPolicy.providerHref} rel="noopener noreferrer" target="_blank">
              {trackerPolicy.providerName}
            </a>
          </p>
          {trailShown && (
            <p className="legend" data-testid="trail-note">
              <span className="legend__line" aria-hidden="true" />
              Observed during this session
            </p>
          )}
        </div>
      }
      about={
        <>
          <p>
            Positions are calculated by{' '}
            <a href={trackerPolicy.providerHref} rel="noopener noreferrer" target="_blank">
              {trackerPolicy.providerName}
            </a>{' '}
            from published orbital data. They are estimates, not live telemetry from the station,
            and no accuracy is guaranteed. “Fresh” means the source calculated the position within
            the last {trackerPolicy.freshMaxAgeMs / 1000} seconds; “Delayed” up to{' '}
            {trackerPolicy.delayedMaxAgeMs / 1000} seconds; “Stale” anything older. The age always
            counts from the source’s calculation time, not from when this browser received it.
          </p>
          <p>
            The trail shows only positions received while this page has been open. Lines between
            points are visual guides, not measured intermediate positions or a predicted orbit.
          </p>
          <p>
            Your browser requests positions from api.wheretheiss.at and map images from
            tile.openstreetmap.org. Both services receive your IP address and browser details, as
            any website you load would. This site uses no cookies, analytics, accounts or location
            access, and stores nothing. The trail lives only in memory and disappears when you close
            the page. Replay uses only this session’s in-memory data and stores nothing.
          </p>
          <p>
            Map data{' '}
            <a href={trackerPolicy.tileAttributionHref} rel="noopener noreferrer" target="_blank">
              {trackerPolicy.tileAttributionText}
            </a>
            .
          </p>
        </>
      }
      liveRegion={
        <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {liveText}
        </p>
      }
    />
  );
}
