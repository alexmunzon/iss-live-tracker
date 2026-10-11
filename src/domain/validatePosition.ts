// Pure validation of one untrusted provider payload (docs/contracts.md §1).
// No coercion: strings, booleans and null never become numbers.

import { trackerPolicy } from '../config/trackerPolicy';
import {
  ISS_NORAD_ID,
  PROVIDER_ID,
  type OptionalFieldIssue,
  type PositionSample,
  type ValidatePosition,
  type ValidationResult,
} from './position';

const ALTITUDE_MIN_KM = 100;
const ALTITUDE_MAX_KM = 2000;
const VELOCITY_MIN_KMH = 20_000;
const VELOCITY_MAX_KMH = 32_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own properties only, so nothing is read from Object.prototype. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function finiteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function reject(
  rejection: Extract<ValidationResult, { ok: false }>['rejection'],
): ValidationResult {
  return { ok: false, rejection };
}

export const validatePosition: ValidatePosition = (raw, receivedAtMs) => {
  if (!isRecord(raw)) return reject('not-an-object');

  if (own(raw, 'id') !== ISS_NORAD_ID) return reject('wrong-identity');
  if (Object.hasOwn(raw, 'name') && raw['name'] !== 'iss') return reject('wrong-identity');

  const latitude = own(raw, 'latitude');
  if (!finiteInRange(latitude, -90, 90)) return reject('invalid-latitude');
  const longitude = own(raw, 'longitude');
  if (!finiteInRange(longitude, -180, 180)) return reject('invalid-longitude');

  const timestamp = own(raw, 'timestamp');
  if (
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) ||
    !Number.isInteger(timestamp)
  ) {
    return reject('invalid-timestamp');
  }
  if (timestamp >= trackerPolicy.millisecondsHeuristicSec) {
    return reject('timestamp-looks-like-milliseconds');
  }
  if (timestamp < trackerPolicy.minTimestampSec) return reject('timestamp-implausible');

  const issues: OptionalFieldIssue[] = [];
  let altitudeKm: number | undefined;
  let velocityKmh: number | undefined;

  if (own(raw, 'units') !== 'kilometers') {
    issues.push('units-not-kilometers');
  } else {
    const altitude = own(raw, 'altitude');
    if (finiteInRange(altitude, ALTITUDE_MIN_KM, ALTITUDE_MAX_KM)) altitudeKm = altitude;
    else issues.push('altitude-invalid');
    const velocity = own(raw, 'velocity');
    if (finiteInRange(velocity, VELOCITY_MIN_KMH, VELOCITY_MAX_KMH)) velocityKmh = velocity;
    else issues.push('velocity-invalid');
  }

  const sample: PositionSample = {
    provider: PROVIDER_ID,
    satelliteId: ISS_NORAD_ID,
    latitudeDeg: latitude,
    longitudeDeg: longitude,
    // The only seconds → milliseconds conversion in the app.
    positionTimeMs: timestamp * 1000,
    receivedAtMs,
    ...(altitudeKm !== undefined ? { altitudeKm } : {}),
    ...(velocityKmh !== undefined ? { velocityKmh } : {}),
  };

  return { ok: true, sample, issues };
};
