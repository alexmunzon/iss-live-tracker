// QA-owned (QA-1). E2E runs against the production build served by `vite preview`.
// All network traffic is intercepted in tests/e2e/fixtures.ts: the ISS API and OSM
// tiles are stubbed, and any other external host fails the test (OSM tile policy:
// no automated tile traffic from CI).
import { defineConfig, devices } from '@playwright/test';

// No @types/node in this project (frozen deps), so read process.env defensively.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const isCI = Boolean(env?.['CI']);

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !isCI,
    timeout: 180_000,
  },
});
