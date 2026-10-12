import { describe, expect, it } from 'vitest';
import {
  MAX_FIT_ZOOM,
  crossesAntimeridian,
  fitWorldZoom,
} from '../../../src/features/map/mapHelpers';

describe('fitWorldZoom: one world copy always fills the map width (no empty side bands)', () => {
  it.each([
    [0, 0],
    [256, 0],
    [300, 1], // 390 px phone map is ~358 px wide
    [358, 1],
    [512, 1],
    [513, 2],
    [736, 2], // 768 px tablet
    [1024, 2],
    [1376, 3], // 1440 × 900 desktop with 32 px padding
    [2048, 3],
    [2049, 4],
    [8000, MAX_FIT_ZOOM],
  ])('%i px wide → zoom %i', (width, zoom) => {
    expect(fitWorldZoom(width)).toBe(zoom);
    // The defining property: the world (256 · 2^z px) is at least as wide as the map, up to the cap.
    if (zoom < MAX_FIT_ZOOM && width > 256) expect(256 * 2 ** zoom).toBeGreaterThanOrEqual(width);
  });

  it('non-finite widths fall back to zoom 0', () => {
    expect(fitWorldZoom(Number.NaN)).toBe(0);
    expect(fitWorldZoom(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('crossesAntimeridian', () => {
  it('detects a dateline jump but not an ordinary move', () => {
    expect(crossesAntimeridian(179.5, -179.5)).toBe(true);
    expect(crossesAntimeridian(-170, 170)).toBe(true);
    expect(crossesAntimeridian(-117.9, -118.4)).toBe(false);
  });
});
