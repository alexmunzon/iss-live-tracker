# ISS Live Tracker

A small static web app that shows where the International Space Station is on a world map, refreshes about every five seconds while the tab is visible, and says plainly how old the position is.

Status labels this project uses: **Implemented** (gates incomplete) → **Locally verified** → **Deployment ready** → **Deployed and verified**. See `docs/qa-evidence.md` for the current ledger. The app has not been deployed.

## Setup

Requires Node ≥ 22.12 (developed on Node 24.16, npm 11.13).

```bash
npm ci          # installs exactly the lockfile; install scripts are disabled by .npmrc
npm run dev     # http://localhost:5173
```

## Commands

| Command                    | What it checks                                                          |
| -------------------------- | ----------------------------------------------------------------------- |
| `npm run format:check`     | Prettier formatting                                                     |
| `npm run lint`             | ESLint, including HTML-sink and eval bans                               |
| `npm run typecheck`        | Strict TypeScript                                                       |
| `npm run test:unit`        | Domain, data, UI and hook unit tests (Vitest, jsdom)                    |
| `npm run test:integration` | Cross-module and App tests with fake clocks                             |
| `npm run build`            | Typecheck + production build to `dist/`                                 |
| `npm run test:e2e`         | Playwright against `vite preview` (needs `npx playwright install` once) |
| `npm run check`            | Everything above except E2E                                             |

CI, unit and E2E tests never call the real ISS API or OpenStreetMap; both are intercepted.

## How it works

```
pollingMachine (one timer, one request) → issClient (fixed URL, 8 s timeout, 64 KiB cap)
  → validatePosition → freshness/ordering → snapshot → useTracker → App → IssMap + StatusPanel
```

- `src/domain/position.ts`: shared types. `src/config/trackerPolicy.ts`: every timing and threshold.
- The map never fetches data or owns timers. The network code never moves the map.
- Contracts: `docs/contracts.md`. Decisions: `docs/decisions.md`.

## What the data means

- Positions come from [Where the ISS at](https://wheretheiss.at/), which calculates them from published orbital elements. They are **estimates, not onboard telemetry**, and carry no accuracy guarantee. Two-decimal coordinates are display precision only.
- **Fresh** ≤ 15 s old, **Delayed** ≤ 60 s, **Stale** > 60 s, measured from the provider's calculation time. These are product rules, not accuracy claims.
- Connection state is shown separately from data age. When the source fails, the last real position stays visible with its true age. The app never invents, predicts or swaps in another provider's coordinates.
- The trail shows only positions received while the page has been open (≤ 120 points, ≤ 10 minutes). It splits at the antimeridian and after gaps.

## Privacy

Your browser requests positions from `api.wheretheiss.at` and map images from `tile.openstreetmap.org`. Both receive your IP address and browser details; the hosting provider will log requests too. The site sets no cookies, has no analytics or accounts, never asks for your location, and stores nothing. The trail lives in memory and is gone when you close the page.

## Credits and licenses

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), tiles used under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/): attribution always visible, browser caching, no prefetching. Heavy public traffic may need a different tile provider (backlog P1).
- Position data: [Where the ISS at](https://wheretheiss.at/) (no API key; about 1 request per second per client allowed).
- Shipped libraries: React and React DOM (MIT, © Meta Platforms, Inc.), scheduler (MIT), Leaflet 1.9.4 (BSD-2-Clause, © 2010-2023 Volodymyr Agafonkin, © 2010-2011 CloudMade). The bundler strips license comments, so full texts ship as `/NOTICES.txt` (from `public/NOTICES.txt`). Regenerate it whenever a runtime dependency changes.

## Known limitations

- A visitor whose device clock runs more than 30 s slow sees a "device clock looks wrong" message instead of a position (D15).
- Browsers can't read the provider's rate-limit or `Retry-After` headers (not exposed via CORS), so a rate limit is handled as "wait at least 60 s".
- About 6 open tabs sharing one network IP would exceed the provider's limit of 350 requests per 5 minutes.
- OpenStreetMap's public tiles have no SLA and can be blocked without notice. When tiles fail, the text panel keeps working.

## Deployment (not done; needs owner approval)

1. Pick a static host that supports **custom response headers** (D11).
2. `npm ci && npm run check && npm run test:e2e`, then upload `dist/`.
3. Configure these response headers on every HTML response. They mirror `securityHeaders` in `vite.config.ts`:
   - `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://tile.openstreetmap.org; connect-src https://api.wheretheiss.at; font-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `Permissions-Policy: geolocation=(), camera=(), microphone=()`
   - `Cross-Origin-Opener-Policy: same-origin`
   - `Strict-Transport-Security: max-age=31536000` (HTTPS only)
4. Cache `assets/*` (content-hashed) for a long time; serve `index.html` with `Cache-Control: no-cache` so a new release is picked up.
5. After deploying, verify on the real URL: HTTPS, the headers above, no CSP errors in the console, the marker moving, attribution visible, and the outage and stale states.

## Rollback

Redeploy the previous known-good `dist/` (or the host's previous deployment) with the same headers. If the provider is down, leave the app up: it shows an honest stale state. Don't switch providers in a hurry.
