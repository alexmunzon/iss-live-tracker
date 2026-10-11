// A14 responsive layout + attribution, A15 accessibility (contract G1-v2).
import AxeBuilder from '@axe-core/playwright';
import { copy, expect, test } from './fixtures';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];

type AxePage = ConstructorParameters<typeof AxeBuilder>[0]['page'];
/** @axe-core/playwright bundles its own playwright-core Page type; the runtime object is the same. */
const axe = (page: unknown) => new AxeBuilder({ page: page as AxePage });

test.describe('A14 responsive layout', () => {
  for (const [width, height] of [
    [320, 640],
    [768, 1024],
    [1440, 900],
  ] as const) {
    test(`${width}px: no horizontal scroll, attribution and provider credit visible`, async ({
      page,
      tracker,
    }) => {
      await page.setViewportSize({ width, height });
      await tracker.open();
      await expect(tracker.marker()).toBeVisible();
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
      const osm = page.getByRole('link', { name: copy.osm });
      await expect(osm.first()).toBeVisible();
      await expect(osm.first()).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
      await osm.first().scrollIntoViewIfNeeded();
      await expect(osm.first()).toBeInViewport();
      await expect(page.getByRole('link', { name: copy.provider }).first()).toBeVisible();
    });
  }
});

test.describe('A15 accessibility', () => {
  test('axe: no WCAG 2.2 AA violations in the fresh state', async ({ page, tracker }) => {
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    const result = await axe(page).withTags(WCAG_TAGS).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });

  test('axe: no WCAG 2.2 AA violations in the stale + retrying state', async ({
    page,
    tracker,
    iss,
  }) => {
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    iss.setFallback(() => ({ status: 503, body: 'down' }));
    await tracker.advance(61_000);
    await expect(page.getByText(copy.stale).first()).toBeVisible();
    const result = await axe(page).withTags(WCAG_TAGS).analyze();
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });

  test('keyboard: Tab reaches every control with visible focus and ≥ 44 px targets', async ({
    page,
    tracker,
    browserName,
  }) => {
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    const tabKey = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    const seen: { name: string; tag: string; focusVisible: boolean; w: number; h: number }[] = [];
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press(tabKey);
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
        const shadow = cs.boxShadow !== 'none' && cs.boxShadow !== '';
        return {
          name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
          tag: el.tagName.toLowerCase(),
          focusVisible: outline || shadow,
          w: r.width,
          h: r.height,
        };
      });
      if (info) seen.push(info);
    }
    const names = seen.map((s) => s.name);
    const required = [
      /pause|resume/i,
      /recenter/i,
      /zoom in/i,
      /zoom out/i,
      /pan|move map|north|up/i,
      copy.osm,
    ];
    for (const pattern of required) {
      expect(
        names.some((n) => pattern.test(n)),
        `Tab never reached ${pattern}`,
      ).toBe(true);
    }
    const retry = page.getByRole('button', { name: /retry/i });
    if ((await retry.count()) > 0 && (await retry.first().isEnabled())) {
      expect(
        names.some((n) => /retry/i.test(n)),
        'enabled Retry not reachable',
      ).toBe(true);
    }
    for (const s of seen) {
      expect(s.focusVisible, `no visible focus on ${s.tag} "${s.name}"`).toBe(true);
      if (s.tag === 'button') {
        expect(s.w, `${s.name} narrower than 44px`).toBeGreaterThanOrEqual(44);
        expect(s.h, `${s.name} shorter than 44px`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('live region is polite and does not tick', async ({ page, tracker }) => {
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    const live = page.locator('[aria-live="polite"], [role="status"]');
    await expect(live.first()).toBeAttached();
    const before = await live.allTextContents();
    await tracker.advance(4_000);
    expect(await live.allTextContents()).toEqual(before);
  });
});
