// A12 follow/recenter and A13 tile failure (contract G1-v2).
import { centerOf, copy, expect, fmt, json, position, test } from './fixtures';

test.describe('map', () => {
  test('A13 tile failure shows a map-unavailable notice; text still works', async ({
    page,
    tracker,
  }) => {
    tracker.tiles.fail = true;
    await tracker.open();
    await tracker.advance(1_000);
    await expect(page.getByText(copy.mapUnavailable).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(fmt.lat('45.01', 'N')).first()).toBeVisible();
    await expect(page.getByText(fmt.lon('18.40', 'W')).first()).toBeVisible();
  });

  test('A12 drag disables follow; Recenter restores it', async ({ page, tracker, iss }) => {
    // Every request returns the *current* position at the current time, so a later request
    // can never supersede the position under test with a different one.
    let current = { latitude: 10, longitude: 10 };
    iss.setFallback((now) => json(position({ timestamp: Math.floor(now / 1000), ...current })));
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    await tracker.advance(1_000); // let any pan animation finish
    const map = tracker.map();
    const mapCenter = await centerOf(map);
    const near = async (tolerance: number) => {
      const m = await centerOf(tracker.marker());
      return Math.hypot(m.x - mapCenter.x, m.y - mapCenter.y) <= tolerance;
    };
    await expect.poll(() => near(40)).toBe(true);

    // User drag (not programmatic) → follow off.
    await page.mouse.move(mapCenter.x, mapCenter.y);
    await page.mouse.down();
    await page.mouse.move(mapCenter.x - 80, mapCenter.y - 60, { steps: 8 });
    await page.mouse.move(mapCenter.x - 160, mapCenter.y - 120, { steps: 8 });
    await page.mouse.up();
    await tracker.advance(1_000);
    await expect.poll(() => near(40)).toBe(false);

    // A new sample must NOT pull the map back while follow is off.
    current = { latitude: 11, longitude: 11 };
    await tracker.advance(6_000);
    await expect(page.getByText(fmt.lat('11.00', 'N')).first()).toBeVisible();
    await tracker.advance(1_000);
    await expect.poll(() => near(40)).toBe(false);

    // Recenter re-enables follow and pans to the marker.
    await page.getByRole('button', { name: /recenter/i }).click();
    await tracker.advance(1_000);
    await expect.poll(() => near(40)).toBe(true);

    // Follow stays on after Recenter (its programmatic pan/zoom must not count as a user move):
    // two further samples both keep the marker centred.
    for (const lat of [13, 15]) {
      current = { latitude: lat, longitude: lat };
      await tracker.advance(6_000);
      await expect(page.getByText(fmt.lat(`${lat}.00`, 'N')).first()).toBeVisible();
      await tracker.advance(1_000);
      await expect.poll(() => near(40)).toBe(true);
    }
  });

  test('A12 zoom by the user is kept when following', async ({ page, tracker }) => {
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    const zoomIn = page.getByRole('button', { name: /zoom in/i });
    await zoomIn.click();
    await tracker.advance(1_000);
    const tileBefore = await page.locator('.leaflet-tile').first().getAttribute('src');
    await tracker.advance(10_000);
    const tileAfter = await page.locator('.leaflet-tile').first().getAttribute('src');
    const zoomOf = (src: string | null) => src?.match(/org\/(\d+)\//)?.[1];
    expect(zoomOf(tileAfter)).toBe(zoomOf(tileBefore));
  });

  test('antimeridian crossing: one marker, no world copies', async ({ page, tracker, iss }) => {
    iss.queue(
      json(position({ timestamp: 1791727283, latitude: 20, longitude: 179 })),
      json(position({ timestamp: 1791727288, latitude: 20.1, longitude: -179 })),
    );
    await tracker.open();
    await tracker.advance(5_000);
    await expect(page.getByText(fmt.lon('179.00', 'W')).first()).toBeVisible();
    await expect(
      page.locator('[data-testid="iss-marker"], .leaflet-marker-pane > .leaflet-marker-icon'),
    ).toHaveCount(1);
  });
});
