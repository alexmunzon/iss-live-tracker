// Dev-only preview of UI states driven by fixtures. Not part of the production build
// (vite builds only /index.html). Open /src/features/status/preview/index.html?state=fresh
// Optional &map=fail points tiles at an unreachable local port to show the failure state.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../styles/tokens.css';
import '../../../styles/app.css';
import { IssMapCore } from '../../map/IssMap';
import { StatusPanel } from '../StatusPanel';
import { TrackerLayout } from '../TrackerLayout';
import { previewViews, type PreviewViewName } from '../fixtures';
import { trackerPolicy } from '../../../config/trackerPolicy';
import type { MapStatus } from '../../../domain/position';

const params = new URLSearchParams(window.location.search);
const requested = params.get('state') ?? 'fresh';
const stateName: PreviewViewName =
  requested in previewViews ? (requested as PreviewViewName) : 'fresh';
const tileUrl =
  params.get('map') === 'fail' ? 'http://127.0.0.1:9/{z}/{x}/{y}.png' : trackerPolicy.tileUrl;

function Preview() {
  const view = previewViews[stateName]();
  const [follow, setFollow] = useState(true);
  const [recenterToken, setRecenterToken] = useState(0);
  const [mapStatus, setMapStatus] = useState<MapStatus>('loading');
  const sample = view.snapshot.anchor?.sample ?? null;
  return (
    <TrackerLayout
      header={
        <>
          <h1>ISS Live Tracker</h1>
          <p>Preview: {stateName}</p>
        </>
      }
      map={
        <IssMapCore
          position={sample === null ? null : [sample.latitudeDeg, sample.longitudeDeg]}
          trailSegments={view.trailSegments}
          follow={follow}
          onUserMoved={() => setFollow(false)}
          recenterToken={recenterToken}
          onStatusChange={setMapStatus}
          tileUrl={tileUrl}
        />
      }
      status={
        <StatusPanel
          view={view}
          follow={follow}
          mapStatus={mapStatus}
          onRecenter={() => {
            setFollow(true);
            setRecenterToken((t) => t + 1);
          }}
        />
      }
    />
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Preview />
    </StrictMode>,
  );
}
