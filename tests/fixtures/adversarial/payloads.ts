// QA-owned adversarial fixtures (contract G1-v2).
// Every expected value below is written by hand from docs/contracts.md and the
// G1-v2 amendment. Nothing here is computed by calling production code.

import type {
  FetchFailure,
  OptionalFieldIssue,
  RetryAfter,
  ValidationRejection,
} from '../../../src/domain/position';
import { observedCurl, rawPosition, T0_MS, type WtiaRawPosition } from '../canonical/index';

/** observedCurl without one key. */
export function without(key: keyof WtiaRawPosition): Record<string, unknown> {
  return Object.fromEntries(Object.entries(observedCurl).filter(([k]) => k !== key));
}

/** Raw JSON text of a valid observedCurl payload. */
export const validJsonText = JSON.stringify(observedCurl);

/** Replace one property's JSON value with literal JSON text (lets us write 1e999, NaN, ...). */
export function withRawValue(key: string, rawJsonValue: string): string {
  const marker = '"__QA_MARKER__"';
  const text = JSON.stringify({ ...observedCurl, [key]: '__QA_MARKER__' });
  return text.replace(marker, rawJsonValue);
}

export const XSS_IMG = '<img src=x onerror="window.__qaXss=1">';
export const XSS_SCRIPT = '<script>window.__qaXss=1</script>';
export const XSS_SVG = '<svg onload="window.__qaXss=1"></svg>';

// ---------------------------------------------------------------------------
// Payload-level cases: body is JSON text served with 200 + application/json.
// ---------------------------------------------------------------------------

export type PayloadExpectation =
  | { readonly ok: false; readonly rejection: ValidationRejection }
  | {
      readonly ok: true;
      readonly latitudeDeg: number;
      readonly longitudeDeg: number;
      readonly positionTimeMs: number;
      /** undefined means the field must be absent from the sample. */
      readonly altitudeKm: number | undefined;
      readonly velocityKmh: number | undefined;
      readonly issues: readonly OptionalFieldIssue[];
    }
  /** JSON.parse itself must fail. */
  | { readonly ok: false; readonly failure: 'invalid-json' };

export interface PayloadCase {
  readonly name: string;
  readonly jsonText: string;
  readonly expected: PayloadExpectation;
}

const json = (value: unknown): string => JSON.stringify(value);

const okDefault = {
  ok: true,
  latitudeDeg: 45.005782935448,
  longitudeDeg: -18.396323801261,
  positionTimeMs: 1791727283000,
  altitudeKm: 427.80542325056,
  velocityKmh: 27571.550629451,
  issues: [],
} as const;

const reject = (rejection: ValidationRejection): PayloadExpectation => ({ ok: false, rejection });

export const payloadCases: readonly PayloadCase[] = [
  // --- shape ---
  { name: 'null', jsonText: 'null', expected: reject('not-an-object') },
  { name: 'empty array', jsonText: '[]', expected: reject('not-an-object') },
  {
    name: 'array wrapping a valid object',
    jsonText: json([observedCurl]),
    expected: reject('not-an-object'),
  },
  { name: 'bare string', jsonText: '"iss"', expected: reject('not-an-object') },
  { name: 'bare number', jsonText: '25544', expected: reject('not-an-object') },
  { name: 'bare boolean', jsonText: 'true', expected: reject('not-an-object') },
  { name: 'empty object', jsonText: '{}', expected: reject('wrong-identity') },

  // --- identity ---
  {
    name: 'id as string "25544"',
    jsonText: json(rawPosition({ id: '25544' as unknown as number })),
    expected: reject('wrong-identity'),
  },
  {
    name: 'id 25545 (another satellite)',
    jsonText: json(rawPosition({ id: 25545 })),
    expected: reject('wrong-identity'),
  },
  {
    name: 'id 25544.0001',
    jsonText: json(rawPosition({ id: 25544.0001 })),
    expected: reject('wrong-identity'),
  },
  {
    name: 'name "ISS" (wrong case)',
    jsonText: json(rawPosition({ name: 'ISS' })),
    expected: reject('wrong-identity'),
  },
  {
    name: 'script injection in name',
    jsonText: json(rawPosition({ name: XSS_IMG })),
    expected: reject('wrong-identity'),
  },
  {
    name: 'name absent is allowed',
    jsonText: json(without('name')),
    expected: okDefault,
  },

  // --- latitude / longitude: no coercion ---
  {
    name: 'latitude as string',
    jsonText: json(rawPosition({ latitude: '45.0' as unknown as number })),
    expected: reject('invalid-latitude'),
  },
  {
    name: 'latitude true',
    jsonText: withRawValue('latitude', 'true'),
    expected: reject('invalid-latitude'),
  },
  {
    name: 'latitude null',
    jsonText: withRawValue('latitude', 'null'),
    expected: reject('invalid-latitude'),
  },
  {
    name: 'latitude missing',
    jsonText: json(without('latitude')),
    expected: reject('invalid-latitude'),
  },
  {
    name: 'latitude 1e999 parses to Infinity',
    jsonText: withRawValue('latitude', '1e999'),
    expected: reject('invalid-latitude'),
  },
  {
    name: 'latitude -1e999 parses to -Infinity',
    jsonText: withRawValue('latitude', '-1e999'),
    expected: reject('invalid-latitude'),
  },
  {
    name: 'latitude 90.0001',
    jsonText: json(rawPosition({ latitude: 90.0001 })),
    expected: reject('invalid-latitude'),
  },
  {
    name: 'latitude -90.0001',
    jsonText: json(rawPosition({ latitude: -90.0001 })),
    expected: reject('invalid-latitude'),
  },
  {
    name: 'latitude exactly 90 is valid',
    jsonText: json(rawPosition({ latitude: 90 })),
    expected: { ...okDefault, latitudeDeg: 90 },
  },
  {
    name: 'longitude as string',
    jsonText: json(rawPosition({ longitude: '-18.39' as unknown as number })),
    expected: reject('invalid-longitude'),
  },
  {
    name: 'longitude false',
    jsonText: withRawValue('longitude', 'false'),
    expected: reject('invalid-longitude'),
  },
  {
    name: 'longitude 1e999',
    jsonText: withRawValue('longitude', '1e999'),
    expected: reject('invalid-longitude'),
  },
  {
    name: 'longitude -180.0001',
    jsonText: json(rawPosition({ longitude: -180.0001 })),
    expected: reject('invalid-longitude'),
  },
  {
    name: 'longitude 180.0001',
    jsonText: json(rawPosition({ longitude: 180.0001 })),
    expected: reject('invalid-longitude'),
  },
  {
    name: 'longitude exactly -180 is valid',
    jsonText: json(rawPosition({ longitude: -180 })),
    expected: { ...okDefault, longitudeDeg: -180 },
  },
  {
    name: '(0, 0) is valid',
    jsonText: json(rawPosition({ latitude: 0, longitude: 0 })),
    expected: { ...okDefault, latitudeDeg: 0, longitudeDeg: 0 },
  },
  {
    name: 'latitude 89 (beyond Mercator) is valid',
    jsonText: json(rawPosition({ latitude: 89 })),
    expected: { ...okDefault, latitudeDeg: 89 },
  },
  {
    name: 'duplicate key: last (string) latitude wins',
    jsonText: validJsonText.replace(/}$/, ',"latitude":"evil"}'),
    expected: reject('invalid-latitude'),
  },

  // --- timestamp ---
  {
    name: 'timestamp as string',
    jsonText: json(rawPosition({ timestamp: '1791727283' as unknown as number })),
    expected: reject('invalid-timestamp'),
  },
  {
    name: 'timestamp true',
    jsonText: withRawValue('timestamp', 'true'),
    expected: reject('invalid-timestamp'),
  },
  {
    name: 'timestamp fractional',
    jsonText: json(rawPosition({ timestamp: 1791727283.5 })),
    expected: reject('invalid-timestamp'),
  },
  {
    name: 'timestamp 1e999',
    jsonText: withRawValue('timestamp', '1e999'),
    expected: reject('invalid-timestamp'),
  },
  {
    name: 'timestamp in milliseconds',
    jsonText: json(rawPosition({ timestamp: 1791727283000 })),
    expected: reject('timestamp-looks-like-milliseconds'),
  },
  {
    name: 'timestamp exactly at ms heuristic (1e11)',
    jsonText: json(rawPosition({ timestamp: 100_000_000_000 })),
    expected: reject('timestamp-looks-like-milliseconds'),
  },
  {
    name: 'timestamp in 1990',
    jsonText: json(rawPosition({ timestamp: 631_152_000 })),
    expected: reject('timestamp-implausible'),
  },
  {
    name: 'timestamp one second before 2000-01-01',
    jsonText: json(rawPosition({ timestamp: 946_684_799 })),
    expected: reject('timestamp-implausible'),
  },
  {
    name: 'timestamp exactly 2000-01-01 passes validation',
    jsonText: json(rawPosition({ timestamp: 946_684_800 })),
    expected: { ...okDefault, positionTimeMs: 946_684_800_000 },
  },
  {
    name: 'timestamp just below ms heuristic passes validation (ordering must reject it later)',
    jsonText: json(rawPosition({ timestamp: 99_999_999_999 })),
    expected: { ...okDefault, positionTimeMs: 99_999_999_999_000 },
  },

  // --- optional fields ---
  {
    name: 'units miles drops both metrics',
    jsonText: json(rawPosition({ units: 'miles' })),
    expected: {
      ...okDefault,
      altitudeKm: undefined,
      velocityKmh: undefined,
      issues: ['units-not-kilometers'],
    },
  },
  {
    name: 'units missing drops both metrics',
    jsonText: json(without('units')),
    expected: {
      ...okDefault,
      altitudeKm: undefined,
      velocityKmh: undefined,
      issues: ['units-not-kilometers'],
    },
  },
  {
    name: 'huge velocity is dropped, sample kept',
    jsonText: json(rawPosition({ velocity: 9_999_999 })),
    expected: { ...okDefault, velocityKmh: undefined, issues: ['velocity-invalid'] },
  },
  {
    name: 'velocity 1e999 is dropped',
    jsonText: withRawValue('velocity', '1e999'),
    expected: { ...okDefault, velocityKmh: undefined, issues: ['velocity-invalid'] },
  },
  {
    name: 'altitude 50 km is dropped',
    jsonText: json(rawPosition({ altitude: 50 })),
    expected: { ...okDefault, altitudeKm: undefined, issues: ['altitude-invalid'] },
  },
  {
    name: 'altitude as string is dropped',
    jsonText: json(rawPosition({ altitude: '427' as unknown as number })),
    expected: { ...okDefault, altitudeKm: undefined, issues: ['altitude-invalid'] },
  },

  // --- unknown fields: accepted, never interpreted ---
  {
    name: 'extra unknown fields are accepted',
    jsonText: json({ ...observedCurl, extra: { nested: [1, 2, 3] }, another: 'value', z: null }),
    expected: okDefault,
  },
  {
    name: 'script injection in unknown and known string fields is accepted as data',
    jsonText: json({ ...observedCurl, visibility: XSS_IMG, note: XSS_SCRIPT, html: XSS_SVG }),
    expected: okDefault,
  },
  {
    name: '__proto__ key does not pollute and is ignored',
    jsonText: validJsonText.replace('{', '{"__proto__":{"qaPolluted":true},'),
    expected: okDefault,
  },

  // --- not JSON at all ---
  {
    name: 'NaN literal is not JSON',
    jsonText: withRawValue('latitude', 'NaN'),
    expected: { ok: false, failure: 'invalid-json' },
  },
  {
    name: 'Infinity literal is not JSON',
    jsonText: withRawValue('latitude', 'Infinity'),
    expected: { ok: false, failure: 'invalid-json' },
  },
  { name: 'empty body', jsonText: '', expected: { ok: false, failure: 'invalid-json' } },
  {
    name: 'truncated JSON',
    jsonText: validJsonText.slice(0, 40),
    expected: { ok: false, failure: 'invalid-json' },
  },
];

// ---------------------------------------------------------------------------
// Response-level cases: status, headers and body bytes. Expected FetchFailure kinds.
// ---------------------------------------------------------------------------

export interface ResponseCase {
  readonly name: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** null → Response with no body. */
  readonly body: string | Uint8Array | null;
  /** Mark the Response as redirected / opaqueredirect (set on the object). */
  readonly redirected?: boolean;
  readonly opaqueRedirect?: boolean;
  readonly expected: { readonly ok: true } | { readonly ok: false; readonly failure: FetchFailure };
}

const JSON_CT = { 'Content-Type': 'application/json' } as const;
export const HTML_ERROR_PAGE =
  '<!doctype html><html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1><img src=x onerror="window.__qaXss=1"></body></html>';

/** 70 KiB of valid JSON (padding in an unknown field). */
export const json70KiB = JSON.stringify({ ...observedCurl, padding: 'x'.repeat(70 * 1024) });
/** Valid JSON padded with trailing whitespace to exactly 64 KiB (65 536 bytes): must be accepted. */
export const jsonExactly64KiB = validJsonText + ' '.repeat(64 * 1024 - validJsonText.length);
/** 64 KiB + 1 byte. */
export const jsonOneByteOver = jsonExactly64KiB + ' ';

/** Bytes that are not valid UTF-8 inside an otherwise JSON-looking body (G1-v2: invalid-json). */
export const invalidUtf8Body = new Uint8Array([
  ...new TextEncoder().encode(validJsonText.slice(0, -1) + ',"bad":"'),
  0xff,
  0xfe,
  0xc3,
  0x28,
  ...new TextEncoder().encode('"}'),
]);

const httpFailure = (status: number, retryAfter: RetryAfter | null = null): FetchFailure => ({
  kind: 'http',
  status,
  retryAfter,
  serverDateMs: null,
});

export const SERVER_DATE_HEADER = 'Sun, 11 Oct 2026 14:01:23 GMT'; // = T0_MS
export const SERVER_DATE_MS = T0_MS;

export const responseCases: readonly ResponseCase[] = [
  {
    name: '200 valid JSON',
    status: 200,
    headers: JSON_CT,
    body: validJsonText,
    expected: { ok: true },
  },
  {
    name: '200 application/json; charset=utf-8',
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: validJsonText,
    expected: { ok: true },
  },
  {
    name: '200 HTML error page with text/html',
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: HTML_ERROR_PAGE,
    expected: { ok: false, failure: { kind: 'unexpected-content-type' } },
  },
  {
    name: '502 HTML error page is an http failure first',
    status: 502,
    headers: { 'Content-Type': 'text/html' },
    body: HTML_ERROR_PAGE,
    expected: { ok: false, failure: httpFailure(502) },
  },
  {
    name: '200 JSON body served as text/plain',
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
    body: validJsonText,
    expected: { ok: false, failure: { kind: 'unexpected-content-type' } },
  },
  {
    name: 'G1-v2: application/jsonp is not application/json',
    status: 200,
    headers: { 'Content-Type': 'application/jsonp' },
    body: validJsonText,
    expected: { ok: false, failure: { kind: 'unexpected-content-type' } },
  },
  {
    name: 'G1-v2: text/html;x=application/json is rejected by MIME essence',
    status: 200,
    headers: { 'Content-Type': 'text/html;x=application/json' },
    body: validJsonText,
    expected: { ok: false, failure: { kind: 'unexpected-content-type' } },
  },
  {
    name: 'missing Content-Type',
    status: 200,
    headers: {},
    body: new TextEncoder().encode(validJsonText),
    expected: { ok: false, failure: { kind: 'unexpected-content-type' } },
  },
  {
    name: '70 KiB JSON with honest Content-Length',
    status: 200,
    headers: { ...JSON_CT, 'Content-Length': String(json70KiB.length) },
    body: json70KiB,
    expected: { ok: false, failure: { kind: 'body-too-large' } },
  },
  {
    name: '70 KiB JSON without Content-Length (streamed)',
    status: 200,
    headers: JSON_CT,
    body: json70KiB,
    expected: { ok: false, failure: { kind: 'body-too-large' } },
  },
  {
    name: '70 KiB JSON with a lying small Content-Length',
    status: 200,
    headers: { ...JSON_CT, 'Content-Length': '311' },
    body: json70KiB,
    expected: { ok: false, failure: { kind: 'body-too-large' } },
  },
  {
    name: 'exactly 64 KiB is accepted',
    status: 200,
    headers: JSON_CT,
    body: jsonExactly64KiB,
    expected: { ok: true },
  },
  {
    name: '64 KiB + 1 byte is rejected',
    status: 200,
    headers: JSON_CT,
    body: jsonOneByteOver,
    expected: { ok: false, failure: { kind: 'body-too-large' } },
  },
  {
    name: 'G1-v2: 200 with null body is invalid-json',
    status: 200,
    headers: JSON_CT,
    body: null,
    expected: { ok: false, failure: { kind: 'invalid-json' } },
  },
  {
    name: 'G1-v2: invalid UTF-8 is invalid-json',
    status: 200,
    headers: JSON_CT,
    body: invalidUtf8Body,
    expected: { ok: false, failure: { kind: 'invalid-json' } },
  },
  {
    name: 'redirected response',
    status: 200,
    headers: JSON_CT,
    body: validJsonText,
    redirected: true,
    expected: { ok: false, failure: { kind: 'redirect' } },
  },
  {
    name: '500 without headers',
    status: 500,
    headers: {},
    body: '',
    expected: { ok: false, failure: httpFailure(500) },
  },
  {
    name: '429 Retry-After 120 seconds',
    status: 429,
    headers: { 'Retry-After': '120' },
    body: '',
    expected: { ok: false, failure: httpFailure(429, { kind: 'seconds', seconds: 120 }) },
  },
  {
    name: '429 Retry-After 0 seconds',
    status: 429,
    headers: { 'Retry-After': '0' },
    body: '',
    expected: { ok: false, failure: httpFailure(429, { kind: 'seconds', seconds: 0 }) },
  },
  {
    name: '429 Retry-After 86400 (upper bound) is valid',
    status: 429,
    headers: { 'Retry-After': '86400' },
    body: '',
    expected: { ok: false, failure: httpFailure(429, { kind: 'seconds', seconds: 86400 }) },
  },
  ...['1e9', '99999999999', '-1', '+5', '1.5', '86401', 'soon', ''].map((value): ResponseCase => ({
    name: `G1-v2: 429 Retry-After ${JSON.stringify(value)} is ignored`,
    status: 429,
    headers: { 'Retry-After': value },
    body: '',
    expected: { ok: false, failure: httpFailure(429, null) },
  })),
  {
    name: '429 Retry-After HTTP-date with server Date',
    status: 429,
    headers: { 'Retry-After': 'Sun, 11 Oct 2026 14:02:53 GMT', Date: SERVER_DATE_HEADER },
    body: '',
    expected: {
      ok: false,
      failure: {
        kind: 'http',
        status: 429,
        retryAfter: { kind: 'date', epochMs: T0_MS + 90_000 },
        serverDateMs: SERVER_DATE_MS,
      },
    },
  },
  {
    name: '404 is http 404',
    status: 404,
    headers: JSON_CT,
    body: '{"error":"not found"}',
    expected: { ok: false, failure: httpFailure(404) },
  },
];

/** A position payload whose timestamp tracks a given wall-clock time (whole seconds). */
export function payloadAt(wallMs: number, lat = 45.005782935448, lon = -18.396323801261): string {
  return JSON.stringify(
    rawPosition({ timestamp: Math.floor(wallMs / 1000), latitude: lat, longitude: lon }),
  );
}
