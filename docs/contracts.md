# Contracts (frozen at G1)

Types: `src/domain/position.ts`. Constants: `src/config/trackerPolicy.ts`. Canonical fixtures: `tests/fixtures/canonical/`. This file defines behavior the types cannot express. Contract version: **G1-v1**.

## 1. Validation — `validatePosition(raw, receivedAtMs)` (`src/domain/validatePosition.ts`)

- `raw` must be a non-null, non-array object. Otherwise `not-an-object`.
- Identity: `id === 25544` (number, strictly). `name`, if present, must be `"iss"`. Otherwise `wrong-identity`.
- `latitude`: `typeof === 'number'`, finite, in [-90, 90]. Otherwise `invalid-latitude`. `longitude` likewise in [-180, 180]: `invalid-longitude`. No coercion of strings, booleans or null.
- `timestamp`: number, finite, integer. Otherwise `invalid-timestamp`. `>= millisecondsHeuristicSec`: `timestamp-looks-like-milliseconds`. `< minTimestampSec`: `timestamp-implausible`. Future checks need a clock, so they belong to ordering (§3), not here.
- `positionTimeMs = timestamp * 1000`, converted exactly once, here.
- Optional metrics are only included when `units === 'kilometers'` (otherwise issue `units-not-kilometers` and both omitted). `altitude` must be finite and within [100, 2000] km, otherwise omitted with `altitude-invalid`. `velocity` must be finite and within [20000, 32000] km/h, otherwise omitted with `velocity-invalid`. Bad optional fields never invalidate the sample.
- Unknown extra fields are ignored. (0, 0) is valid.
- Rendering latitude beyond Mercator's ±85.0511° is a map concern (§6), not a validation failure.

## 2. Client — `createIssClient(deps): IssClient` (`src/data/issClient.ts`)

- Only `trackerPolicy.endpointUrl`. `fetch(url, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal, headers: { Accept: 'application/json' } })`.
- One combined signal: caller's `signal` OR the internal `requestTimeoutMs` timer (via injected `timers`). The timer stays armed through the body read and is always cleared on settle.
- Classification, first match wins: caller aborted → `aborted`; timeout fired → `timeout`; fetch rejected with `redirect: 'error'` cannot be told apart from a network error, so treat it as `network` (`redirect` is reserved for `response.redirected === true` or `type === 'opaqueredirect'`); `!response.ok` → `http` with `retryAfter` (seconds form: non-negative integer; date form: HTTP-date parsed to epoch ms; anything else null) and `serverDateMs` (`Date` header if readable, else null); content-type without `application/json` → `unexpected-content-type`; `Content-Length > maxBodyBytes` → `body-too-large` without reading; streamed bytes exceed `maxBodyBytes` → cancel the reader, `body-too-large`; stream error → `body-read-failed`; `JSON.parse` fails → `invalid-json`; validation rejects → `invalid-payload`.
- `receivedAtMs = clock.wallNowMs()` once the body is complete.
- Never throws, never logs payloads, never touches the DOM or the map.

## 3. Ordering — `decideAcceptance(current, incoming, wallNowMs)` (`src/domain/freshness.ts`)

1. `incoming.positionTimeMs > wallNowMs + maxFutureSkewMs` → `too-far-future`.
2. `current === null` → `accept`.
3. `incoming.positionTimeMs > current.positionTimeMs` → `accept`.
4. Equal time with equal lat/lon (strict `===`) → `duplicate`. Equal time with different lat/lon → `conflict`.
5. Otherwise → `older`.

Only `accept` changes the anchor or the trail. `duplicate` still counts as a validated response for transport purposes (resets backoff) but does not reanchor age.

## 4. Freshness — `createAnchor(sample, clock)` and `computeFreshness(anchor, clock)` (`src/domain/freshness.ts`)

- Anchor: `anchorWallMs = wallNow`, `anchorMonoMs = monoNow`, `sourceAgeAtReceiptMs = max(0, wallNow − positionTimeMs)`, `futureSkew = positionTimeMs > wallNow`.
- View: `anchor === null` → `{ state: 'empty', ageMs: null, clockWarning: null }`.
- `monoElapsed = monoNow − anchorMonoMs`; `wallElapsed = wallNow − anchorWallMs`; `ageMs = sourceAgeAtReceiptMs + monoElapsed`.
- `|wallElapsed − monoElapsed| > clockMismatchThresholdMs` → `state: 'unverified'`, `clockWarning: 'time-unverified'` (age still reported, but the UI shows absolute provider time and "Time could not be verified").
- Else if `futureSkew` → state is `delayed` or `stale` by age, never `fresh`; `clockWarning: 'future-skew'`.
- Else `ageMs <= freshMaxAgeMs` → `fresh`; `<= delayedMaxAgeMs` → `delayed`; else `stale`. Boundaries are inclusive: exactly 15 000 ms is fresh, exactly 60 000 ms is delayed.
- A backward wall-clock jump can never make data fresher, because age uses monotonic elapsed time.

## 5. Scheduler — `createPollingScheduler(deps): PollingScheduler` (`src/data/pollingMachine.ts`)

- One active request at most. A generation counter increments on every abort, pause, hide, offline and dispose. Results from an older generation are ignored (diagnostic `late-result-ignored`) and never change state.
- Healthy: next start = `max(lastStartMono + healthyIntervalMs, settlementMono)`.
- Failure (`timeout`, `network`, `http` 5xx/408, `body-*`, `invalid-*`, `unexpected-content-type`, `redirect`): `consecutiveFailures += 1`; `baseline = retryBaselinesMs[min(n−1, 3)]`; `delay = min(retryMaxMs, baseline × (1 + jitterFraction × r))`, measured from settlement. `transport = 'retry-wait'`. Keep the anchor.
- 429: `delay = max(ordinaryDelay, rateLimitMinWaitMs)` when there's no valid Retry-After. With seconds Retry-After: `deadline = max(ordinary, seconds × 1000)` (never capped). With date Retry-After: convert to a monotonic deadline once, using `serverDateMs` as "now" when readable, else the local wall clock. If `clockSuspect` and `serverDateMs === null`, pause automatic retry and set `retryBlockedBy: 'time-unverified'`. Deadlines survive pause, hide and offline.
- `blockingStatuses` and other 4xx (except 408 and 429): `transport = 'blocked'`, no automatic retry. Manual Retry is allowed, subject to spacing.
- Validated response (accept, duplicate, conflict or older): `consecutiveFailures = 0`, `lastFailure = null`, ordinary backoff cleared. Server deadlines from earlier 429s still apply if they are later.
- `too-far-future`: treated as an invalid payload failure, plus diagnostic `future-sample-rejected`.
- Hidden, offline hint, pause, dispose: abort the active request (not counted as a failure) and clear the pending wake. `pause` sticks across `setVisible` and `setOnlineHint`. Visible, online, resume: at most one request when eligible, otherwise wait for the deadline; never replay missed intervals.
- Offline hint: no automatic attempts. `retryNow()` may still probe when eligible (the hint can be wrong).
- `retryNow()`: starts a request only when nothing is in flight, ≥ `healthyIntervalMs` since the last start, and past every backoff and server deadline. Otherwise a no-op. `retryBlockedBy` explains why.
- Clock check on every wake and settlement: if wall and monotonic elapsed since the previous check differ by more than `clockMismatchThresholdMs`, set `clockSuspect = true`, add diagnostic `clock-jump-detected`, and make one request when eligible. `clockSuspect` clears on the next `accept`.
- Trail: on `accept`, append `{lat, lon, positionTimeMs}`; drop points older than `positionTimeMs − trailMaxAgeMs`; keep the last `trailMaxPoints`.
- `getSnapshot()` returns the same object until something changes (safe for `useSyncExternalStore`). `subscribe` listeners are called synchronously after each change. `dispose` makes later calls no-ops.

## 6. Trail segments — `toTrailSegments(trail)` (`src/domain/trail.ts`)

- Split between consecutive points when `|Δlon| > 180` (antimeridian) or `ΔpositionTime > trailGapSplitMs`.
- Segments with fewer than 2 points are dropped from drawing.
- Labelled in the UI as "Observed during this session." Never extended or predicted.

## 7. Map and UI

- `IssMap` creates exactly one `L.Map` and one marker per mounted container and survives the Strict Mode setup → cleanup → setup sequence. Positions are updated with `setLatLng`, never by recreating. No fetch, no polling timers.
- Follow: user drag, keyboard pan or zoom → `onUserMoved()`. Programmatic `panTo`/`setView` is flagged so it does not trigger it. Each new position while following → pan without changing zoom. `recenterToken` change → pan to the position (keep zoom) after the parent re-enables follow.
- Discrete marker moves. Across the antimeridian the marker jumps directly; no 358° animation. Bounded world: `worldCopyJump: false`, `maxBounds` on the world, `noWrap` tiles.
- `|lat| > 85.0511`: keep the text truthful and show a map warning; don't silently clamp the text.
- Attribution: a visible link with `tileAttributionText` to `tileAttributionHref`, plus a provider credit, at every width.
- Text panel = complete alternative: lat/lon to 2 decimals with N/S, E/W; UTC calculation time; age in words; provider; connection state; trail note.
- Controls: Pause/Resume, Retry (disabled with a visible reason and countdown), Recenter (re-enables follow), zoom in/out, and pan buttons (non-drag alternative). Accessible names, visible focus, ≥ 44 px target.
- Live region: polite, announces only state transitions (first position, delayed, stale, offline, recovered, blocked, paused). Never the ticking age or coordinate updates.
- Remote strings are never inserted as HTML. Leaflet tooltips and popups, if any, use DOM nodes with `textContent`.

## 8. Ownership

See `docs/phase0-plan.md` §5. Test locations: `tests/unit/domain/` and `tests/unit/data/` (data agent); `tests/unit/ui/` (UI agent); `tests/unit/tracker/` (coordinator); `tests/integration/`, `tests/e2e/`, `tests/fixtures/adversarial/` (QA).

## 9. Amendment G1-v2 (2026-10-11, from the early security review)

Constants live in `trackerPolicy` (moved at G2).

- **Server waits:** every server-requested deadline is `min(max(ordinary, server), serverWaitMaxMs = 1 h)`. `Retry-After` seconds must match `/^\d+$/` and be ≤ `retryAfterMaxSeconds` (86 400); anything else is null. An HTTP-date in the past means 0. Every timer delay is clamped to [0, `maxTimerDelayMs` = 2^31−1]. Every wake re-checks its deadline against the monotonic clock and re-arms if it fired early.
- **Wrong local clock:** `clockSuspectStreak` (3) consecutive `too-far-future` results → `clockSuspect = true`. `lastFailure` is `invalid-payload / timestamp-implausible` (a stand-in until a dedicated code exists). `olderReanchorStreak` (3) consecutive validated `older` samples, strictly increasing among themselves with the newest within `maxFutureSkewMs` of wall time → re-anchor to the newest and reset the trail.
- **Client:** Content-Type MIME essence must equal `application/json`. Non-ok bodies are cancelled unread. A null body on 200 → `invalid-json`. UTF-8 is decoded with `fatal: true`, and errors → `invalid-json`. The fetch uses `referrerPolicy: 'no-referrer'`.
- **Diagnostics:** `detail` comes from a closed set of short codes, never remote content.
- **UI:** Leaflet HTML sinks are banned (`bindPopup`, `bindTooltip`, `setContent`, `divIcon({html})`). Attribution is built only from `trackerPolicy` constants. No `setAttribute('style')`. When `clockSuspect` is set with no anchor or a future streak, show the "device clock looks wrong" copy. After a wall/monotonic jump with an anchor, show "Time could not be verified" (§4).
- **useTracker (G2):** an external store owns at most one scheduler. The scheduler is created in an effect and started on the next task, so Strict Mode makes one request. It wires `visibilitychange`, `online` and `offline`. A 1 s display tick recomputes freshness and is cleared on unmount. `App` takes an optional `environment` prop as a test seam only.
- **G1-v3 (D16):** `createAnchor` sets `futureSkew` only when `positionTimeMs > wallNow + futureSkewToleranceMs` (2000 ms). Within the tolerance, age clamps to 0 and the sample can be fresh.
