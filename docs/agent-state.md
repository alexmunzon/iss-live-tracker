# Agent state

## Current status

This is the one current release state. Everything further down this file, and dated sections in other docs, is historical evidence.

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task                    | ISS Live Tracker: release prep (finish and polish, no new features)                                                                                                                                                                                                                                                                                  |
| Role                    | Coordinator (claude-opus-5-5)                                                                                                                                                                                                                                                                                                                        |
| Status                  | DEPLOYED AND VERIFIED: https://iss-live-tracker-ecru.vercel.app                                                                                                                                                                                                                                                                                      |
| Production              | `main` at `c537937469b885202026948a28727c7b89aa924a` (merge of PR #2, includes the UI-2 accessibility fix). Vercel deployment `dpl_2m8S2Ss3QpiAQkbrNjmHuW2HNkZ7`, READY (independent review, 2026-10-11). Vercel project `iss-live-tracker`, personal Hobby scope, Git-connected: every merge to `main` redeploys.                                   |
| Repository              | Public `alexmunzon/iss-live-tracker`. PRs #1 and #2 merged. CI passed on `main` at `c537937` (run 38181870111).                                                                                                                                                                                                                                      |
| Tests at production     | At `c537937` (independent review, 2026-10-11): `npm run check` 14 files / 446 tests pass; `npm run test:e2e` 87/87 (Chromium, Firefox, WebKit).                                                                                                                                                                                                      |
| Tests at fix branch     | At `fd47ba8` (`fix/review-findings`, not deployed): `npm run check` 14 files / 449 tests pass; `npm run test:e2e` 102/102 (Chromium, Firefox, WebKit).                                                                                                                                                                                               |
| Live-site checks        | At `c537937` (coordinator, 2026-10-11): live JS byte-identical to the local build, exact `vercel.json` headers, live data in Chromium, Firefox and WebKit, 0 errors, no unnamed images in the Chromium accessibility tree. Accessibility-tree inspection and axe are automated or tool-assisted checks; they are not a screen-reader listening test. |
| Open review findings    | R1–R4 from the independent review of `c537937` (logged 2026-10-12). Fixes are on `fix/review-findings` at `fd47ba8`, **pending merge and not deployed**. Production still runs `c537937`.                                                                                                                                                            |
| Active work             | Fixes for R1–R4 (code and regression tests for R1–R3; this documentation reconciliation for R4). This branch contains PR #3's edits, so it supersedes PR #3.                                                                                                                                                                                         |
| Pending owner approvals | Merge the `fix/review-findings` PR (and close PR #3, which it supersedes). The merge redeploys production.                                                                                                                                                                                                                                           |
| Contract version        | G1-v2 + D16 (`docs/contracts.md`)                                                                                                                                                                                                                                                                                                                    |
| Writers                 | Owner lifted the 3-writer cap (D17); one writer per file still applies                                                                                                                                                                                                                                                                               |
| Owner decisions         | Public repo `alexmunzon/iss-live-tracker` (created), Vercel hosting (deployed), trail in scope, browser/a11y/privacy defaults                                                                                                                                                                                                                        |
| Acceptance IDs          | See `docs/qa-evidence.md`. A20 local-origin PASS; A20 real-origin PASS (2026-10-11)                                                                                                                                                                                                                                                                  |

### Manual gaps (NOT RUN)

These stay NOT RUN until a person completes them independently:

- **Real screen-reader listening pass** (VoiceOver or NVDA), covering A15. Accessibility-tree inspection and axe do not count.
- **Physical device suspend and resume** (laptop lid close or phone lock), covering A05. Only simulated through wall-clock jumps.
- **Real phone** (touch, mobile Safari and Chrome). Phone layouts are checked only at emulated widths.
- **Long real-provider soak** (beyond the 10-minute live soak), covering A17.

### 2026-10-12: independent review findings

An independent review of `c537937` (11 Oct 2026) raised R1–R4. R1–R3 are code findings fixed with regression tests; R4 found these docs contradicted each other (deployed and not deployed, PR #2 still active, an old candidate SHA and stale test counts). The fixes are on `fix/review-findings` at `fd47ba8`, pending merge. **Not deployed.**

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
