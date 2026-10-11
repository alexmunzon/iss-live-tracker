// Regenerates the README screenshots from a running `npm run preview` (http://localhost:4173).
// Manual use only: it makes a handful of real requests to the ISS API and OpenStreetMap,
// well within both usage policies. Never run it in CI or in a loop.
//   npm run build && npm run preview   (in one terminal)
//   node scripts/screenshots.mjs       (in another)
import { chromium } from '@playwright/test';

const base = process.env.BASE_URL ?? 'http://localhost:4173';
const out = new URL('../docs/images/', import.meta.url);

const shots = [
  { name: 'desktop-light.png', viewport: { width: 1280, height: 800 }, scheme: 'light' },
  { name: 'desktop-dark.png', viewport: { width: 1280, height: 800 }, scheme: 'dark' },
  {
    name: 'mobile-light.png',
    viewport: { width: 390, height: 844 },
    scheme: 'light',
    mobile: true,
  },
];

const browser = await chromium.launch();
try {
  for (const shot of shots) {
    const context = await browser.newContext({
      viewport: shot.viewport,
      colorScheme: shot.scheme,
      deviceScaleFactor: 2,
      isMobile: shot.mobile ?? false,
      hasTouch: shot.mobile ?? false,
    });
    const page = await context.newPage();
    await page.goto(base);
    // Wait for a real position, then a few seconds for tiles and a short trail.
    await page.locator('.iss-marker').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(12_000);
    await page.screenshot({
      path: new URL(shot.name, out).pathname,
      fullPage: shot.mobile ?? false,
    });
    console.log('saved', shot.name);
    await context.close();
  }
} finally {
  await browser.close();
}
