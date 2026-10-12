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
    // The map centre is re-read on every call: clicking Recenter (below the map) can scroll
    // the page, which moves the whole map on screen without moving the marker within it.
    const near = async (tolerance: number) => {
      const m = await centerOf(tracker.marker());
      const c = await centerOf(map);
      return Math.hypot(m.x - c.x, m.y - c.y) <= tolerance;
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

  test('Map controls disclosure: four 44px pan buttons, pan ends follow, Escape closes and refocuses', async ({
    page,
    tracker,
  }) => {
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    const toggle = page.getByRole('button', { name: 'Map controls' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    for (const dir of ['north', 'south', 'west', 'east']) {
      await expect(page.getByRole('button', { name: `Pan ${dir}` })).toHaveCount(0);
    }
    // Zoom stays visible without opening the disclosure.
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom out' })).toBeVisible();
    await expect(page.getByTestId('follow-state')).toHaveText('Following ISS');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (const dir of ['north', 'south', 'west', 'east']) {
      const button = page.getByRole('button', { name: `Pan ${dir}` });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box, `Pan ${dir} has a box`).not.toBeNull();
      expect(box?.width, `Pan ${dir} width`).toBeGreaterThanOrEqual(44);
      expect(box?.height, `Pan ${dir} height`).toBeGreaterThanOrEqual(44);
    }

    // A pan click is a user move: follow ends.
    await page.getByRole('button', { name: 'Pan north' }).click();
    await expect(page.getByTestId('follow-state')).toHaveText('Exploring map');

    // Escape from inside the pad closes it and returns focus to the toggle.
    await page.getByRole('button', { name: 'Pan west' }).focus();
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
    await expect(page.getByRole('button', { name: 'Pan north' })).toHaveCount(0);
  });

  test('keyboard: Map controls toggle opens with Enter and Escape closes it', async ({
    page,
    tracker,
  }) => {
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    const toggle = page.getByRole('button', { name: 'Map controls' });
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: 'Pan east' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();
  });

  test('Recenter on ISS restores Following ISS without changing the zoom level', async ({
    page,
    tracker,
  }) => {
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    const tileLevels = async () => {
      const levels = await page
        .locator('.leaflet-tile')
        .evaluateAll((els) =>
          els.map(
            (e) =>
              e.getAttribute('src')?.match(/^https:\/\/tile\.openstreetmap\.org\/(\d+)\//)?.[1] ??
              'none',
          ),
        );
      return [...new Set(levels)].sort();
    };
    const settledLevels = async () => {
      await tracker.advance(250);
      return tileLevels();
    };
    let initial: string[] = [];
    await expect
      .poll(async () => (initial = await settledLevels()).length, { timeout: 10_000 })
      .toBe(1);
    const zoomed = String(Number(initial[0]) + 1);

    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(settledLevels, { timeout: 10_000 }).toEqual([zoomed]);
    await expect(page.getByTestId('follow-state')).toHaveText('Exploring map');

    await page.getByRole('button', { name: 'Recenter on ISS' }).click();
    await expect(page.getByTestId('follow-state')).toHaveText('Following ISS');
    await tracker.advance(1_000);
    await expect.poll(settledLevels, { timeout: 10_000 }).toEqual([zoomed]);
    await expect(page.getByTestId('follow-state')).toHaveText('Following ISS');
  });

  test('A12 zoom by the user is kept when following', async ({ page, tracker, iss }) => {
    // Every sample moves the ISS 1° north, so the 10 s window below really applies new data.
    let served = 0;
    iss.setFallback((now) => {
      const lat = 10 + served;
      served += 1;
      return json(position({ timestamp: Math.floor(now / 1000), latitude: lat, longitude: 10 }));
    });
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();

    // Zoom level of every tile in the DOM, read from the tile URL (/{z}/{x}/{y}.png).
    // Leaflet keeps the previous level's tiles until the new ones have loaded AND its
    // fake-clock-driven fade/prune has run, so a single tile read straight after a zoom can
    // show the old level. Settle by advancing the page clock until every tile shares one level.
    const tileLevels = async () => {
      const levels = await page
        .locator('.leaflet-tile')
        .evaluateAll((els) =>
          els.map(
            (e) =>
              e.getAttribute('src')?.match(/^https:\/\/tile\.openstreetmap\.org\/(\d+)\//)?.[1] ??
              'none',
          ),
        );
      return [...new Set(levels)].sort();
    };
    const settledLevels = async () => {
      await tracker.advance(250);
      return tileLevels();
    };
    let initial: string[] = [];
    await expect
      .poll(async () => (initial = await settledLevels()).length, { timeout: 10_000 })
      .toBe(1);
    expect(initial[0]).toMatch(/^\d+$/);
    const zoomed = String(Number(initial[0]) + 1);

    await page.getByRole('button', { name: /zoom in/i }).click();
    // Zoom-in really happened: every tile moves to exactly one level deeper.
    await expect.poll(settledLevels, { timeout: 10_000 }).toEqual([zoomed]);

    // 10 s of data updates must not change the user's zoom, not even transiently.
    const servedBefore = served;
    for (let i = 0; i < 20; i += 1) {
      await tracker.advance(500);
      expect(await tileLevels(), `tile levels ${(i + 1) * 500} ms into the data window`).toEqual([
        zoomed,
      ]);
    }
    expect(served - servedBefore, 'new samples during the 10 s window').toBeGreaterThanOrEqual(1);
    await expect(page.getByText(fmt.lat(`${10 + served - 1}.00`, 'N')).first()).toBeVisible();
    // And it is still that level once everything has settled.
    await expect.poll(settledLevels, { timeout: 10_000 }).toEqual([zoomed]);
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

  test('A11 westward antimeridian crossing: one marker, no world copies', async ({
    page,
    tracker,
    iss,
  }) => {
    iss.queue(
      json(position({ timestamp: 1791727283, latitude: -20, longitude: -179.5 })),
      json(position({ timestamp: 1791727288, latitude: -20.1, longitude: 179.5 })),
    );
    const markers = page.locator(
      '[data-testid="iss-marker"], .leaflet-marker-pane > .leaflet-marker-icon',
    );
    await tracker.open();
    await expect(page.getByText(fmt.lon('179.50', 'W')).first()).toBeVisible();
    await expect(markers).toHaveCount(1);
    await tracker.advance(5_000);
    await expect(page.getByText(fmt.lon('179.50', 'E')).first()).toBeVisible();
    await expect(page.getByText(fmt.lon('179.50', 'W'))).toHaveCount(0);
    await expect(markers).toHaveCount(1);
  });
});
