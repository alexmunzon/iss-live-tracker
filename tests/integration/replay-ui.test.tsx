// Integration: Mission Replay UI inside the real <App/> (useTracker + scheduler + client +
// IssMap + panels) with fake time and a fake fetch. Same harness pattern as app.test.tsx.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';
import { T0_MS } from '../fixtures/canonical/index';
import { payloadAt } from '../fixtures/adversarial/payloads';
import { createFakeFetch, FAKED, json, macrotask, type FakeFetch, type Reply } from './harness';

let fake: FakeFetch;

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

const liveText = () =>
  Array.from(document.querySelectorAll('[aria-live="polite"], [role="status"]'))
    .map((n) => n.textContent ?? '')
    .join('|');

const replayButton = () => screen.getByRole('button', { name: 'Replay' });
const backToLive = () => screen.getByRole('button', { name: 'Back to live' });
const slider = () => screen.getByRole('slider', { name: /recorded moment/i });
const replayHeading = () => screen.getByRole('heading', { name: /replay — not live/i });
const eventList = () => screen.getByRole('list', { name: /recorded events/i });
const text = (testId: string) => screen.getByTestId(testId).textContent ?? '';

beforeEach(() => {
  vi.useFakeTimers({ now: T0_MS, toFake: [...FAKED, 'performance'] });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  fake = createFakeFetch({ t }, () => fresh(30, 40));
  vi.stubGlobal('fetch', fake.fetch);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Three samples: 10 N 20 E at 0 s, 11 N 21 E at 5 s, then 30 N 40 E at 10 s (newest). */
async function recordSession(): Promise<void> {
  // Built at request time, so each reply carries the current timestamp.
  const coords: [number, number][] = [
    [10, 20],
    [11, 21],
  ];
  fake.setFallback(() => {
    const [lat, lon] = coords.shift() ?? [30, 40];
    return fresh(lat, lon);
  });
  render(<App />);
  await advance(100);
  await advance(5_000);
  await advance(5_000);
  expect(text('coordinates')).toBe('30.00° N, 40.00° E');
}

describe('Mission Replay UI (integration)', () => {
  it('the Replay control appears in the tracker controls once events exist', async () => {
    await recordSession();
    const controls = screen.getByRole('group', { name: 'Tracker controls' });
    expect(within(controls).getByRole('button', { name: 'Replay' })).toBeEnabled();
  });

  it('entering Replay pauses polling, swaps the panel and focuses the Replay heading', async () => {
    await recordSession();
    const before = fake.calls.length;
    fireEvent.click(replayButton());

    expect(replayHeading()).toHaveFocus();
    expect(screen.getByTestId('replay-not-live')).toHaveTextContent(/not live/i);
    expect(screen.queryByRole('heading', { name: 'Current position' })).toBeNull();
    expect(screen.queryByTestId('coordinates')).toBeNull();
    // Defaults to the newest event.
    expect(slider()).toHaveValue(slider().getAttribute('max'));
    expect(text('replay-coordinates')).toBe('30.00° N, 40.00° E');
    expect(liveText()).toMatch(
      /Replay opened\. Showing recorded data from this session, not live\./,
    );

    // Paused: a whole minute brings no request at all.
    await advance(60_000);
    expect(fake.calls).toHaveLength(before);
  });

  it('scrubbing changes the shown instant and makes zero fetches', async () => {
    await recordSession();
    fireEvent.click(replayButton());
    const before = fake.calls.length;

    // Event list is newest first; the last "New position received" is the oldest sample.
    const samples = within(eventList()).getAllByRole('button', { name: /New position received/ });
    expect(samples).toHaveLength(3);
    const oldest = samples[samples.length - 1];
    if (oldest === undefined) throw new Error('no oldest sample');
    fireEvent.click(oldest);
    expect(oldest).toHaveAttribute('aria-current', 'true');
    expect(text('replay-coordinates')).toBe('10.00° N, 20.00° E');
    expect(text('replay-data-state')).toBe('Fresh');
    expect(text('replay-calculated')).toMatch(/14:01:23 UTC/);
    expect(text('replay-received')).toMatch(/14:01:23 UTC/);
    expect(text('replay-event')).toBe('New position received');
    expect(slider().getAttribute('aria-valuetext')).toMatch(
      /^14:01:23 UTC, Fresh, position received just now$/,
    );

    // The slider and the list agree.
    const middleIndex = Number(slider().getAttribute('value'));
    fireEvent.change(slider(), { target: { value: String(Number(slider().getAttribute('max'))) } });
    expect(text('replay-coordinates')).toBe('30.00° N, 40.00° E');
    expect(oldest).not.toHaveAttribute('aria-current');
    fireEvent.change(slider(), { target: { value: String(middleIndex) } });
    expect(text('replay-coordinates')).toBe('10.00° N, 20.00° E');
    fireEvent.change(slider(), { target: { value: '0' } });
    expect(text('replay-coordinates')).toBe('Not available yet');

    await advance(30_000);
    expect(fake.calls).toHaveLength(before);
  });

  it('a recorded outage replays as Delayed then Stale with the failure labelled', async () => {
    fake.queue(fresh(10, 20));
    fake.setFallback(() => status(503));
    render(<App />);
    await advance(100);
    // Failures at ~5 s, then after jittered backoffs of 10-12 s, 20-24 s and 40-48 s, so the
    // fourth lands between ~75 s and ~89 s.
    await advance(100_000);
    fireEvent.click(replayButton());
    const failures = within(eventList()).getAllByRole('button', {
      name: /Request failed \(HTTP 503\)/,
    });
    expect(failures.length).toBeGreaterThanOrEqual(2);
    // Newest first: the first is the latest failure (> 60 s after the sample).
    const latest = failures[0];
    const earliest = failures[failures.length - 1];
    if (latest === undefined || earliest === undefined) throw new Error('no failures');
    fireEvent.click(earliest);
    expect(text('replay-coordinates')).toBe('10.00° N, 20.00° E');
    expect(text('replay-data-state')).toBe('Fresh');
    expect(text('replay-event')).toBe('Request failed (HTTP 503)');
    fireEvent.click(latest);
    expect(text('replay-data-state')).toBe('Stale');
    expect(text('replay-age')).toMatch(/1 minute ago/);
  });

  it('Back to live when updates were running: resumes, newest live position, real freshness', async () => {
    await recordSession();
    fireEvent.click(replayButton());
    const before = fake.calls.length;
    // Scrub to the oldest sample, then wait so the real data ages.
    const samples = within(eventList()).getAllByRole('button', { name: /New position received/ });
    fireEvent.click(samples[samples.length - 1] as HTMLElement);
    await advance(60_000);
    expect(fake.calls).toHaveLength(before);

    fireEvent.click(backToLive());
    expect(screen.queryByRole('heading', { name: /replay/i })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Current position' })).toBeInTheDocument();
    // The newest REAL position, never the last scrubbed one, with its real age.
    expect(text('coordinates')).toBe('30.00° N, 40.00° E');
    expect(text('calculated')).toMatch(/14:01:33 UTC/);
    expect(text('data-state')).toBe('Stale');
    expect(text('age')).toMatch(/1 minute ago/);
    expect(replayButton()).toHaveFocus();
    expect(liveText()).toMatch(/Back to live\. Live updates resumed\./);
    expect(screen.getByRole('button', { name: /pause updates/i })).toBeInTheDocument();

    // Normal cadence again: a new request and a fresh position.
    await advance(100);
    expect(fake.calls.length).toBeGreaterThan(before);
    expect(text('data-state')).toBe('Fresh');
  });

  it('Back to live when the user had paused first: stays paused, no request', async () => {
    await recordSession();
    fireEvent.click(screen.getByRole('button', { name: /pause updates/i }));
    const before = fake.calls.length;
    fireEvent.click(replayButton());
    await advance(10_000);
    fireEvent.click(backToLive());

    expect(screen.getByRole('button', { name: /resume updates/i })).toBeInTheDocument();
    expect(text('connection')).toMatch(/^Paused/);
    expect(replayButton()).toHaveFocus();
    expect(liveText()).toMatch(/Back to live\. Updates are still paused\./);
    await advance(30_000);
    expect(fake.calls).toHaveLength(before);
  });

  it('Back to live while offline: announces the real state, never "resumed"', async () => {
    await recordSession();
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    const before = fake.calls.length;
    fireEvent.click(replayButton());
    await advance(10_000);
    fireEvent.click(backToLive());

    expect(text('connection')).toMatch(/^Offline/);
    expect(liveText()).toMatch(
      /Back to live\. Offline: updates resume when the connection returns\./,
    );
    expect(liveText()).not.toMatch(/Live updates resumed/);
    await advance(30_000);
    expect(fake.calls).toHaveLength(before);
  });
});
