// Integration: <App/> end to end inside jsdom (useTracker + scheduler + client +
// IssMap + StatusPanel). Contract G1-v2.
//
// ASSUMPTIONS the coordinator must freeze or align (the App injection seam is not frozen):
//  S1. App takes no props and builds its scheduler from browser globals:
//      globalThis.fetch, Date.now (wall), performance.now (monotonic), setTimeout/clearTimeout,
//      Math.random, document.visibilityState + 'visibilitychange', navigator.onLine +
//      window 'online'/'offline'. We stub fetch with vi.stubGlobal and fake Date,
//      performance and timers with vi.useFakeTimers; setImmediate/MessageChannel stay real
//      so React can flush.
//  S2. The display tick (ageDisplayTickMs) uses setTimeout/setInterval, so it is faked too.
//  S3. Leaflet runs in jsdom (zero-size container). If map init fails, the text panel must
//      still be complete (mapStatus 'init-failed'); these tests only rely on the text panel.
//  S4. UI copy (only partly frozen in contracts §7) is matched by meaning:
//      latitude /45\.01\s*°?\s*N/, longitude /18\.40\s*°?\s*W/, UTC time /14:01:23/ + /UTC/,
//      provider /Where the ISS at/, empty /waiting|loading|getting|no position/i,
//      stale /stale|out of date|old/i, retrying /retrying|trying again/i,
//      clock mismatch with a sample /time could not be verified/i (§4); G1-v2 /device clock/i
//      is only for clockSuspect without an anchor or a future-sample streak; trail note "Observed during this session".
//  S5. Buttons are <button> with accessible names /pause/i, /resume/i, /retry/i,
//      /recenter/i. Retry while not eligible is `disabled` or aria-disabled="true".
//  S6. The live region is the element(s) with aria-live="polite" (or role="status").

import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { observedCurl, rawPosition, T0_MS } from '../fixtures/canonical/index';
import { payloadAt, XSS_IMG, XSS_SCRIPT } from '../fixtures/adversarial/payloads';
import { createFakeFetch, FAKED, json, macrotask, type FakeFetch, type Reply } from './harness';

let fake: FakeFetch;
let visibility: DocumentVisibilityState = 'visible';

const t = () => Date.now() - T0_MS;
const fresh = (lat?: number, lon?: number): Reply => json(payloadAt(T0_MS + t(), lat, lon));
const status = (code: number): Reply => ({ kind: 'respond', status: code, headers: {}, body: '' });

async function advance(ms: number): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await macrotask();
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 20; i += 1) await macrotask();
  });
}

function setVisibility(v: DocumentVisibilityState): void {
  visibility = v;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const liveText = () =>
  Array.from(document.querySelectorAll('[aria-live="polite"], [role="status"]'))
    .map((n) => n.textContent ?? '')
    .join('|');

const activeCalls = () => fake.calls.filter((c) => !c.aborted);

beforeEach(() => {
  vi.useFakeTimers({ now: T0_MS, toFake: [...FAKED, 'performance'] });
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => visibility === 'hidden',
  });
  fake = createFakeFetch({ t }, () => fresh());
  vi.stubGlobal('fetch', fake.fetch);
  delete (window as { __qaXss?: unknown }).__qaXss;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('App integration (jsdom)', () => {
  it('A13 empty state: no position, no marker before the first sample', async () => {
    fake.setFallback(() => ({ kind: 'hang' }));
    const { container } = render(<App />);
    await advance(100);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/45\.01/);
    expect(container.textContent).toMatch(/waiting|loading|getting|no position/i);
    expect(container.querySelector('.leaflet-marker-pane > *')).toBeNull();
  });

  it('A19 first sample: complete text alternative', async () => {
    fake.queue(json(JSON.stringify(observedCurl)));
    const { container } = render(<App />);
    await advance(100);
    const text = container.textContent ?? '';
    expect(text).toMatch(/45\.01\s*°?\s*N/);
    expect(text).toMatch(/18\.40\s*°?\s*W/);
    expect(text).toMatch(/14:01:23/);
    expect(text).toMatch(/UTC/);
    expect(screen.getAllByText(/Where the ISS at/).length).toBeGreaterThan(0);
    expect(fake.calls[0]?.url).toBe('https://api.wheretheiss.at/v1/satellites/25544');
    expect(fake.calls[0]?.init.referrerPolicy).toBe('no-referrer');
  });

  it('A06/A17 StrictMode: one scheduler, single flight, ~12 requests per minute', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await advance(60_000);
    // 0, 5, …, 60 s = 13 non-aborted starts; StrictMode may add one aborted start.
    expect(activeCalls().length).toBeGreaterThanOrEqual(12);
    expect(activeCalls().length).toBeLessThanOrEqual(14);
    expect(fake.calls.length).toBeLessThanOrEqual(15);
    expect(fake.maxConcurrentActive()).toBe(1);
  });

  it('A07/A05 outage: marker data kept, retrying, stale after 60 s', async () => {
    fake.queue(fresh());
    fake.setFallback(() => status(503));
    const { container } = render(<App />);
    await advance(100);
    await advance(61_000);
    const text = container.textContent ?? '';
    expect(text).toMatch(/45\.01\s*°?\s*N/);
    expect(text).toMatch(/stale|out of date|old/i);
    expect(text).toMatch(/retrying|trying again/i);
  });

  it('A15 live region does not tick with age or coordinate updates', async () => {
    render(<App />);
    await advance(1_000);
    const first = liveText();
    expect(
      document.querySelectorAll('[aria-live="polite"], [role="status"]').length,
    ).toBeGreaterThan(0);
    await advance(3_000); // age ticks and one more fresh sample with new time
    expect(liveText()).toBe(first);
    expect(document.querySelector('[aria-live="assertive"]')).toBeNull();
  });

  it('A09 Pause persists across visibility changes; Resume fetches once', async () => {
    render(<App />);
    await advance(100);
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    const count = fake.calls.length;
    setVisibility('hidden');
    setVisibility('visible');
    await advance(60_000);
    expect(fake.calls).toHaveLength(count);
    expect(screen.getByText(/paused/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    await advance(100);
    expect(fake.calls).toHaveLength(count + 1);
  });

  it('A09 hidden tab stops polling; visible again makes exactly one request', async () => {
    render(<App />);
    await advance(6_000);
    setVisibility('hidden');
    const count = fake.calls.length;
    await advance(120_000);
    expect(fake.calls).toHaveLength(count);
    setVisibility('visible');
    await advance(100);
    expect(fake.calls).toHaveLength(count + 1);
  });

  it('A09 Retry is disabled with a visible reason and countdown during backoff', async () => {
    fake.setFallback(() => ({ kind: 'network' }));
    const { container } = render(<App />);
    await advance(1_000);
    const retry = screen.getByRole('button', { name: /retry/i });
    const disabled =
      retry.hasAttribute('disabled') || retry.getAttribute('aria-disabled') === 'true';
    expect(disabled).toBe(true);
    expect(container.textContent).toMatch(/\d+\s*(s\b|sec|second)/i);
    const count = fake.calls.length;
    for (let i = 0; i < 10; i += 1) fireEvent.click(retry);
    await advance(10);
    expect(fake.calls).toHaveLength(count);
  });

  it('A16 remote strings are never rendered as HTML', async () => {
    fake.queue(
      json(JSON.stringify({ ...observedCurl, visibility: XSS_IMG, note: XSS_SCRIPT })),
      json(JSON.stringify(rawPosition({ name: XSS_IMG, timestamp: observedCurl.timestamp + 5 }))),
    );
    const { container } = render(<App />);
    await advance(6_000);
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelectorAll('script')).toHaveLength(0);
    expect((window as { __qaXss?: unknown }).__qaXss).toBeUndefined();
    expect(container.textContent).not.toMatch(/onerror|<img|<script/);
  });

  it('A05 wall-clock jump after a sample: time unverified, never fresh (contracts §4)', async () => {
    const { container } = render(<App />);
    await advance(1_000);
    vi.setSystemTime(Date.now() - 3_600_000); // wall jumps back 1 h; performance.now does not
    await advance(5_000);
    // §4: wall/monotonic mismatch → 'unverified'; UI shows provider time + "Time could not be verified".
    expect(container.textContent).toMatch(/time could not be verified/i);
    expect(container.textContent).toMatch(/14:01:2\d/);
    expect(container.textContent).not.toMatch(/Data:\s*Fresh/i);
  });

  it('A17 unmount stops everything: no timers, no further requests', async () => {
    const { unmount } = render(<App />);
    await advance(12_000);
    unmount();
    const count = fake.calls.length;
    await advance(0);
    expect(vi.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(fake.calls).toHaveLength(count);
  });
});
