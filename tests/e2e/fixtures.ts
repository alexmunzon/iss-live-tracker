// QA E2E fixtures (contract G1-v2).
//
// Every test gets:
//  - `iss`: a programmable stub for https://api.wheretheiss.at (queue + fallback).
//  - tiles from tile.openstreetmap.org fulfilled with a local 256×256 PNG (or failed on demand).
//  - a network guard: any other non-local request is aborted and fails the test.
//  - a paused Playwright clock at T0 (2026-10-11T14:01:23Z); time moves only via `advance`.
//  - CSP violation capture; the document must send a CSP header (missing header = failure).
//  - dialog capture (any alert/confirm = injection executed = failure).
//
// ASSUMPTIONS (coordinator to freeze/align):
//  E1. The ISS marker is a Leaflet marker in `.leaflet-marker-pane`, or carries
//      data-testid="iss-marker". Recommend freezing data-testid="iss-marker".
//  E2. The map container is `.leaflet-container`.
//  E3. The app issues its first request on load and polls on the page's setTimeout,
//      so Playwright's fake clock controls cadence.

import { test as base, expect, type Page, type Request, type Route } from '@playwright/test';

export const T0_MS = 1791727283000;
export const ISS_HOST = 'api.wheretheiss.at';
export const ISS_URL = 'https://api.wheretheiss.at/v1/satellites/25544';
export const TILE_HOST = 'tile.openstreetmap.org';

/** 256×256 8-bit grayscale PNG, generated with zlib (369 bytes). */
export const TILE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAAAAAB5Gfe6AAABOElEQVR42u3QgQAAAAwEofdnO6iBrBBaz02AAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAioA1UPC/VEqV9mAAAAAElFTkSuQmCC';

/**
 * Node Buffer of the tile. Playwright's fulfill() base64-encodes a body with
 * body.toString('base64'), which only works for a real Buffer (a plain Uint8Array
 * would be mis-encoded). Reached via globalThis because @types/node is not installed.
 */
const NodeBuffer = (
  globalThis as unknown as { Buffer: { from(data: string, encoding: 'base64'): Uint8Array } }
).Buffer;
export const tileBody = () => NodeBuffer.from(TILE_PNG_BASE64, 'base64');

export interface RawPosition {
  name?: unknown;
  id?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  timestamp?: unknown;
  [key: string]: unknown;
}

/** Valid WTIA payload (mirrors canonical observedCurl) with overrides. */
export function position(overrides: RawPosition = {}): RawPosition {
  return {
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
    ...overrides,
  };
}

export type IssReply =
  | { readonly status?: number; readonly headers?: Record<string, string>; readonly body: string }
  | { readonly abort: 'failed' | 'timedout' | 'connectionreset' };

export interface IssStub {
  /** Replies used in order before the fallback. */
  queue(...replies: IssReply[]): void;
  /** Reply builder used when the queue is empty. Receives the simulated page time. */
  setFallback(make: (nowMs: number) => IssReply): void;
  readonly requests: Request[];
  /** JSON reply for a position at the current simulated time. */
  ok(overrides?: RawPosition): IssReply;
}

export interface Tracker {
  /** Navigate to the app with the clock paused at T0. */
  open(): Promise<void>;
  /** Advance the page clock (in steps so network work can interleave). */
  advance(ms: number, stepMs?: number): Promise<void>;
  /** Simulated page wall time. */
  now(): number;
  marker(): ReturnType<Page['locator']>;
  map(): ReturnType<Page['locator']>;
  tiles: { fail: boolean };
}

interface Fixtures {
  iss: IssStub;
  tracker: Tracker;
  unexpectedRequests: string[];
}

export const json = (body: unknown, status = 200): IssReply => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require a destructured first argument
  unexpectedRequests: async ({}, provide) => {
    await provide([]);
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require a destructured first argument
  iss: async ({}, provide) => {
    let simNow = T0_MS;
    const queued: IssReply[] = [];
    let fallback: (nowMs: number) => IssReply = (nowMs) =>
      json(position({ timestamp: Math.floor(nowMs / 1000) }));
    const stub: IssStub & { _setNow(ms: number): void; _next(): IssReply } = {
      requests: [],
      queue: (...r) => {
        queued.push(...r);
      },
      setFallback: (make) => {
        fallback = make;
      },
      ok: (overrides = {}) =>
        json(position({ timestamp: Math.floor(simNow / 1000), ...overrides })),
      _setNow: (ms) => {
        simNow = ms;
      },
      _next: () => queued.shift() ?? fallback(simNow),
    };
    await provide(stub);
  },

  tracker: async ({ page, iss, unexpectedRequests, baseURL }, provide) => {
    const appOrigin = new URL(baseURL ?? 'http://localhost:4173').origin;
    const internal = iss as IssStub & { _setNow(ms: number): void; _next(): IssReply };
    const tiles = { fail: false };
    const dialogs: string[] = [];
    const cspConsole: string[] = [];
    let documentCsp: string | null = null;
    let simNow = T0_MS;

    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    page.on('console', (msg) => {
      if (/Content Security Policy|Content-Security-Policy/i.test(msg.text()))
        cspConsole.push(msg.text());
    });
    page.on('response', (res) => {
      if (res.request().resourceType() === 'document' && res.url().startsWith(appOrigin)) {
        documentCsp = res.headers()['content-security-policy'] ?? null;
      }
    });
    await page.addInitScript(() => {
      const w = window as unknown as { __qaCsp: string[] };
      w.__qaCsp = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        w.__qaCsp.push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });

    await page.route('**/*', async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === appOrigin) return route.continue();
      if (url.hostname === ISS_HOST) {
        iss.requests.push(request);
        const reply = internal._next();
        if ('abort' in reply) return route.abort(reply.abort);
        return route.fulfill({
          status: reply.status ?? 200,
          headers: { 'Access-Control-Allow-Origin': '*', ...(reply.headers ?? {}) },
          body: reply.body,
        });
      }
      if (url.hostname === TILE_HOST) {
        if (tiles.fail) return route.fulfill({ status: 500, body: 'tile error' });
        return route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' },
          body: tileBody() as never,
        });
      }
      unexpectedRequests.push(request.url());
      return route.abort('blockedbyclient');
    });

    await page.clock.install({ time: T0_MS - 1_000 });
    await page.clock.pauseAt(T0_MS);

    const tracker: Tracker = {
      tiles,
      open: async () => {
        await page.goto('/');
        // The app starts its scheduler with setTimeout(0) (Strict Mode safe). With the clock
        // paused, advance a little so the first request is deterministic before any assertion.
        await tracker.advance(100, 50);
      },
      advance: async (ms, stepMs = 500) => {
        let left = ms;
        while (left > 0) {
          const step = Math.min(stepMs, left);
          simNow += step;
          internal._setNow(simNow);
          await page.clock.runFor(step);
          left -= step;
        }
      },
      now: () => simNow,
      marker: () => page.locator('[data-testid="iss-marker"], .leaflet-marker-pane > *').first(),
      map: () => page.locator('.leaflet-container').first(),
    };

    await provide(tracker);

    expect(unexpectedRequests, 'unexpected external requests').toEqual([]);
    expect(dialogs, 'a dialog opened: injected script executed').toEqual([]);
    // A16: the production document must carry a CSP (D11), so a missing header fails here
    // instead of silently skipping the violation checks below.
    expect(documentCsp, 'document response had no Content-Security-Policy header').not.toBeNull();
    const fromPage = await page
      .evaluate(() => (window as unknown as { __qaCsp?: string[] }).__qaCsp ?? [])
      .catch(() => [] as string[]);
    expect(cspConsole, 'CSP console violations').toEqual([]);
    expect(fromPage, 'CSP securitypolicyviolation events').toEqual([]);
  },
});

export { expect };

export const fmt = {
  /** Matches e.g. "45.01° N", "45.01 °N", "45.01°N". */
  lat: (abs: string, hemi: 'N' | 'S') =>
    new RegExp(`${abs.replace('.', '\\.')}\\s*°?\\s*${hemi}\\b`),
  lon: (abs: string, hemi: 'E' | 'W') =>
    new RegExp(`${abs.replace('.', '\\.')}\\s*°?\\s*${hemi}\\b`),
};

/** Copy matched by meaning where contracts §7 does not freeze exact text. */
export const copy = {
  empty: /waiting|loading|getting|no position/i,
  stale: /stale|out of date|\bold\b/i,
  retrying: /retrying|trying again/i,
  mapUnavailable:
    /map (is )?(unavailable|not available|could not|couldn.t|failed)|map tiles? (failed|unavailable|could not|couldn.t)|map (images|tiles) (are )?not loading/i,
  deviceClock: /device.{0,2}s? clock/i,
  trailNote: 'Observed during this session.',
  provider: /Where the ISS at/,
  osm: /OpenStreetMap contributors/,
};

export async function centerOf(
  locator: ReturnType<Page['locator']>,
): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
