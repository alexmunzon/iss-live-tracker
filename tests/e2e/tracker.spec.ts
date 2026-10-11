// A19 / A05 / A07 / A13 user-visible tracking flows (contract G1-v2).
import { copy, expect, fmt, json, position, test } from './fixtures';

test.describe('tracking flows', () => {
  test('A19 first sample shows a marker and matching text', async ({ page, tracker, iss }) => {
    await tracker.open();
    await expect(page.getByText(fmt.lat('45.01', 'N')).first()).toBeVisible();
    await expect(page.getByText(fmt.lon('18.40', 'W')).first()).toBeVisible();
    await expect(page.getByText(/14:01:23/).first()).toBeVisible();
    await expect(page.getByText(/UTC/).first()).toBeVisible();
    await expect(page.getByText(copy.provider).first()).toBeVisible();
    await expect(tracker.marker()).toBeVisible();
    expect(iss.requests).toHaveLength(1);
  });

  test('second sample moves the marker and updates the text', async ({ page, tracker, iss }) => {
    iss.queue(json(position({ timestamp: 1791727283 })));
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    const before = await tracker.marker().getAttribute('style');
    iss.queue(json(position({ timestamp: 1791727288, latitude: 46.25, longitude: -16.5 })));
    await tracker.advance(5_000);
    await expect(page.getByText(fmt.lat('46.25', 'N')).first()).toBeVisible();
    await expect(page.getByText(fmt.lon('16.50', 'W')).first()).toBeVisible();
    await expect.poll(() => tracker.marker().getAttribute('style')).not.toBe(before);
    expect(iss.requests).toHaveLength(2);
    await expect(
      page.locator('[data-testid="iss-marker"], .leaflet-marker-pane > .leaflet-marker-icon'),
    ).toHaveCount(1);
  });

  test('outage shows retrying and keeps the marker; stale after 60 s; recovery', async ({
    page,
    tracker,
    iss,
  }) => {
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    iss.setFallback(() => ({ status: 503, body: 'down' }));
    await tracker.advance(6_000);
    await expect(page.getByText(copy.retrying).first()).toBeVisible();
    await expect(tracker.marker()).toBeVisible();
    await expect(page.getByText(fmt.lat('45.01', 'N')).first()).toBeVisible();

    await tracker.advance(55_000); // total 61 s since the sample
    await expect(page.getByText(copy.stale).first()).toBeVisible();
    await expect(tracker.marker()).toBeVisible();

    iss.setFallback((now) =>
      json(position({ timestamp: Math.floor(now / 1000), latitude: 10, longitude: 20 })),
    );
    await tracker.advance(65_000);
    await expect(page.getByText(fmt.lat('10.00', 'N')).first()).toBeVisible();
    await expect(page.getByText(fmt.lon('20.00', 'E')).first()).toBeVisible();
    await expect(page.getByText(copy.stale)).toHaveCount(0);
    await expect(page.getByText(copy.retrying)).toHaveCount(0);
  });

  test('A13 first request fails: empty state, no marker, no fake (0, 0)', async ({
    page,
    tracker,
    iss,
  }) => {
    iss.setFallback(() => ({ status: 503, body: 'down' }));
    await tracker.open();
    await expect(page.getByText(copy.retrying).first()).toBeVisible();
    await expect(page.getByText(copy.empty).first()).toBeVisible();
    await expect(tracker.marker()).toHaveCount(0);
    await expect(page.getByText(/0\.00\s*°?\s*[NS]\b/)).toHaveCount(0);
  });

  test('network-level failure (connection reset) behaves like an outage', async ({
    page,
    tracker,
    iss,
  }) => {
    iss.setFallback(() => ({ abort: 'connectionreset' }));
    await tracker.open();
    await expect(page.getByText(copy.retrying).first()).toBeVisible();
    await expect(tracker.marker()).toHaveCount(0);
  });

  test('G1-v2 device clock far behind provider time: clock warning, never fresh', async ({
    page,
    tracker,
    iss,
  }) => {
    iss.setFallback((now) => json(position({ timestamp: Math.floor(now / 1000) + 20 })));
    await tracker.open();
    await tracker.advance(1_000);
    await expect(page.getByText(copy.deviceClock).first()).toBeVisible();
  });

  test('trail note is shown once a trail exists', async ({ page, tracker }) => {
    await tracker.open();
    await tracker.advance(10_000);
    await expect(page.getByText(copy.trailNote).first()).toBeVisible();
  });
});
