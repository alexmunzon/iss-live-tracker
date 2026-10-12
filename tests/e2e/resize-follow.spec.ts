// R1: a viewport resize must keep a followed ISS marker inside the visible map, even when no
// new position arrives (paused, duplicate sample). With follow off, the user's view is kept.
import type { Page } from '@playwright/test';
import { centerOf, expect, json, position, test, type Tracker } from './fixtures';

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const LANDSCAPE = { width: 844, height: 390 };

const FOLLOWING = 'Following ISS';
const NOT_FOLLOWING = 'Exploring map';

/**
 * Real viewport geometry, not a marker count. 'contained': the whole 30 px marker box lies inside
 * the map canvas (required wherever the map can centre on it). 'centre': the coordinate itself
 * (the marker centre) lies inside the canvas. Used only at lon ±179.5, where whole-box
 * containment is impossible by geometry: the world edge is 1–2 px from the marker centre and
 * maxBounds stops the map there, so half the marker must hang over the map edge.
 */
type Fit = 'contained' | 'centre';

async function markerOnMap(page: Page, tracker: Tracker, fit: Fit): Promise<boolean> {
  const marker = await tracker.marker().boundingBox();
  const canvas = await page.locator('.iss-map__canvas').boundingBox();
  if (!marker || !canvas) return false;
  const left = canvas.x - 1;
  const top = canvas.y - 1;
  const right = canvas.x + canvas.width + 1;
  const bottom = canvas.y + canvas.height + 1;
  if (fit === 'contained') {
    return (
      marker.x >= left &&
      marker.y >= top &&
      marker.x + marker.width <= right &&
      marker.y + marker.height <= bottom
    );
  }
  const cx = marker.x + marker.width / 2;
  const cy = marker.y + marker.height / 2;
  return cx >= left && cx <= right && cy >= top && cy <= bottom;
}

/** Marker centre relative to the map canvas centre, in px. */
async function markerOffset(page: Page, tracker: Tracker): Promise<{ dx: number; dy: number }> {
  const m = await centerOf(tracker.marker());
  const c = await centerOf(page.locator('.iss-map__canvas'));
  return { dx: m.x - c.x, dy: m.y - c.y };
}

/**
 * Let a resize settle. ResizeObserver fires after layout (real time), and Leaflet's own
 * maxBounds correction may animate on requestAnimationFrame, which the paused fake clock
 * owns. So step the page clock until the marker and the canvas stop moving.
 */
async function settle(page: Page, tracker: Tracker) {
  let last = '';
  let stableReads = 0;
  await expect
    .poll(
      async () => {
        await tracker.advance(100, 50);
        const now = JSON.stringify([
          await tracker.marker().boundingBox(),
          await page.locator('.iss-map__canvas').boundingBox(),
        ]);
        stableReads = now === last ? stableReads + 1 : 0;
        last = now;
        return stableReads;
      },
      { message: 'map settles after the resize', intervals: [100] },
    )
    .toBeGreaterThanOrEqual(3);
}

/** One map, one marker, still inside the map, follow still on. */
async function expectFollowedAndVisible(
  page: Page,
  tracker: Tracker,
  label: string,
  fit: Fit = 'contained',
) {
  await settle(page, tracker);
  expect(await markerOnMap(page, tracker, fit), `marker ${fit} in map (${label})`).toBe(true);
  await expect(page.getByTestId('follow-state')).toHaveText(FOLLOWING);
  await expect(page.locator('.leaflet-marker-pane > *')).toHaveCount(1);
  await expect(page.locator('.leaflet-container')).toHaveCount(1);
}

async function openAt(page: Page, tracker: Tracker, fit: Fit = 'contained') {
  await page.setViewportSize(MOBILE);
  await tracker.open();
  await expect(tracker.marker()).toBeVisible();
  await expect(page.getByTestId('follow-state')).toHaveText(FOLLOWING);
  await tracker.advance(1_000); // let the first follow pan finish
  await expect.poll(() => markerOnMap(page, tracker, fit)).toBe(true);
}

test.describe('R1 resize keeps the followed ISS on the map', () => {
  for (const longitude of [-117.9, 179.5, -179.5]) {
    test(`paused at lon ${longitude}: mobile ↔ desktop ↔ landscape`, async ({
      page,
      tracker,
      iss,
    }) => {
      iss.setFallback((now) =>
        json(position({ timestamp: Math.floor(now / 1000), longitude, latitude: 33.5 })),
      );
      const fit: Fit = Math.abs(longitude) > 179 ? 'centre' : 'contained';
      await openAt(page, tracker, fit);

      const pause = page.getByRole('button', { name: /^pause/i }).first();
      await pause.scrollIntoViewIfNeeded();
      await pause.click();
      await expect(page.getByRole('button', { name: /^resume/i }).first()).toBeVisible();
      const requestsBefore = iss.requests.length;

      for (const [label, size] of [
        ['desktop', DESKTOP],
        ['mobile', MOBILE],
        ['desktop again', DESKTOP],
        ['landscape', LANDSCAPE],
        ['portrait', MOBILE],
      ] as const) {
        await page.setViewportSize(size);
        await expectFollowedAndVisible(page, tracker, label, fit);
      }
      expect(iss.requests.length, 'resizes must not fetch').toBe(requestsBefore);
    });
  }

  test('duplicate sample while polling: marker stays on the map after resizes', async ({
    page,
    tracker,
    iss,
  }) => {
    // Every reply repeats the same sample (same timestamp), so no new position is applied.
    const sample = json(position({ timestamp: 1791727283, longitude: -117.9, latitude: 33.5 }));
    iss.setFallback(() => sample);
    await openAt(page, tracker);
    await tracker.advance(6_000); // at least one duplicate poll arrives
    await expect.poll(() => iss.requests.length).toBeGreaterThan(1);

    // Polling keeps running here (settling steps the clock), so request counts are covered
    // by the paused tests above; this one proves the duplicate path keeps the marker visible.
    for (const [label, size] of [
      ['desktop', DESKTOP],
      ['mobile', MOBILE],
      ['landscape', LANDSCAPE],
      ['portrait', MOBILE],
    ] as const) {
      await page.setViewportSize(size);
      await expectFollowedAndVisible(page, tracker, label);
    }
  });

  test('follow off: resize keeps the user view and zoom', async ({ page, tracker, iss }) => {
    iss.setFallback((now) =>
      json(position({ timestamp: Math.floor(now / 1000), longitude: 0, latitude: 0 })),
    );
    await openAt(page, tracker);
    await page
      .getByRole('button', { name: /^pause/i })
      .first()
      .click();
    const requestsBefore = iss.requests.length;

    // Zoom in, then pan: both are user moves that end follow. At this zoom the user's view
    // fits inside the world at every size below, so Leaflet's maxBounds never has to clamp it.
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await tracker.advance(1_000); // let the zoom animation finish
    await page.getByRole('button', { name: 'Map controls' }).click();
    await page.getByRole('button', { name: 'Pan east' }).click();
    await tracker.advance(1_000); // let the pan animation finish
    await expect(page.getByTestId('follow-state')).toHaveText(NOT_FOLLOWING);
    const panned = await markerOffset(page, tracker);
    expect(Math.abs(panned.dx), 'the user pan moved the marker off-centre').toBeGreaterThan(100);

    for (const [label, size] of [
      ['wider phone', { width: 430, height: 844 }],
      ['mobile', MOBILE],
      ['desktop', DESKTOP],
      ['mobile again', MOBILE],
      ['landscape', LANDSCAPE],
      ['portrait', MOBILE],
    ] as const) {
      await page.setViewportSize(size);
      await settle(page, tracker);
      await expect(page.getByTestId('follow-state')).toHaveText(NOT_FOLLOWING);
      // Same marker offset from the map centre = same centre and same zoom: not re-panned.
      const kept = await markerOffset(page, tracker);
      expect(
        Math.hypot(kept.dx - panned.dx, kept.dy - panned.dy),
        `user view kept (${label})`,
      ).toBeLessThan(3);
    }
    await expect(page.locator('.leaflet-marker-pane > *')).toHaveCount(1);
    await expect(page.locator('.leaflet-container')).toHaveCount(1);
    expect(iss.requests.length, 'resizes must not fetch').toBe(requestsBefore);
  });
});
