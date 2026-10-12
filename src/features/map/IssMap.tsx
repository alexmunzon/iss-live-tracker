import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '../../styles/map.css';
import type { IssMapProps, LatLngTuple, MapStatus } from '../../domain/position';
import { trackerPolicy } from '../../config/trackerPolicy';
import {
  INITIAL_CENTER,
  INITIAL_ZOOM,
  MERCATOR_LAT_LIMIT,
  PAN_STEP_PX,
  WORLD_BOUNDS,
  crossesAntimeridian,
  fitWorldZoom,
  isMapKey,
  nextTileStatus,
  prefersReducedMotion,
  type TileHealth,
} from './mapHelpers';

/**
 * className-only icon (G1-v2): no html option. The station symbol is a locally bundled SVG
 * applied by CSS (map.css), centred on the accepted coordinate; the "ISS" label is CSS too.
 */
const MARKER_PX = 30;
const ISS_ICON = L.divIcon({
  className: 'iss-marker',
  iconSize: [MARKER_PX, MARKER_PX],
  iconAnchor: [MARKER_PX / 2, MARKER_PX / 2],
});
/** Width reserved for the "ISS" label beside the marker before it flips to the other side. */
const LABEL_ROOM_PX = 72;

/** Puts the marker label on whichever side keeps it inside the visible map. */
function placeLabel(map: L.Map, marker: L.Marker | null) {
  const el = marker?.getElement();
  if (marker === null || el === undefined) return;
  const x = map.latLngToContainerPoint(marker.getLatLng()).x;
  el.classList.toggle('iss-marker--label-left', x > map.getSize().x - LABEL_ROOM_PX);
}

/** Attribution as a Leaflet control built from DOM nodes and textContent (no HTML strings). */
function createAttributionControl(): L.Control {
  const control = new L.Control({ position: 'bottomright' });
  control.onAdd = () => {
    const box = L.DomUtil.create(
      'div',
      'leaflet-control-attribution leaflet-control iss-attribution',
    );
    const link = document.createElement('a');
    link.href = trackerPolicy.tileAttributionHref;
    link.rel = 'noreferrer';
    link.textContent = trackerPolicy.tileAttributionText;
    box.append(link);
    L.DomEvent.disableClickPropagation(box);
    return box;
  };
  return control;
}

export interface IssMapCoreProps extends IssMapProps {
  /** Tile URL template. Only the dev preview overrides it (to simulate tile failure). */
  readonly tileUrl: string;
}

/**
 * Leaflet map with one marker and the observed trail.
 * The map never fetches data and owns no timers; everything arrives via props.
 */
export function IssMap(props: IssMapProps) {
  return <IssMapCore {...props} tileUrl={trackerPolicy.tileUrl} />;
}

export function IssMapCore({
  position,
  trailSegments,
  follow,
  onUserMoved,
  recenterToken,
  onStatusChange,
  tileUrl,
}: IssMapCoreProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const trailRef = useRef<L.LayerGroup | null>(null);
  /** > 0 while we move the map ourselves, so zoomstart is not mistaken for the user. */
  const programmaticRef = useRef(0);
  const callbacksRef = useRef({ onUserMoved, onStatusChange });
  const positionRef = useRef<LatLngTuple | null>(position);
  const followRef = useRef(follow);
  const lastRecenterRef = useRef(recenterToken);
  const [initFailed, setInitFailed] = useState(false);
  const [tilesFailing, setTilesFailing] = useState(false);

  // Keep the latest props for Leaflet listeners. Declared first so it runs first.
  useEffect(() => {
    callbacksRef.current = { onUserMoved, onStatusChange };
    positionRef.current = position;
    followRef.current = follow;
  });

  // Map lifecycle: exactly one L.Map per mounted container; Strict Mode safe.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return undefined;

    let status: MapStatus | null = null;
    const emit = (next: MapStatus) => {
      if (next === status) return;
      status = next;
      callbacksRef.current.onStatusChange(next);
    };

    const reduced = prefersReducedMotion();
    let map: L.Map;
    try {
      map = L.map(el, {
        center: INITIAL_CENTER,
        // Never start below the zoom that fills the map width with one world copy.
        zoom: Math.max(INITIAL_ZOOM, fitWorldZoom(el.clientWidth)),
        minZoom: fitWorldZoom(el.clientWidth),
        maxZoom: trackerPolicy.tileMaxZoom,
        maxBounds: WORLD_BOUNDS,
        maxBoundsViscosity: 1,
        worldCopyJump: false,
        zoomControl: false,
        attributionControl: false,
        keyboard: true,
        renderer: L.svg(),
        zoomAnimation: !reduced,
        fadeAnimation: !reduced,
        markerZoomAnimation: !reduced,
      });
    } catch {
      emit('init-failed');
      // Deferred one microtask (not a timer) so the fallback renders outside the effect body.
      let active = true;
      queueMicrotask(() => {
        if (active) setInitFailed(true);
      });
      return () => {
        active = false;
      };
    }
    mapRef.current = map;
    emit('loading');

    const tiles = L.tileLayer(tileUrl, {
      noWrap: true,
      bounds: WORLD_BOUNDS,
      maxZoom: trackerPolicy.tileMaxZoom,
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    let health: TileHealth = { loadedAny: false, consecutiveErrors: 0 };
    const onTileLoad = () => {
      health = { loadedAny: true, consecutiveErrors: 0 };
      setTilesFailing(false);
      emit('ready');
    };
    const onTileError = () => {
      health = { ...health, consecutiveErrors: health.consecutiveErrors + 1 };
      const next = nextTileStatus(health);
      if (next === null) return;
      setTilesFailing(true);
      emit(next);
    };
    tiles.on('tileload', onTileLoad);
    tiles.on('tileerror', onTileError);
    tiles.addTo(map);
    createAttributionControl().addTo(map);
    trailRef.current = L.layerGroup().addTo(map);
    // The overlay pane holds only the decorative trail SVG (the status panel already states it).
    map.getPane('overlayPane')?.setAttribute('aria-hidden', 'true');

    // Follow ends now, not at the next render, so a resize mid-gesture cannot pan over the user.
    const userMoved = () => {
      followRef.current = false;
      callbacksRef.current.onUserMoved();
    };
    const onZoomStart = () => {
      if (programmaticRef.current === 0) userMoved();
    };
    map.on('dragstart', userMoved);
    map.on('zoomstart', onZoomStart);
    // Leaflet's keyboard pan only fires movestart, so detect the keys on the focused container.
    const onKey = (event: KeyboardEvent) => {
      if (event.target === el && isMapKey(event)) userMoved();
    };
    el.addEventListener('keydown', onKey);
    const onViewChange = () => placeLabel(map, markerRef.current);
    map.on('moveend zoomend resize', onViewChange);

    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            programmaticRef.current += 1;
            try {
              map.invalidateSize({ animate: false });
              const min = fitWorldZoom(el.clientWidth);
              if (map.getZoom() < min) map.setZoom(min, { animate: false });
              map.setMinZoom(min);
              // A resize brings no new position (paused, duplicate sample), so re-apply the
              // follow pan here or a clamped centre can leave the marker off-screen (R1).
              // With follow off the user's view is kept.
              const p = positionRef.current;
              if (followRef.current && p !== null) map.panTo([p[0], p[1]], { animate: false });
            } finally {
              programmaticRef.current -= 1;
            }
          })
        : null;
    observer?.observe(el);

    return () => {
      observer?.disconnect();
      el.removeEventListener('keydown', onKey);
      // map.remove() does not drop our own map listeners, so detach them explicitly.
      map.off('dragstart', userMoved);
      map.off('zoomstart', onZoomStart);
      map.off('moveend zoomend resize', onViewChange);
      tiles.off('tileload', onTileLoad);
      tiles.off('tileerror', onTileError);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      trailRef.current = null;
    };
  }, [tileUrl]);

  const lat = position?.[0];
  const lon = position?.[1];

  // Marker: created on the first position, then moved with setLatLng (never recreated).
  useEffect(() => {
    const map = mapRef.current;
    if (map === null) return;
    if (lat === undefined || lon === undefined) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const target: L.LatLngTuple = [lat, lon];
    const marker = markerRef.current;
    const previousLon = marker?.getLatLng().lng;
    if (marker === null) {
      const created = L.marker(target, { icon: ISS_ICON, keyboard: false, interactive: false });
      created.addTo(map);
      created.getElement()?.setAttribute('aria-hidden', 'true');
      markerRef.current = created;
    } else {
      marker.setLatLng(target);
    }
    placeLabel(map, markerRef.current);
    if (follow) {
      const jump = previousLon !== undefined && crossesAntimeridian(previousLon, lon);
      programmaticRef.current += 1;
      try {
        map.panTo(target, { animate: !jump && !prefersReducedMotion() });
      } finally {
        programmaticRef.current -= 1;
      }
    }
  }, [lat, lon, follow]);

  // Trail: one polyline per segment; segments are already split by the domain layer.
  useEffect(() => {
    const group = trailRef.current;
    if (group === null) return;
    group.clearLayers();
    for (const segment of trailSegments) {
      if (segment.length < 2) continue;
      const latLngs = segment.map(([sLat, sLon]): L.LatLngTuple => [sLat, sLon]);
      L.polyline(latLngs, { className: 'iss-trail', interactive: false }).addTo(group);
    }
  }, [trailSegments]);

  // Recenter request from the parent.
  useEffect(() => {
    if (recenterToken === lastRecenterRef.current) return;
    lastRecenterRef.current = recenterToken;
    const map = mapRef.current;
    const p = positionRef.current;
    if (map === null || p === null) return;
    // A recenter across the dateline jumps instead of sweeping ~358° over the whole map.
    const jump = crossesAntimeridian(map.getCenter().lng, p[1]);
    programmaticRef.current += 1;
    try {
      map.panTo([p[0], p[1]], { animate: !jump && !prefersReducedMotion() });
    } finally {
      programmaticRef.current -= 1;
    }
  }, [recenterToken]);

  /** Button-driven moves count as user moves (they end follow), like drag or keyboard. */
  const userAction = (act: (map: L.Map, animate: boolean) => void) => {
    const map = mapRef.current;
    if (map === null) return;
    followRef.current = false;
    callbacksRef.current.onUserMoved();
    act(map, !prefersReducedMotion());
  };

  const beyondProjection = lat !== undefined && Math.abs(lat) > MERCATOR_LAT_LIMIT;
  const hasPosition = lat !== undefined;

  const panPadId = useId();
  const [controlsOpen, setControlsOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const onPadKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setControlsOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <div className="iss-map">
      <div
        ref={containerRef}
        className="iss-map__canvas"
        role="region"
        aria-label="Map of the ISS position. When focused, arrow keys pan and plus or minus zoom. The position is also listed in the summary above."
      />
      {hasPosition && !initFailed && (
        <p
          className={`iss-map__follow${follow ? '' : ' iss-map__follow--off'}`}
          data-testid="follow-state"
        >
          {follow ? 'Following ISS' : 'Exploring map'}
        </p>
      )}
      {initFailed && (
        <div className="iss-map__fallback" data-testid="map-fallback">
          <p>
            <strong>Map unavailable.</strong> It could not be started in this browser.
          </p>
          <p>The ISS position is still listed in the summary above.</p>
        </div>
      )}
      {tilesFailing && !initFailed && (
        <p className="iss-map__notice" data-testid="map-tiles-failing">
          <strong>Map unavailable.</strong> Map images are not loading. The marker and the summary
          still show the position.
        </p>
      )}
      {beyondProjection && (
        <p className="iss-map__warning" data-testid="map-projection-warning">
          The ISS is beyond this map’s drawable latitude (±85.05°). The marker is shown at the edge;
          the coordinates in the summary are exact.
        </p>
      )}
      {!initFailed && (
        <div className="iss-map__zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="map-button"
            aria-label="Zoom in"
            onClick={() => userAction((m, animate) => m.zoomIn(1, { animate }))}
          >
            <span aria-hidden="true">+</span>
          </button>
          <button
            type="button"
            className="map-button"
            aria-label="Zoom out"
            onClick={() => userAction((m, animate) => m.zoomOut(1, { animate }))}
          >
            <span aria-hidden="true">−</span>
          </button>
        </div>
      )}
      {!initFailed && (
        <div className="iss-map__controls" onKeyDown={onPadKey}>
          {controlsOpen && (
            <div id={panPadId} className="iss-map__pad" role="group" aria-label="Pan the map">
              <button
                type="button"
                className="map-button"
                aria-label="Pan north"
                onClick={() => userAction((m, animate) => m.panBy([0, -PAN_STEP_PX], { animate }))}
              >
                <span aria-hidden="true">↑</span>
              </button>
              <button
                type="button"
                className="map-button"
                aria-label="Pan south"
                onClick={() => userAction((m, animate) => m.panBy([0, PAN_STEP_PX], { animate }))}
              >
                <span aria-hidden="true">↓</span>
              </button>
              <button
                type="button"
                className="map-button"
                aria-label="Pan west"
                onClick={() => userAction((m, animate) => m.panBy([-PAN_STEP_PX, 0], { animate }))}
              >
                <span aria-hidden="true">←</span>
              </button>
              <button
                type="button"
                className="map-button"
                aria-label="Pan east"
                onClick={() => userAction((m, animate) => m.panBy([PAN_STEP_PX, 0], { animate }))}
              >
                <span aria-hidden="true">→</span>
              </button>
            </div>
          )}
          <button
            ref={toggleRef}
            type="button"
            className="map-toggle"
            aria-expanded={controlsOpen}
            aria-controls={controlsOpen ? panPadId : undefined}
            onClick={() => setControlsOpen((open) => !open)}
          >
            Map controls
          </button>
        </div>
      )}
    </div>
  );
}
