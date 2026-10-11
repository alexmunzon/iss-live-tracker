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
    iss.queue(json(position({ timestamp: 1791727283, latitude: 10, longitude: 10 })));
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
    iss.queue(json(position({ timestamp: 1791727290, latitude: 11, longitude: 11 })));
    await tracker.advance(6_000);
    await expect(page.getByText(fmt.lat('11.00', 'N')).first()).toBeVisible();
    await expect.poll(() => near(40)).toBe(false);

    // Recenter re-enables follow and pans to the marker.
    await page.getByRole('button', { name: /recenter/i }).click();
    await tracker.advance(1_000);
    await expect.poll(() => near(40)).toBe(true);

    // And follow stays on for the next sample.
    iss.queue(json(position({ timestamp: 1791727296, latitude: 13, longitude: 13 })));
    await tracker.advance(6_000);
    await expect(page.getByText(fmt.lat('13.00', 'N')).first()).toBeVisible();
    await tracker.advance(1_000);
    await expect.poll(() => near(40)).toBe(true);
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
