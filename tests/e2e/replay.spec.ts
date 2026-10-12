// Mission Replay (slice 2): Live/Replay control, scrubber and Back to live, against the
// production build with the stubbed ISS API and tiles (see fixtures.ts).
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, json, position, test, type IssStub, type Tracker } from './fixtures';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
type AxePage = ConstructorParameters<typeof AxeBuilder>[0]['page'];
const axe = (page: unknown) => new AxeBuilder({ page: page as AxePage });

/** A reply built at request time, so it carries the current simulated timestamp. */
const at = (lat: number, lon: number) => (nowMs: number) =>
  json(position({ timestamp: Math.floor(nowMs / 1000), latitude: lat, longitude: lon }));

/**
 * Samples 10 N 20 E (t≈0), 11 N 21 E (t≈5 s), 12 N 22 E (t≈10 s); then an outage (HTTP 503)
 * for 100 s with failures at ~15, 25-27, 45-51 and 85-99 s (jittered backoff); then recovery
 * with 50 N 60 E, the newest live position.
 */
async function recordSession(page: Page, tracker: Tracker, iss: IssStub): Promise<void> {
  const samples: [number, number][] = [
    [10, 20],
    [11, 21],
    [12, 22],
  ];
  iss.setFallback((now) => {
    const [lat, lon] = samples.shift() ?? [12, 22];
    return at(lat, lon)(now);
  });
  await tracker.open();
  await tracker.advance(5_000);
  await tracker.advance(5_000);
  await expect(page.getByTestId('coordinates')).toHaveText('12.00° N, 22.00° E');
  iss.setFallback(() => ({ status: 503, body: 'down' }));
  await tracker.advance(100_000);
  await expect(page.getByTestId('data-state')).toHaveText('Stale');
  iss.setFallback(at(50, 60));
  await tracker.advance(65_000);
  await expect(page.getByTestId('coordinates')).toHaveText('50.00° N, 60.00° E');
}

const replayButton = (page: Page) => page.getByRole('button', { name: 'Replay', exact: true });
const slider = (page: Page) => page.getByRole('slider', { name: /recorded moment/i });
const eventList = (page: Page) => page.getByRole('list', { name: /recorded events/i });

async function enterReplay(page: Page): Promise<void> {
  await replayButton(page).click();
  await expect(page.getByRole('heading', { name: 'Replay — not live' })).toBeFocused();
  await expect(page.getByTestId('replay-not-live')).toContainText(/not live/i);
  await expect(page.getByRole('heading', { name: 'Current position' })).toHaveCount(0);
}

test.describe('Mission Replay', () => {
  test('scrubbing makes no requests, shows recorded values and moves the marker', async ({
    page,
    tracker,
    iss,
  }) => {
    await recordSession(page, tracker, iss);
    await enterReplay(page);
    const requests = iss.requests.length;

    // Defaults to the newest event.
    await expect(page.getByTestId('replay-coordinates')).toHaveText('50.00° N, 60.00° E');
    const newestStyle = await tracker.marker().getAttribute('style');

    // Keyboard on the native slider.
    await slider(page).focus();
    await page.keyboard.press('Home');
    await expect(slider(page)).toHaveValue('0');
    await expect(page.getByTestId('replay-coordinates')).toHaveText('Not available yet');
    await expect(slider(page)).toHaveAttribute('aria-valuetext', /^\d\d:\d\d:\d\d UTC, /);
    await page.keyboard.press('End');
    await expect(page.getByTestId('replay-coordinates')).toHaveText('50.00° N, 60.00° E');
    const max = await slider(page).getAttribute('max');
    await page.keyboard.press('ArrowLeft');
    await expect(slider(page)).toHaveValue(String(Number(max) - 1));

    // Clicking list items (newest first).
    const sampleItems = eventList(page).getByRole('button', { name: /New position received/ });
    await sampleItems.last().click();
    await expect(sampleItems.last()).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('replay-coordinates')).toHaveText('10.00° N, 20.00° E');
    await expect(page.getByTestId('replay-data-state')).toHaveText('Fresh');
    await expect(page.getByTestId('replay-calculated')).toContainText('14:01:23 UTC');
    await expect(page.getByTestId('replay-received')).toContainText(/UTC/);
    await expect.poll(() => tracker.marker().getAttribute('style')).not.toBe(newestStyle);

    // The outage: a mid-outage failure was Delayed, the last one Stale; both at 12 N 22 E.
    const failures = eventList(page).getByRole('button', { name: /Request failed \(HTTP 503\)/ });
    await expect(failures).toHaveCount(4);
    await failures.nth(1).click();
    await expect(page.getByTestId('replay-coordinates')).toHaveText('12.00° N, 22.00° E');
    await expect(page.getByTestId('replay-data-state')).toHaveText('Delayed');
    await expect(page.getByTestId('replay-event')).toHaveText('Request failed (HTTP 503)');
    await failures.first().click();
    await expect(page.getByTestId('replay-data-state')).toHaveText('Stale');
    await expect(page.getByTestId('replay-age')).toHaveText(/1 minute ago/);
    await expect(page.getByTestId('replay-connection')).toContainText(/retrying/i);

    // Time passes while replaying: still nothing on the network.
    await tracker.advance(20_000);
    expect(iss.requests).toHaveLength(requests);
  });

  test('Back to live after running: resumes, newest live position, a new request follows', async ({
    page,
    tracker,
    iss,
  }) => {
    await recordSession(page, tracker, iss);
    await enterReplay(page);
    const requests = iss.requests.length;
    await eventList(page)
      .getByRole('button', { name: /New position received/ })
      .last()
      .click();
    await expect(page.getByTestId('replay-coordinates')).toHaveText('10.00° N, 20.00° E');
    await tracker.advance(20_000);
    expect(iss.requests).toHaveLength(requests);

    // Resuming sends a request at once. Make that one fail so the live panel's anchor (and so
    // its real age) cannot change under the assertions below, whatever the browser's timing.
    iss.setFallback(() => ({ status: 503, body: 'down' }));
    await page.getByRole('button', { name: 'Back to live' }).click();
    await expect(replayButton(page)).toBeFocused();
    await expect(page.getByRole('heading', { name: /Replay/ })).toHaveCount(0);
    // Newest real position, never the scrubbed one; its real age (24-50 s) reads Delayed.
    await expect(page.getByTestId('coordinates')).toHaveText('50.00° N, 60.00° E');
    await expect(page.getByTestId('data-state')).toHaveText('Delayed');
    await expect(page.getByRole('status').filter({ hasText: /Back to live/ })).toHaveText(
      'Back to live. Live updates resumed.',
    );
    await expect.poll(() => iss.requests.length).toBeGreaterThan(requests);

    // Live polling continues on its normal schedule (one ordinary backoff) and recovers.
    iss.setFallback(at(51, 61));
    await tracker.advance(15_000);
    await expect(page.getByTestId('coordinates')).toHaveText('51.00° N, 61.00° E');
    await expect(page.getByTestId('data-state')).toHaveText('Fresh');
  });

  test('Back to live after the user paused: stays paused, no request', async ({
    page,
    tracker,
    iss,
  }) => {
    await tracker.open();
    await tracker.advance(5_000);
    await page.getByRole('button', { name: 'Pause updates' }).click();
    await expect(page.getByTestId('connection')).toHaveText(/^Paused/);
    const requests = iss.requests.length;

    await enterReplay(page);
    await slider(page).focus();
    await page.keyboard.press('ArrowLeft');
    await page.getByRole('button', { name: 'Back to live' }).click();

    await expect(replayButton(page)).toBeFocused();
    await expect(page.getByRole('button', { name: 'Resume updates' })).toBeVisible();
    await expect(page.getByTestId('connection')).toHaveText(/^Paused/);
    await expect(page.getByRole('status').filter({ hasText: /Back to live/ })).toHaveText(
      'Back to live. Updates are still paused.',
    );
    await tracker.advance(30_000);
    expect(iss.requests).toHaveLength(requests);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`axe: no WCAG 2.2 AA violations in the Replay view (${scheme})`, async ({
      page,
      tracker,
      iss,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await recordSession(page, tracker, iss);
      await enterReplay(page);
      await eventList(page)
        .getByRole('button', { name: /Request failed/ })
        .first()
        .click();
      await expect(page.getByTestId('replay-data-state')).toHaveText('Stale');
      // axe-core schedules work with setTimeout; the paused fake clock would stall it.
      // Polling is paused in Replay, so letting time run adds no ISS requests.
      const requests = iss.requests.length;
      await page.clock.resume();
      const result = await axe(page).withTags(WCAG_TAGS).analyze();
      expect(iss.requests).toHaveLength(requests);
      expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }

  for (const width of [320, 390] as const) {
    test(`${width}px: Replay view has no horizontal overflow`, async ({ page, tracker }) => {
      await page.setViewportSize({ width, height: 700 });
      await tracker.open();
      await tracker.advance(5_000);
      await enterReplay(page);
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(overflow.scroll, 'horizontal page scroll').toBeLessThanOrEqual(overflow.client);
      const back = page.getByRole('button', { name: 'Back to live' });
      await back.scrollIntoViewIfNeeded();
      const box = await back.boundingBox();
      expect(box).not.toBeNull();
      if (box) expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(await page.evaluate(() => window.scrollX)).toBe(0);
    });
  }
});
