# Agent state

## Current status

This is the one current release state. Everything further down this file, and dated sections in other docs, is historical evidence.

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task                    | ISS Live Tracker: release prep (finish and polish, no new features)                                                                                                                                                                                                                                                                                                                          |
| Role                    | Coordinator (claude-opus-5-5)                                                                                                                                                                                                                                                                                                                                                                |
| Status                  | DEPLOYED AND VERIFIED: https://iss-live-tracker-ecru.vercel.app                                                                                                                                                                                                                                                                                                                              |
| Production              | `main` at `4ba1f02483e17fa2311a551322757123b177d8c5` (merge of PR #5: Mission Replay, on top of PR #4's review fixes at `bf31fa2`). Vercel production deployment completed 2026-10-12 (https://vercel.com/alexmunzon-4364s-projects/iss-live-tracker/D3ZnuXuFyDnLMYf7oqzdonWXJzDG). Vercel project `iss-live-tracker`, personal Hobby scope, Git-connected: every merge to `main` redeploys. |
| Repository              | Public `alexmunzon/iss-live-tracker`. PRs #1, #2, #4 and #5 merged; PR #3 closed as superseded by #4. CI passed on `main` at `4ba1f02` (run 38217782179).                                                                                                                                                                                                                                    |
| Tests at production     | At `4ba1f02` (2026-10-12): `npm run check` 18 files / 497 tests pass; `npm run test:e2e` 123/123 (Chromium, Firefox, WebKit), locally and in PR #5 CI.                                                                                                                                                                                                                                       |
| Live-site checks        | At `4ba1f02` (coordinator, 2026-10-12): live JS and CSS byte-identical (SHA-256) to a local build of `4ba1f02`; HTTP 200 with the CSP header. Accessibility-tree inspection and axe are automated or tool-assisted checks; they are not a screen-reader listening test.                                                                                                                      |
| Open review findings    | None open. R1–R4 from the independent review of `c537937` were fixed in PR #4 (merged and deployed at `bf31fa2`, 2026-10-12).                                                                                                                                                                                                                                                                |
| Active work             | None. Mission Replay (session-only scrubber over the newest 10 minutes of recorded tracker state) shipped in PR #5. Deferred by the owner: simulated demo sequence and replay export/import.                                                                                                                                                                                                 |
| Pending owner approvals | None.                                                                                                                                                                                                                                                                                                                                                                                        |
| Contract version        | G1-v2 + D16 (`docs/contracts.md`)                                                                                                                                                                                                                                                                                                                                                            |
| Writers                 | Owner lifted the 3-writer cap (D17); one writer per file still applies                                                                                                                                                                                                                                                                                                                       |
| Owner decisions         | Public repo `alexmunzon/iss-live-tracker` (created), Vercel hosting (deployed), trail in scope, browser/a11y/privacy defaults                                                                                                                                                                                                                                                                |
| Acceptance IDs          | See `docs/qa-evidence.md`. A20 local-origin PASS; A20 real-origin PASS (2026-10-11)                                                                                                                                                                                                                                                                                                          |

### Manual gaps (NOT RUN)

These stay NOT RUN until a person completes them independently:

- **Real screen-reader listening pass** (VoiceOver or NVDA), covering A15. Accessibility-tree inspection and axe do not count.
- **Physical device suspend and resume** (laptop lid close or phone lock), covering A05. Only simulated through wall-clock jumps.
- **Real phone** (touch, mobile Safari and Chrome). Phone layouts are checked only at emulated widths.
- **Long real-provider soak** (beyond the 10-minute live soak), covering A17.

### 2026-10-12: independent review findings

An independent review of `c537937` (11 Oct 2026) raised R1–R4. R1–R3 were code findings fixed with regression tests; R4 found these docs contradicted each other (deployed and not deployed, PR #2 still active, an old candidate SHA and stale test counts). All four were fixed in PR #4, merged and deployed 2026-10-12 at `bf31fa2`. Before that merge, production was `c537937` (Vercel `dpl_2m8S2Ss3QpiAQkbrNjmHuW2HNkZ7`; 446 tests, e2e 87/87, per the independent review).

## Historical: release candidate (as of 2026-10-11, `f09c312`)

Superseded by the current status above. Production later moved to `c537937`, which adds only UI-2 (`04c575c`) on top of this candidate.

| Field                        | Value                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate SHA / build digest | `f09c312f52eea3a06ec5e7dae3def0fb5d75b988` / `66bd8aa13534788b08f99428d1a4d5265cee30b349935845fd43e7fee23c7a82`                                                           |
| Final review                 | QA execution 87/87 + 435/435 stress (3 browsers), 445 unit + integration tests; fresh-clone reproducible build; security re-check APPROVED (one Low accepted, D18)        |
| First live verification      | 2026-10-11 ~20:03Z, before PR #2 merged: the live site served the `f09c312` build. Re-verified at `c537937` after the merge (see Live-site checks in the current status). |

## Historical: A20 local evidence — browser spike (2026-10-11)

- 2026-10-11 14:36:53 UTC, Chromium 152 (Claude browser pane), origin `http://localhost:5173`, Vite dev server at scaffold commit.
- `fetch(endpoint, { credentials: 'omit', cache: 'no-store', redirect: 'error' })` → 200, `type: 'cors'`, not redirected, 313 bytes, 3.67 s wall time.
- Readable headers: only `cache-control`, `content-length`, `content-type`. `Date`, `Retry-After` and `X-Rate-Limit-Remaining` → null (not exposed).
- Body: id 25544 (number), timestamp 1791729413 = local clock to the second (skew 0 s), `units: 'kilometers'`. Saved as `observedBrowser` in canonical fixtures.
- Provenance: TLE epoch 2026-10-10 18:56 UTC (~19 h old at check).
- OSM tile `2/1/1.png` loaded as an image from localhost: 256 px, 2.1 s.
- Note: a 3.7 s response is well inside the 8 s timeout, but slow responses are realistic. A06 must cover a slow request.

## Historical: commands verified at scaffold (2026-10-11)

`npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test` (1 smoke test), `npm run build` (68.66 kB gzip JS) all pass.
