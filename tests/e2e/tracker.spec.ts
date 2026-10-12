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
    await expect(page.getByTestId('connection')).toHaveText(
      /^Source unavailable\. Next attempt in \d+ seconds?\./,
    );
    await expect(page.getByTestId('updates-state')).toHaveText('Retrying');
    await expect(tracker.marker()).toBeVisible();
    await expect(page.getByText(fmt.lat('45.01', 'N')).first()).toBeVisible();

    await tracker.advance(55_000); // total 61 s since the sample
    await expect(page.getByTestId('data-state')).toHaveText('Stale');
    await expect(tracker.marker()).toBeVisible();

    iss.setFallback((now) =>
      json(position({ timestamp: Math.floor(now / 1000), latitude: 10, longitude: 20 })),
    );
    await tracker.advance(65_000);
    await expect(page.getByText(fmt.lat('10.00', 'N')).first()).toBeVisible();
    await expect(page.getByText(fmt.lon('20.00', 'E')).first()).toBeVisible();
    // The About text legitimately explains "Stale", so assert the badge and notice themselves.
    await expect(page.getByTestId('data-state')).toHaveText('Fresh');
    await expect(page.getByTestId('updates-state')).toHaveText('Running');
    await expect(page.getByTestId('connection')).toHaveCount(0);
    await expect(page.getByTestId('last-problem')).toHaveCount(0);
  });

  test('A13 first request fails: empty state, no marker, no fake (0, 0)', async ({
    page,
    tracker,
    iss,
  }) => {
    iss.setFallback(() => ({ status: 503, body: 'down' }));
    await tracker.open();
    await expect(page.getByTestId('updates-state')).toHaveText('Retrying');
    await expect(page.getByTestId('connection')).toHaveText(/^Source unavailable\./);
    await expect(page.getByTestId('data-state')).toHaveText('Waiting');
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
    await expect(page.getByTestId('updates-state')).toHaveText('Retrying');
    await expect(page.getByTestId('connection')).toHaveText(/^Source unavailable\./);
    await expect(tracker.marker()).toHaveCount(0);
  });

  test('G1-v2 three consecutive samples > 30 s in the future: device clock warning, no position', async ({
    page,
    tracker,
    iss,
  }) => {
    // Each sample is 120 s ahead of the page clock → too-far-future, rejected; the third sets clockSuspect.
    iss.setFallback((now) => json(position({ timestamp: Math.floor(now / 1000) + 120 })));
    await tracker.open();
    // Requests at ~0, ~10–12 and ~30–36 s (backoff with up to 20 % jitter).
    await tracker.advance(40_000);
    expect(iss.requests.length).toBeGreaterThanOrEqual(3);
    await expect(page.getByText(/device.{0,2}s? clock/i).first()).toBeVisible();
    await expect(tracker.marker()).toHaveCount(0);
    await expect(page.getByText(fmt.lat('45.01', 'N'))).toHaveCount(0);
  });

  test('one sample 20 s ahead is shown, never labelled Fresh, with a future-skew note', async ({
    page,
    tracker,
    iss,
  }) => {
    iss.setFallback((now) => json(position({ timestamp: Math.floor(now / 1000) + 20 })));
    await tracker.open();
    await tracker.advance(1_000);
    await expect(page.getByText(fmt.lat('45.01', 'N')).first()).toBeVisible();
    await expect(tracker.marker()).toBeVisible();
    await expect(
      page.getByText(/ahead of this device.{0,2}s? clock|clock.{0,40}\bahead\b/i).first(),
    ).toBeVisible();
    // A future-skewed sample is capped at Delayed; assert the badge itself, not page text.
    await expect(page.getByTestId('data-state')).toHaveText('Delayed');
    await expect(page.getByTestId('data-state')).toHaveCount(1);
    // R3 regression: the +20 s sample reads Delayed AND the future-skew note is present.
    await expect(page.getByTestId('clock-skew')).toBeVisible();
    await expect(page.getByTestId('clock-skew')).toHaveText(/ahead of this device.{0,2}s? clock/i);
  });

  test('trail note is shown once a trail exists', async ({ page, tracker }) => {
    await tracker.open();
    await tracker.advance(10_000);
    await expect(page.getByTestId('trail-note')).toHaveText(copy.trailNote);
  });
});
