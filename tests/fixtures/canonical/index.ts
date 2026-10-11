// Canonical fixtures (coordinator-owned, frozen at G1).
// Raw payloads mirror real Where the ISS at responses observed on 2026-10-11.
// QA's adversarial fixtures live separately in tests/fixtures/adversarial/.

import { ISS_NORAD_ID, PROVIDER_ID, type PositionSample } from '../../../src/domain/position';

/** Shape returned by GET /v1/satellites/25544 (units=kilometers default). */
export interface WtiaRawPosition {
  name: string;
  id: number;
  latitude: number;
  longitude: number;
  altitude: number;
  velocity: number;
  visibility: string;
  footprint: number;
  timestamp: number;
  daynum: number;
  solar_lat: number;
  solar_lon: number;
  units: string;
}

/** Observed via curl, 2026-10-11 14:01:23 UTC. */
export const observedCurl: WtiaRawPosition = {
  name: 'iss',
  id: 25544,
  latitude: 45.005782935448,
  longitude: -18.396323801261,
  altitude: 427.80542325056,
  velocity: 27571.550629451,
  visibility: 'daylight',
  footprint: 4546.9626673704,
  timestamp: 1791727283,
  daynum: 2461325.084294,
  solar_lat: -7.162498280395,
  solar_lon: 326.32915991832,
  units: 'kilometers',
};

/** Observed from http://localhost:5173 in a Chromium browser, 2026-10-11 14:36:53 UTC. */
export const observedBrowser: WtiaRawPosition = {
  name: 'iss',
  id: 25544,
  latitude: -48.909786887565,
  longitude: 89.064716652358,
  altitude: 432.21679121682,
  velocity: 27556.870662061,
  visibility: 'daylight',
  footprint: 4569.1019971457,
  timestamp: 1791729413,
  daynum: 2461325.1089468,
  solar_lat: -7.1717779891468,
  solar_lon: 317.45258156184,
  units: 'kilometers',
};

/** Build a raw payload with overrides. Starts from observedCurl. */
export function rawPosition(overrides: Partial<WtiaRawPosition> = {}): WtiaRawPosition {
  return { ...observedCurl, ...overrides };
}

/** Normalized sample expected from observedCurl when received at its own timestamp. */
export const observedCurlSample: PositionSample = {
  provider: PROVIDER_ID,
  satelliteId: ISS_NORAD_ID,
  latitudeDeg: 45.005782935448,
  longitudeDeg: -18.396323801261,
  positionTimeMs: 1791727283000,
  receivedAtMs: 1791727283000,
  altitudeKm: 427.80542325056,
  velocityKmh: 27571.550629451,
};

/** Build a normalized sample with overrides. */
export function sample(overrides: Partial<PositionSample> = {}): PositionSample {
  return { ...observedCurlSample, ...overrides };
}

/** Base wall time used across fixtures: 2026-10-11T14:01:23Z. */
export const T0_MS = 1791727283000;

/** One point per quadrant plus the origin. [name, lat, lon]. */
export const quadrantPoints = [
  ['north-east', 40.7, 74.0],
  ['north-west', 40.7, -74.0],
  ['south-east', -33.9, 151.2],
  ['south-west', -34.6, -58.4],
  ['origin', 0, 0],
  ['antimeridian-east', 10, 180],
  ['antimeridian-west', 10, -180],
] as const;

/** Consecutive 5 s samples crossing the antimeridian eastward (179 → -179). */
export const datelineEastward: readonly PositionSample[] = [
  sample({ latitudeDeg: 20.0, longitudeDeg: 178.6, positionTimeMs: T0_MS }),
  sample({ latitudeDeg: 20.1, longitudeDeg: 179.0, positionTimeMs: T0_MS + 5_000 }),
  sample({ latitudeDeg: 20.2, longitudeDeg: -179.0, positionTimeMs: T0_MS + 10_000 }),
  sample({ latitudeDeg: 20.3, longitudeDeg: -178.6, positionTimeMs: T0_MS + 15_000 }),
];

/** Same crossing westward (-179 → 179). */
export const datelineWestward: readonly PositionSample[] = [
  sample({ latitudeDeg: -20.0, longitudeDeg: -178.6, positionTimeMs: T0_MS }),
  sample({ latitudeDeg: -20.1, longitudeDeg: -179.0, positionTimeMs: T0_MS + 5_000 }),
  sample({ latitudeDeg: -20.2, longitudeDeg: 179.0, positionTimeMs: T0_MS + 10_000 }),
  sample({ latitudeDeg: -20.3, longitudeDeg: 178.6, positionTimeMs: T0_MS + 15_000 }),
];
