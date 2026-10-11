// A16 injection, request hygiene and CSP (contract G1-v2).
import { expect, fmt, json, position, test } from './fixtures';

const XSS_IMG = '<img src=x onerror="window.__qaXss=1;alert(1)">';
const XSS_SCRIPT = '<script>window.__qaXss=1</script>';

test.describe('A16 security', () => {
  test('injection strings in remote fields never become elements', async ({
    page,
    tracker,
    iss,
  }) => {
    iss.queue(
      json(position({ visibility: XSS_IMG, note: XSS_SCRIPT, extra: XSS_IMG })),
      json(position({ name: XSS_IMG, timestamp: 1791727288 })),
    );
    await tracker.open();
    await expect(page.getByText(fmt.lat('45.01', 'N')).first()).toBeVisible();
    await tracker.advance(6_000);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __qaXss?: unknown }).__qaXss),
    ).toBeUndefined();
    const inlineScripts = await page.evaluate(
      () => Array.from(document.querySelectorAll('script:not([src])')).length,
    );
    expect(inlineScripts).toBe(0);
    await expect(page.getByText(/onerror|<img|<script/)).toHaveCount(0);
  });

  test('HTML error page with text/html is not rendered', async ({ page, tracker, iss }) => {
    iss.setFallback(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/html' },
      body: `<html><body><h1>Hacked</h1>${XSS_IMG}</body></html>`,
    }));
    await tracker.open();
    await tracker.advance(1_000);
    await expect(page.getByText('Hacked')).toHaveCount(0);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expect(tracker.marker()).toHaveCount(0);
  });

  test('G1-v2 API request sends no Referer, no cookies, GET only, fixed URL', async ({
    tracker,
    iss,
  }) => {
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    expect(iss.requests.length).toBeGreaterThan(0);
    for (const req of iss.requests) {
      const headers = await req.allHeaders();
      expect(req.url()).toBe('https://api.wheretheiss.at/v1/satellites/25544');
      expect(req.method()).toBe('GET');
      expect(headers['referer']).toBeUndefined();
      expect(headers['cookie']).toBeUndefined();
    }
  });

  test('tile requests use the approved OSM URL only', async ({ page, tracker }) => {
    const tileUrls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('tile.openstreetmap.org')) tileUrls.push(r.url());
    });
    await tracker.open();
    await tracker.advance(1_000);
    await expect.poll(() => tileUrls.length).toBeGreaterThan(0);
    for (const u of tileUrls)
      expect(u).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
  });

  // CSP violations are asserted in the shared fixture teardown, active only when the
  // document response carries a content-security-policy header (added at integration).
  test('CSP: a full session produces no violations (when CSP is present)', async ({ tracker }) => {
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    await tracker.advance(11_000);
  });
});
