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
import { StatusPanel } from '../features/status/StatusPanel';
import { TrackerLayout } from '../features/status/TrackerLayout';
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

  return (
    <>
      <TrackerLayout
        header={
          <>
            <h1>ISS Live Tracker</h1>
            <p className="tracker-header__lede">
              Where the International Space Station is, and how recent that position is.
            </p>
          </>
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
        status={
          <>
            {session === null ? (
              <StatusPanel
                view={view}
                follow={follow}
                mapStatus={mapStatus}
                onRecenter={onRecenter}
                replayAvailable={replay.canEnter}
                onEnterReplay={replay.enter}
                replayButtonRef={replay.replayButtonRef}
              />
            ) : (
              <ReplayPanel
                log={session.log}
                index={session.index}
                onSelect={replay.select}
                onExit={replay.exit}
              />
            )}
            {/* Always mounted, so entering and leaving Replay are announced reliably. */}
            <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
              {replay.announcement}
            </p>
          </>
        }
      />
      <footer className="tracker-footer">
        <details>
          <summary>About this data and your privacy</summary>
          <p>
            Positions are calculated by{' '}
            <a href={trackerPolicy.providerHref} rel="noopener noreferrer" target="_blank">
              {trackerPolicy.providerName}
            </a>{' '}
            from published orbital data. They are estimates, not live telemetry from the station,
            and no accuracy is guaranteed. The trail shows only positions received while this page
            has been open.
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
        </details>
      </footer>
    </>
  );
}
