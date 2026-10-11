# Agent state

| Field                        | Value                                                                                                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task                         | ISS Live Tracker: release prep (finish and polish, no new features)                                                                                                                                                                             |
| Role                         | Coordinator (claude-opus-5-5)                                                                                                                                                                                                                   |
| Status                       | DEPLOYED AND VERIFIED: https://iss-live-tracker-ecru.vercel.app (Vercel project `iss-live-tracker`, personal Hobby scope, Git-connected; build of f09c312 verified 2026-10-11). Branch `release-live` adds the UI-2 accessibility fix and docs. |
| Contract version             | G1-v2 + D16 (`docs/contracts.md`)                                                                                                                                                                                                               |
| Writers                      | Owner lifted the 3-writer cap (D17); one writer per file still applies                                                                                                                                                                          |
| Active work                  | PR for `release-live`; after merge, re-verify the auto-redeploy (headers, console, a11y tree).                                                                                                                                                  |
| Candidate SHA / build digest | `f09c312f52eea3a06ec5e7dae3def0fb5d75b988` / `66bd8aa13534788b08f99428d1a4d5265cee30b349935845fd43e7fee23c7a82`                                                                                                                                 |
| Final review                 | QA execution 87/87 + 435/435 stress (3 browsers); fresh-clone reproducible build; security re-check APPROVED (one Low accepted, D18)                                                                                                            |
| Owner decisions              | Public repo `alexmunzon/iss-live-tracker` (not created), Vercel hosting (not deployed), trail in scope, browser/a11y/privacy defaults                                                                                                           |
| Pending owner approvals      | Merge the `release-live` PR                                                                                                                                                                                                                     |
| Acceptance IDs               | See `docs/qa-evidence.md`. A20 local-origin PASS; A20 real-origin NOT RUN (not deployed)                                                                                                                                                        |

## A20 local evidence — browser spike

- 2026-10-11 14:36:53 UTC, Chromium 152 (Claude browser pane), origin `http://localhost:5173`, Vite dev server at scaffold commit.
- `fetch(endpoint, { credentials: 'omit', cache: 'no-store', redirect: 'error' })` → 200, `type: 'cors'`, not redirected, 313 bytes, 3.67 s wall time.
- Readable headers: only `cache-control`, `content-length`, `content-type`. `Date`, `Retry-After` and `X-Rate-Limit-Remaining` → null (not exposed).
- Body: id 25544 (number), timestamp 1791729413 = local clock to the second (skew 0 s), `units: 'kilometers'`. Saved as `observedBrowser` in canonical fixtures.
- Provenance: TLE epoch 2026-10-10 18:56 UTC (~19 h old at check).
- OSM tile `2/1/1.png` loaded as an image from localhost: 256 px, 2.1 s.
- Note: a 3.7 s response is well inside the 8 s timeout, but slow responses are realistic. A06 must cover a slow request.

## Commands verified at scaffold

`npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test` (1 smoke test), `npm run build` (68.66 kB gzip JS) all pass.
