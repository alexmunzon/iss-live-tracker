# ISS Live Tracker — Phase 0 plan (G0)

Status: **PLANNING. No application code written.** Waiting for owner approval (G0).
Prepared: 2026-10-11 by the coordinator session.

## 1. Environment (recorded, not assumed)

| Item             | Value                                                   | Check                                       |
| ---------------- | ------------------------------------------------------- | ------------------------------------------- |
| Provider / model | Anthropic, `claude-opus-5-5` (this coordinator session) | Session model ID                            |
| Claude Code      | 2.1.289                                                 | `claude --version`; required ≥ 2.1.280 → OK |
| Node / npm       | v24.16.0 / 11.13.0                                      | `node --version`, `npm --version`           |
| Git              | 2.50.1                                                  | `git --version`                             |
| Project folder   | `~/satellite` (created empty 2026-10-11)                | `ls -la`                                    |
| Stray folder     | `~/satellite ` (trailing space, empty)                  | Deleted at owner request (2026-10-11)       |

## 2. Source facts — HTTP probe (curl, not a browser test)

One request each, 2026-10-11 ~14:01 UTC. This is point-in-time evidence. It does **not** satisfy A20 (browser check from the app origin), which runs right after G0.

**Where the ISS at — `GET https://api.wheretheiss.at/v1/satellites/25544`**

- HTTP 200, `Content-Type: application/json`, 311 bytes, `Cache-Control: max-age=0, no-cache`.
- `Access-Control-Allow-Origin: *`. **No `Access-Control-Expose-Headers`**, so browser code cannot read the rate-limit headers, `Date` or `Retry-After`. The scheduler must assume they are unreadable (429 → wait ≥ 60 s).
- Rate limit advertised in headers: `X-Rate-Limit-Limit: 350` per `X-Rate-Limit-Interval: 5 minutes`.
  - One tab at 5 s = 60 requests / 5 min (17% of the limit).
  - **The limit appears to be per IP.** Six tabs behind one IP (a dorm or office network) = 360 / 5 min, over the limit. Acceptable for a personal MVP; a real constraint if public.
- Body shape observed:
  `{"name":"iss","id":25544,"latitude":45.0057…,"longitude":-18.3963…,"altitude":427.80…,"velocity":27571.55…,"visibility":"daylight","footprint":4546.96…,"timestamp":1791727283,"daynum":…,"solar_lat":…,"solar_lon":…,"units":"kilometers"}`
  - `id` is a **number**; `timestamp` is **Unix seconds** (matched the local clock to the second, so positions are calculated on request).
  - `units:"kilometers"` → altitude in km, velocity in km/h (27,572 km/h is plausible for the ISS).
- Server banner: `Apache/2.2.22 (Ubuntu)`, `PHP/5.3.10`. Both are long end-of-life. Consequence: treat the provider as best-effort with no SLA, and treat every response as untrusted input (validation plus a 64 KiB body cap). This is not a vulnerability in our app.

**Orbital elements — `GET /v1/satellites/25544/tles`** (provenance check, once, not polled)

- `tle_timestamp` 1791658591 (2026-10-10 ~18:56 UTC). TLE line 1 epoch `26283.78925095` = day 283 of 2026, the same moment.
- Element age at probe ≈ 19 hours → **current**, consistent with the research claim that WTIA uses October 2026 elements.
- Note: this endpoint returns `"id":"25544"` as a **string**, unlike the position endpoint. The app does not consume it.

**OpenStreetMap tile — `HEAD https://tile.openstreetmap.org/2/1/1.png`**

- HTTP/2 200, `image/png`, `Access-Control-Allow-Origin: *`, `Cache-Control: max-age=521777` (~6 days), served through a CDN cache.

## 2b. Documentation recheck (research subagent, 2026-10-11)

- **WTIA docs:** "roughly 1 per second" rate limit, consistent with the 350 / 5 min header. No API key. Default `units=kilometers`. The docs do not define timestamp units; the probe shows Unix seconds. There are no formal terms or attribution rules, but we credit "Where the ISS at" in the UI anyway.
- **Leaflet:** stable is **1.9.4** (npm `latest`), prerelease 2.0.0-alpha.1. **Trap:** the download page's "latest stable" CDN snippets point at 2.0.0-alpha.1. We install from npm at exactly 1.9.4 and bundle it locally, with no CDN.
- **OSM tile policy:** HTTPS URL only. Attribution "© OpenStreetMap contributors", linked to the copyright page and never hidden. A valid Referer must be sent (`strict-origin-when-cross-origin` is fine). Honor cache headers. No prefetching, offline downloads or headless panning bots, so CI must intercept tiles. No numeric threshold and no SLA; access can be blocked without notice.
- **Claude Code:** the docs state Opus 5.5 requires ≥ 2.1.280. Installed is 2.1.289 → OK.
- **Dependency freshness:** 7 of 14 candidate packages released a version in the last 14 days (vite, @vitejs/plugin-react, vitest, @playwright/test, msw, eslint, prettier). **Policy:** pin each to the newest version published **≥ 14 days ago**, checked against the registry `time` field at install. This lowers the risk of installing a compromised or broken fresh release. TypeScript 7.0.x (native compiler) must be confirmed compatible with typescript-eslint and Vite at scaffold. If it isn't, fall back to the newest compatible 6.x/5.x and record the decision. MSW is probably unnecessary, since injected `fetch` plus Playwright routing should cover it.

## 3. Scope (safe defaults unless the owner changes them)

In: responsive world map, one marker after the first accepted sample, lat/lon with N/S E/W, provider name, UTC calculation time, age in words, fresh/delayed/stale/unverified, independent connection state, follow, recenter, pause/resume, retry, complete loading/error/map-unavailable states, WCAG 2.2 AA target.

Out (P1+ or non-goals): trail, altitude/speed display, offline basemap, orbital-age display, shared cache, accounts, DB, analytics, geolocation, payments, notifications, 3D, predictions, interpolation, multiple satellites, any AI/LLM at runtime.

## 4. Architecture and data flow

```
scheduler (pollingMachine) → issClient (fixed URL, 8 s timeout, 64 KiB cap)
  → validatePosition → freshness/order reducer → snapshot
  → useTracker (React adapter, one scheduler) → App → IssMap (Leaflet) + status panel
```

The map never fetches or owns timers. The client never moves the map. Domain functions are pure, with injected wall clock, monotonic clock and randomness.

Stack: React + TypeScript (strict) + Vite, Leaflet 1.9.x stable (no 2.x prerelease), native `fetch`, Vitest + React Testing Library, Playwright + axe for E2E/accessibility. MSW only if Playwright route interception plus injected fetch are not enough. npm with a committed lockfile.

## 5. Ownership map

| Owner             | Files                                                                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator       | `src/domain/position.ts`, `src/config/trackerPolicy.ts`, `tests/fixtures/canonical/`, `src/features/tracker/useTracker.ts` + tests, `src/app/App.tsx`, package/lockfile, TS/Vite/test configs, CI, host headers, README, `docs/contracts.md`, `docs/decisions.md`, `docs/agent-state.md` |
| Data agent        | `src/domain/validatePosition.ts`, `src/domain/freshness.ts`, `src/data/issClient.ts`, `src/data/pollingMachine.ts`, their unit tests                                                                                                                                                     |
| Map/UI agent      | `src/features/map/`, `src/features/status/`, `src/styles/`, `public/` assets, component tests                                                                                                                                                                                            |
| QA agent          | `tests/integration/`, `tests/e2e/`, `tests/fixtures/adversarial/`, `docs/qa-evidence.md`                                                                                                                                                                                                 |
| Security reviewer | Read-only review report                                                                                                                                                                                                                                                                  |

Max three concurrent writers including the coordinator. Each writer gets a worktree created explicitly from the committed G1 SHA.

## 6. Dependency graph and gates

G0 owner approves this plan → git init + scaffold + **browser spike from `http://localhost`** (A20 local part) → **G1** contracts, policy constants, canonical fixtures committed at a base SHA → Data ∥ Map/UI ∥ QA test design → **G2** coordinator integrates `useTracker`/`App`, freezes candidate SHA + build digest → QA executes ∥ Security reviews → **G3** full gate ledger → local handoff. Deployment is a separate owner decision.

## 7. Threat model

| Threat                                                                           | Control                                                                                                                     | Evidence (ID)      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Hostile or malformed API JSON (EOL server, possible compromise or MITM upstream) | Fixed HTTPS URL, redirect rejected, 64 KiB bounded read, strict runtime validation, no coercion                             | A02, A03, A16      |
| XSS through remote values                                                        | Text rendering only; no `innerHTML`, no Leaflet HTML popups with remote strings; CSP                                        | A16                |
| Request storms / provider ban                                                    | One scheduler, single flight, ≥5 s spacing, jittered backoff, 429 ≥ 60 s, stop on 401/403/404, pause when hidden            | A06–A09, A17       |
| Misleading data (stale shown as live, fake 0,0)                                  | Source-time freshness, monotonic age, no marker before first sample, no fallback provider                                   | A04, A05, A13, A19 |
| Secret exposure                                                                  | No secrets needed; `VITE_*` treated as public; bundle + repo secret scan                                                    | A16                |
| Dependency compromise                                                            | Minimal deps, pinned lockfile, review install scripts, targeted audit                                                       | A16                |
| Privacy                                                                          | No analytics or geolocation; privacy note says the ISS API and tile server see visitor IPs                                  | README review      |
| OSM policy breach                                                                | Visible attribution link, browser caching, `strict-origin-when-cross-origin` referrer, no prefetch, tiles intercepted in CI | A14, A16           |
| Agent overreach                                                                  | Plan mode first, owner approval for deps, deploys, pushes, accounts                                                         | Process            |

**Added after the early security review (G1-v2):**

| Threat                                      | Control                                                                     | Evidence (ID)     |
| ------------------------------------------- | --------------------------------------------------------------------------- | ----------------- |
| Clickjacking                                | `frame-ancestors 'none'` as a response header (D11)                         | A16               |
| Host can't set headers                      | Hosting requirement D11                                                     | Deployment review |
| Leaflet internal HTML sinks                 | Lint bans, attribution from constants                                       | A16               |
| Timer overflow / unbounded server wait      | 1 h cap, delay clamp, wake re-check                                         | A08               |
| Wrong local clock → outage or frozen marker | Future streak → clock warning; older streak → re-anchor                     | A05, A08          |
| CI pipeline                                 | `npm ci`, no secrets, pinned action SHAs (when CI is added)                 | Release review    |
| Post-launch supply chain                    | Lockfile review on every dependency change; periodic `npm audit`            | Release review    |
| HTTPS / DNS takeover                        | HSTS on host; remove DNS records if the site is retired                     | Deployment review |
| OSM compromise or blocking                  | Tiles are images only (no script); map-unavailable state keeps text working | A13               |

## 8. Acceptance ledger (all NOT RUN)

A01–A20 exactly as defined in the coordinator prompt. A18 is excluded unless the trail is approved. A20 has two parts: local-origin browser check (after G0) and real-origin check (only after an approved deployment).

## 9a. Owner decisions recorded 2026-10-11

| Decision                     | Answer                  | Consequence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audience                     | **Public project**      | Build to public standards now: real response headers for the chosen host, privacy note, provider and tile policy review before launch. Hosting choice and the deployment itself remain separate approvals. Requests go directly from browsers, so each visitor uses their own per-IP API budget; only shared networks (NAT, dorms) concentrate load. OSM tiles have no SLA and can block heavy users without notice, so P1 should include a documented tile-provider switch path before real traffic. |
| Session trail                | **Included**            | A18 is in scope. ≤120 points and ≤10 minutes, split at the antimeridian and after long gaps, labelled "Observed during this session." No predicted orbit. Adds `src/domain/trail.ts` (data agent) and trail rendering (UI agent).                                                                                                                                                                                                                                                                     |
| Stray folder `~/satellite `  | **Delete**              | Removed with `rmdir`, which only deletes empty folders.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Browsers, extra a11y/privacy | Not answered → defaults | Current Chrome, Safari, Firefox and Edge; WCAG 2.2 AA; no analytics; no geolocation.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| G0 implementation approval   | **Not yet given**       | No git init, installs or code until the owner says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 9. Decisions needed from the owner (original list)

1. Personal project or public? (default: personal, local only)
2. Hosting target? (default: none yet; deployment needs separate approval)
3. Include the session trail now? (default: no)
4. Browsers? (default: current Chrome, Safari, Firefox, Edge; Playwright runs Chromium, Firefox and WebKit)
5. Extra accessibility or privacy constraints? (default: WCAG 2.2 AA, no analytics, no geolocation)
6. Stray empty folder `~/satellite ` (trailing space): delete it, or leave it?

## 10. What G0 approval authorizes

- `git init` and local commits (never push).
- Installing the reviewed dependency list from the npm registry.
- Scaffolding, then the localhost browser spike.
- Implementation through G3 with subagents.

Not authorized without a separate yes: pushing, PRs, deployment, accounts, purchases, paid APIs, deleting anything outside this folder.
