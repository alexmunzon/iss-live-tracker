// Pure helpers for IssMap. No Leaflet instances, no timers.
import type { MapStatus } from '../../domain/position';

/** Web Mercator cannot draw beyond this latitude. */
export const MERCATOR_LAT_LIMIT = 85.0511;

/** [[south, west], [north, east]] in Leaflet order. */
export const WORLD_BOUNDS: [[number, number], [number, number]] = [
  [-MERCATOR_LAT_LIMIT, -180],
  [MERCATOR_LAT_LIMIT, 180],
];

export const INITIAL_CENTER: [number, number] = [20, 0];
export const INITIAL_ZOOM = 2;
export const PAN_STEP_PX = 160;

/** Consecutive tile errors (after at least one load) before the map is reported failing. */
export const TILE_ERROR_THRESHOLD = 3;

/** Smallest zoom at which one world copy is at least as wide as the map (256 px tiles). */
export function fitWorldZoom(widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx <= 256) return 0;
  return Math.min(3, Math.floor(Math.log2(widthPx / 256)));
}

/** True when a move between these longitudes crosses ±180 (draw as a jump, not a 358° sweep). */
export function crossesAntimeridian(fromLon: number, toLon: number): boolean {
  return Math.abs(toLon - fromLon) > 180;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const MAP_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '=', '-', '_']);

/** Keys Leaflet's keyboard handler uses to pan or zoom (ignored with modifiers, like Leaflet). */
export function isMapKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>) {
  return !event.ctrlKey && !event.altKey && !event.metaKey && MAP_KEYS.has(event.key);
}

export interface TileHealth {
  readonly loadedAny: boolean;
  readonly consecutiveErrors: number;
}

/**
 * After a tile error: report failing when nothing has ever loaded, or when
 * TILE_ERROR_THRESHOLD errors happen in a row after loads. Otherwise no change.
 */
export function nextTileStatus(health: TileHealth): MapStatus | null {
  if (health.consecutiveErrors === 0) return null;
  if (!health.loadedAny || health.consecutiveErrors >= TILE_ERROR_THRESHOLD) {
    return 'tiles-failing';
  }
  return null;
}
