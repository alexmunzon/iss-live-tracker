import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import L from 'leaflet';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IssMap } from '../../../src/features/map/IssMap';
import type { IssMapProps, LatLngTuple, TrailSegment } from '../../../src/domain/position';
import { datelineEastward, datelineWestward, quadrantPoints } from '../../fixtures/canonical/index';

const realMap = L.map;
let maps: L.Map[] = [];
let removed: L.Map[] = [];

beforeEach(() => {
  maps = [];
  removed = [];
  vi.spyOn(L, 'map').mockImplementation((element, options) => {
    const m = realMap(element, options);
    const originalRemove = m.remove.bind(m);
    vi.spyOn(m, 'remove').mockImplementation(() => {
      removed.push(m);
      return originalRemove();
    });
    maps.push(m);
    return m;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function props(overrides: Partial<IssMapProps> = {}): IssMapProps {
  return {
    position: null,
    trailSegments: [],
    follow: true,
    onUserMoved: vi.fn(),
    recenterToken: 0,
    onStatusChange: vi.fn(),
    ...overrides,
  };
}

function liveMap(): L.Map {
  const live = maps.filter((m) => !removed.includes(m));
  expect(live).toHaveLength(1);
  const m = live[0];
  if (m === undefined) throw new Error('no live map');
  return m;
}

function layersOf<T extends L.Layer>(m: L.Map, type: abstract new (...args: never[]) => T): T[] {
  const found: T[] = [];
  m.eachLayer((layer) => {
    if (layer instanceof type) found.push(layer);
  });
  return found;
}

const markers = (m: L.Map) => layersOf(m, L.Marker);
const polylines = (m: L.Map) => layersOf(m, L.Polyline);

/** Same split rule as docs/contracts.md §6 (antimeridian only; samples are 5 s apart). */
function splitAtAntimeridian(points: readonly LatLngTuple[]): TrailSegment[] {
  const segments: LatLngTuple[][] = [];
  let current: LatLngTuple[] = [];
  for (const p of points) {
    const prev = current[current.length - 1];
    if (prev !== undefined && Math.abs(p[1] - prev[1]) > 180) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  }
  segments.push(current);
  return segments.filter((s) => s.length >= 2);
}

describe('IssMap', () => {
  it('A01: places the marker at [lat, lon] (Leaflet order) for every quadrant point', () => {
    const p = props();
    const { rerender } = render(<IssMap {...p} />);
    for (const [, lat, lon] of quadrantPoints) {
      rerender(<IssMap {...p} position={[lat, lon]} />);
      const m = liveMap();
      const all = markers(m);
      expect(all).toHaveLength(1);
      const ll = all[0]?.getLatLng();
      expect(ll?.lat).toBe(lat);
      expect(ll?.lng).toBe(lon);
    }
  });

  it('A01: the same marker instance is moved, never recreated', () => {
    const p = props();
    const { rerender } = render(<IssMap {...p} position={[40.7, 74.0]} />);
    const first = markers(liveMap())[0];
    rerender(<IssMap {...p} position={[-33.9, 151.2]} />);
    expect(markers(liveMap())[0]).toBe(first);
  });

  it('A10: Strict Mode double mount leaves exactly one map, and cleanup removes it', () => {
    const { container, unmount } = render(
      <StrictMode>
        <IssMap {...props({ position: [10, 20] })} />
      </StrictMode>,
    );
    expect(maps.length).toBe(2);
    expect(removed.length).toBe(1);
    const m = liveMap();
    expect(container.querySelectorAll('.leaflet-container')).toHaveLength(1);
    expect(markers(m)).toHaveLength(1);
    expect(container.querySelectorAll('.leaflet-marker-icon')).toHaveLength(1);
    unmount();
    expect(removed).toContain(m);
    expect(maps.every((x) => removed.includes(x))).toBe(true);
  });

  it('A10: unmount then remount creates a fresh working map without leaked listeners', () => {
    const p = props({ position: [10, 20] });
    const first = render(<IssMap {...p} />);
    const m1 = liveMap();
    const userMoved = vi.fn();
    const statusChange = vi.fn();
    first.rerender(<IssMap {...p} onUserMoved={userMoved} onStatusChange={statusChange} />);
    const tiles1 = layersOf(m1, L.TileLayer)[0];
    first.unmount();
    expect(removed).toContain(m1);
    // A removed map must not reach the callbacks any more.
    m1.fire('dragstart');
    m1.fire('zoomstart');
    tiles1?.fire('tileerror');
    expect(userMoved).not.toHaveBeenCalled();
    expect(statusChange).not.toHaveBeenCalled();

    render(<IssMap {...p} />);
    const m2 = liveMap();
    expect(m2).not.toBe(m1);
    expect(markers(m2)).toHaveLength(1);
  });

  it.each([
    ['eastward', datelineEastward],
    ['westward', datelineWestward],
  ])('A11: dateline %s: marker jumps without animation, trail split per segment', (_, samples) => {
    const p = props({ follow: true });
    const { rerender } = render(<IssMap {...p} />);
    const m = liveMap();
    const panSpy = vi.spyOn(m, 'panTo');
    const seen: LatLngTuple[] = [];
    for (const s of samples) {
      seen.push([s.latitudeDeg, s.longitudeDeg]);
      rerender(
        <IssMap
          {...p}
          position={[s.latitudeDeg, s.longitudeDeg]}
          trailSegments={splitAtAntimeridian(seen)}
        />,
      );
    }
    // Sample index 2 is the crossing (±179 → ∓179): that pan must not animate.
    const crossing = panSpy.mock.calls[2];
    expect(crossing?.[1]).toEqual({ animate: false });
    const marker = markers(m)[0];
    expect(marker?.getLatLng().lng).toBe(samples[3]?.longitudeDeg);
    const lines = polylines(m);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const lngs = (line.getLatLngs() as L.LatLng[]).map((ll) => ll.lng);
      for (let i = 1; i < lngs.length; i += 1) {
        expect(Math.abs((lngs[i] ?? 0) - (lngs[i - 1] ?? 0))).toBeLessThanOrEqual(180);
      }
    }
  });

  it('A11: segments with fewer than 2 points are not drawn', () => {
    render(<IssMap {...props({ trailSegments: [[[1, 2]], []] })} />);
    expect(polylines(liveMap())).toHaveLength(0);
  });

  it('A12: user dragstart and zoomstart call onUserMoved', () => {
    const onUserMoved = vi.fn();
    render(<IssMap {...props({ onUserMoved, position: [10, 20] })} />);
    const m = liveMap();
    m.fire('dragstart');
    expect(onUserMoved).toHaveBeenCalledTimes(1);
    m.fire('zoomstart');
    expect(onUserMoved).toHaveBeenCalledTimes(2);
  });

  it('A12: keyboard pan on the focused map container calls onUserMoved', () => {
    const onUserMoved = vi.fn();
    render(<IssMap {...props({ onUserMoved })} />);
    const region = screen.getByRole('region', { name: /map of the iss position/i });
    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    expect(onUserMoved).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(region, { key: 'Tab' });
    expect(onUserMoved).toHaveBeenCalledTimes(1);
  });

  it('A12: programmatic follow pans (and programmatic zoom) do not call onUserMoved', () => {
    const onUserMoved = vi.fn();
    const p = props({ onUserMoved, follow: true });
    const { rerender } = render(<IssMap {...p} position={[10, 20]} />);
    const m = liveMap();
    const panSpy = vi.spyOn(m, 'panTo');
    rerender(<IssMap {...p} position={[11, 25]} />);
    rerender(<IssMap {...p} position={[12, 30]} />);
    expect(panSpy).toHaveBeenCalledTimes(2);
    expect(panSpy.mock.calls[1]?.[0]).toEqual([12, 30]);
    expect(m.getZoom()).toBe(2);
    expect(onUserMoved).not.toHaveBeenCalled();
  });

  it('A12: follow false does not pan; recenterToken change pans to the current position', () => {
    const p = props({ follow: false });
    const { rerender } = render(<IssMap {...p} position={[10, 20]} />);
    const m = liveMap();
    const panSpy = vi.spyOn(m, 'panTo');
    rerender(<IssMap {...p} position={[15, 40]} />);
    expect(panSpy).not.toHaveBeenCalled();
    rerender(<IssMap {...p} position={[15, 40]} recenterToken={1} />);
    expect(panSpy).toHaveBeenCalledTimes(1);
    expect(panSpy.mock.calls[0]?.[0]).toEqual([15, 40]);
    expect(p.onUserMoved).not.toHaveBeenCalled();
  });

  it('A12: zoom and pan buttons work without dragging and end follow', () => {
    const onUserMoved = vi.fn();
    render(<IssMap {...props({ onUserMoved, position: [10, 20] })} />);
    const m = liveMap();
    const panBy = vi.spyOn(m, 'panBy');
    const zoomIn = vi.spyOn(m, 'zoomIn');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoomIn).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pan north' }));
    expect(panBy.mock.calls.at(-1)?.[0]).toEqual([0, -160]);
    for (const name of ['Zoom out', 'Pan south', 'Pan west', 'Pan east']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(onUserMoved).toHaveBeenCalled();
  });

  it('A13: no marker while position is null', () => {
    render(<IssMap {...props({ position: null })} />);
    const m = liveMap();
    expect(markers(m)).toHaveLength(0);
    expect(document.querySelector('.leaflet-marker-icon')).toBeNull();
  });

  it('A13: tile errors report tiles-failing; a tile load reports ready', () => {
    const onStatusChange = vi.fn();
    render(<IssMap {...props({ onStatusChange })} />);
    const m = liveMap();
    expect(onStatusChange).toHaveBeenLastCalledWith('loading');
    const tiles = layersOf(m, L.TileLayer)[0];
    if (tiles === undefined) throw new Error('no tile layer');
    const fire = (type: string) => act(() => void tiles.fire(type));
    fire('tileerror');
    expect(onStatusChange).toHaveBeenLastCalledWith('tiles-failing');
    expect(screen.getByTestId('map-tiles-failing')).toBeInTheDocument();
    fire('tileload');
    expect(onStatusChange).toHaveBeenLastCalledWith('ready');
    expect(screen.queryByTestId('map-tiles-failing')).toBeNull();
    // After loads, one stray error is tolerated; three in a row are not.
    fire('tileerror');
    expect(onStatusChange).toHaveBeenLastCalledWith('ready');
    fire('tileerror');
    fire('tileerror');
    expect(onStatusChange).toHaveBeenLastCalledWith('tiles-failing');
  });

  it('A13: L.map throwing reports init-failed and renders a fallback message', async () => {
    vi.mocked(L.map).mockImplementation(() => {
      throw new Error('no canvas');
    });
    const onStatusChange = vi.fn();
    render(<IssMap {...props({ onStatusChange })} />);
    expect(onStatusChange).toHaveBeenCalledWith('init-failed');
    expect(await screen.findByTestId('map-fallback')).toHaveTextContent(
      'The map could not be started',
    );
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull();
  });

  it('shows a projection warning beyond ±85.0511° without changing the coordinates', () => {
    const { rerender } = render(<IssMap {...props({ position: [85.05, 0] })} />);
    expect(screen.queryByTestId('map-projection-warning')).toBeNull();
    rerender(<IssMap {...props({ position: [-86, 0] })} />);
    expect(screen.getByTestId('map-projection-warning')).toBeInTheDocument();
    expect(markers(liveMap())[0]?.getLatLng().lat).toBe(-86);
  });

  it('bounded world, accessible region and text-only attribution link', () => {
    const { container } = render(<IssMap {...props()} />);
    const m = liveMap();
    expect(m.options.worldCopyJump).toBe(false);
    expect(m.options.maxBounds).toBeDefined();
    const tiles = layersOf(m, L.TileLayer)[0];
    expect(tiles?.options.noWrap).toBe(true);
    expect(screen.getByRole('region', { name: /map of the iss position/i })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: '© OpenStreetMap contributors' });
    expect(link).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
    // G1-v2: marker icon has no HTML content and nothing uses inline style strings from us.
    act(() => undefined);
    expect(container.querySelector('.iss-marker')).toBeNull();
  });

  it('G1-v2: marker uses a className-only divIcon with no inner HTML', () => {
    const { container } = render(<IssMap {...props({ position: [1, 2] })} />);
    const icon = container.querySelector('.leaflet-marker-icon.iss-marker');
    expect(icon).not.toBeNull();
    expect(icon?.innerHTML).toBe('');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });
});
