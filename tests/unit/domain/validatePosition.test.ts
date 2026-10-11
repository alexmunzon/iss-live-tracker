import { describe, expect, it } from 'vitest';
import { validatePosition } from '../../../src/domain/validatePosition';
import {
  observedBrowser,
  observedCurl,
  observedCurlSample,
  quadrantPoints,
  rawPosition,
  T0_MS,
} from '../../fixtures/canonical';

function rejection(raw: unknown): string | null {
  const result = validatePosition(raw, T0_MS);
  return result.ok ? null : result.rejection;
}

function withField(key: string, value: unknown): Record<string, unknown> {
  return { ...rawPosition(), [key]: value };
}

function without(key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rawPosition()).filter(([k]) => k !== key));
}

describe('A01 validatePosition: valid inputs', () => {
  it('A01 normalizes the observed curl payload exactly', () => {
    expect(validatePosition(observedCurl, T0_MS)).toEqual({
      ok: true,
      sample: observedCurlSample,
      issues: [],
    });
  });

  it('A01 accepts the observed browser payload', () => {
    const result = validatePosition(observedBrowser, T0_MS);
    expect(result.ok).toBe(true);
  });

  it.each(quadrantPoints)('A01 accepts quadrant %s (%d, %d)', (_name, lat, lon) => {
    const result = validatePosition(rawPosition({ latitude: lat, longitude: lon }), T0_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sample.latitudeDeg).toBe(lat);
      expect(result.sample.longitudeDeg).toBe(lon);
    }
  });

  it.each([
    [90, 180],
    [-90, -180],
    [85.06, 0],
    [-85.06, 0],
  ])('A01 accepts boundary lat %d lon %d (incl. beyond Mercator ±85.0511)', (lat, lon) => {
    expect(validatePosition(rawPosition({ latitude: lat, longitude: lon }), T0_MS).ok).toBe(true);
  });

  it('A01 ignores unknown extra fields and converts seconds to ms exactly once', () => {
    const result = validatePosition({ ...rawPosition(), extra: '<script>' }, 123);
    expect(result.ok && result.sample.positionTimeMs).toBe(observedCurl.timestamp * 1000);
    expect(result.ok && result.sample.receivedAtMs).toBe(123);
    expect(result.ok && 'extra' in result.sample).toBe(false);
  });

  it('A01 accepts a payload without name', () => {
    expect(validatePosition(without('name'), T0_MS).ok).toBe(true);
  });
});

describe('A02 validatePosition: rejections', () => {
  it.each([
    ['null', null],
    ['array', [observedCurl]],
    ['string', 'iss'],
    ['number', 25544],
    ['undefined', undefined],
  ])('A02 rejects %s as not-an-object', (_label, raw) => {
    expect(rejection(raw)).toBe('not-an-object');
  });

  it.each([
    ['string id "25544"', withField('id', '25544')],
    ['other id', withField('id', 25545)],
    ['missing id', without('id')],
    ['wrong name', withField('name', 'tiangong')],
    ['null name', withField('name', null)],
  ])('A02 rejects %s as wrong-identity', (_label, raw) => {
    expect(rejection(raw)).toBe('wrong-identity');
  });

  it('A02 does not read id from the prototype', () => {
    const proto = { id: 25544 };
    const raw: Record<string, unknown> = Object.create(proto) as Record<string, unknown>;
    Object.assign(raw, without('id'));
    expect(rejection(raw)).toBe('wrong-identity');
  });

  const badNumbers: [string, unknown][] = [
    ['missing', undefined],
    ['null', null],
    ['string', '45.0'],
    ['boolean', true],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ];

  it.each(badNumbers)('A02 rejects %s latitude', (_label, value) => {
    const raw = value === undefined ? without('latitude') : withField('latitude', value);
    expect(rejection(raw)).toBe('invalid-latitude');
  });

  it.each(badNumbers)('A02 rejects %s longitude', (_label, value) => {
    const raw = value === undefined ? without('longitude') : withField('longitude', value);
    expect(rejection(raw)).toBe('invalid-longitude');
  });

  it.each([90.0001, -90.0001, 1000])('A02 rejects out-of-range latitude %d', (lat) => {
    expect(rejection(rawPosition({ latitude: lat }))).toBe('invalid-latitude');
  });

  it.each([180.0001, -180.0001, 360])('A02 rejects out-of-range longitude %d', (lon) => {
    expect(rejection(rawPosition({ longitude: lon }))).toBe('invalid-longitude');
  });

  it.each([
    ['missing', without('timestamp')],
    ['string', withField('timestamp', '1791727283')],
    ['fractional', withField('timestamp', 1791727283.5)],
    ['NaN', withField('timestamp', Number.NaN)],
    ['null', withField('timestamp', null)],
  ])('A02 rejects %s timestamp as invalid-timestamp', (_label, raw) => {
    expect(rejection(raw)).toBe('invalid-timestamp');
  });

  it('A02 drops invalid optional values with issues while the sample stays valid', () => {
    const result = validatePosition(rawPosition({ altitude: 50, velocity: 99_999 }), T0_MS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.altitudeKm).toBeUndefined();
    expect(result.sample.velocityKmh).toBeUndefined();
    expect('altitudeKm' in result.sample).toBe(false);
    expect(result.issues).toEqual(['altitude-invalid', 'velocity-invalid']);
  });

  it.each([Number.NaN, '427', null])('A02 drops non-numeric altitude %s', (altitude) => {
    const result = validatePosition(withField('altitude', altitude), T0_MS);
    expect(result.ok && result.issues).toEqual(['altitude-invalid']);
    expect(result.ok && result.sample.velocityKmh).toBe(observedCurl.velocity);
  });

  it('A02 drops both metrics when units are not kilometers', () => {
    const result = validatePosition(rawPosition({ units: 'miles' }), T0_MS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.issues).toEqual(['units-not-kilometers']);
    expect(result.sample.altitudeKm).toBeUndefined();
    expect(result.sample.velocityKmh).toBeUndefined();
  });
});

describe('A03 validatePosition: timestamp units and plausibility', () => {
  it('A03 rejects a millisecond timestamp', () => {
    expect(rejection(rawPosition({ timestamp: T0_MS }))).toBe('timestamp-looks-like-milliseconds');
  });

  it('A03 accepts the largest value below the milliseconds heuristic', () => {
    expect(rejection(rawPosition({ timestamp: 99_999_999_999 }))).toBeNull();
  });

  it('A03 rejects an implausibly old timestamp', () => {
    expect(rejection(rawPosition({ timestamp: 946_684_799 }))).toBe('timestamp-implausible');
    expect(rejection(rawPosition({ timestamp: 0 }))).toBe('timestamp-implausible');
    expect(rejection(rawPosition({ timestamp: 946_684_800 }))).toBeNull();
  });
});
