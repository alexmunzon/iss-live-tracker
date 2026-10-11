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

// WCAG 1.4.10 Reflow. Browser zoom on a 1280×720 screen is emulated by the equivalent CSS
// viewport (200% → 640×360, 400% → 320×180); landscape phone is 844×390.
// "Reachable" here means: reachable by VERTICAL page scroll alone (window.scrollX stays 0),
// then fully inside the viewport horizontally and in view. 1.4.10 allows vertical scrolling
// for horizontally-written content, but must not require two-dimensional scrolling, so the
// attribution and every control may be below the fold but never off to the side.
test.describe('A14 reflow and landscape layouts', () => {
  for (const [label, width, height] of [
    ['landscape phone 844x390', 844, 390],
    ['200% zoom of 1280x720 (640x360)', 640, 360],
    ['400% zoom of 1280x720 (320x180)', 320, 180],
  ] as const) {
    test(`${label}: no horizontal scroll; attribution, credit and every control reachable`, async ({
      page,
      tracker,
    }) => {
      await page.setViewportSize({ width, height });
      await tracker.open();
      await expect(tracker.marker()).toBeAttached();
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(overflow.scroll, 'horizontal page scroll').toBeLessThanOrEqual(overflow.client);

      // Fully on screen after a scroll, with 1 CSS px tolerance for sub-pixel layout
      // (IntersectionObserver reports e.g. 0.97 for a 17 px link that is 0.5 px short).
      const reachable = async (locator: ReturnType<typeof page.locator>, what: string) => {
        await locator.scrollIntoViewIfNeeded();
        await expect(locator, `${what} in viewport`).toBeInViewport();
        const box = await locator.boundingBox();
        expect(box, `${what} has a box`).not.toBeNull();
        if (!box) return;
        expect(box.x, `${what} left edge`).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width, `${what} right edge`).toBeLessThanOrEqual(width + 1);
        expect(box.y, `${what} top edge`).toBeGreaterThanOrEqual(-1);
        expect(box.y + box.height, `${what} bottom edge`).toBeLessThanOrEqual(height + 1);
        expect(await page.evaluate(() => window.scrollX), `${what}: horizontal scroll`).toBe(0);
      };

      const osm = page.getByRole('link', { name: copy.osm }).first();
      await expect(osm).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
      await reachable(osm, 'OSM attribution');
      await reachable(page.getByRole('link', { name: copy.provider }).first(), 'provider credit');

      // Every control must exist (not vacuous) ...
      for (const name of [/pause|resume/i, /recenter/i, /zoom in/i, /zoom out/i]) {
        await expect(page.getByRole('button', { name }).first(), `${name}`).toBeAttached();
      }
      // ... and every button, link and disclosure summary must be reachable; enabled ones must
      // accept a click (trial click = Playwright's actionability check: visible, stable, not
      // covered). Content of a collapsed <details> is not rendered, so pass 1 skips it; pass 2
      // opens every disclosure through its summary and requires everything inside to be
      // reachable too.
      const controls = page.locator('button, a[href], summary');
      const inClosedDetails = (el: Element) => {
        const d = el.closest('details:not([open])');
        const summary = d?.querySelector(':scope > summary');
        return Boolean(d) && !summary?.contains(el);
      };
      const checkAll = async (pass: string) => {
        const count = await controls.count();
        let checked = 0;
        for (let i = 0; i < count; i += 1) {
          const c = controls.nth(i);
          if (await c.evaluate(inClosedDetails)) continue;
          const name = (
            (await c.getAttribute('aria-label')) ??
            (await c.textContent()) ??
            ''
          ).trim();
          await reachable(c, `${pass}: control "${name}"`);
          if (await c.isEnabled()) await c.click({ trial: true });
          checked += 1;
        }
        return checked;
      };
      expect(await checkAll('collapsed')).toBeGreaterThan(4);
      const closedSummaries = page.locator('details:not([open]) > summary');
      while ((await closedSummaries.count()) > 0) {
        const summary = closedSummaries.first();
        await summary.scrollIntoViewIfNeeded();
        await summary.click();
      }
      expect(await checkAll('expanded')).toBe(await controls.count());

      // Operable for real: Pause toggles to Resume and back.
      const pause = page.getByRole('button', { name: /^pause/i }).first();
      await pause.scrollIntoViewIfNeeded();
      await pause.click();
      const resume = page.getByRole('button', { name: /^resume/i }).first();
      await expect(resume).toBeVisible();
      await resume.click();
      await expect(page.getByRole('button', { name: /^pause/i }).first()).toBeVisible();
    });
  }
});

test.describe('A15 accessibility', () => {
  test('axe: no WCAG 2.2 AA violations in the fresh state', async ({ page, tracker }) => {
    await tracker.open();
    await expect(tracker.marker()).toBeVisible();
    // axe-core schedules work with setTimeout; the paused fake clock would stall it.
    await page.clock.resume();
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
    // axe-core schedules work with setTimeout; the paused fake clock would stall it.
    await page.clock.resume();
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
