// One provider request: fixed URL, combined abort/timeout, bounded body read, strict validation
// (docs/contracts.md §2). Never throws, never logs payloads, no React, no DOM.

import { trackerPolicy } from '../config/trackerPolicy';
import type {
  FetchFailure,
  FetchOutcome,
  IssClient,
  IssClientDeps,
  RetryAfter,
} from '../domain/position';
import { validatePosition } from '../domain/validatePosition';

/** G1-v2: largest accepted seconds-form Retry-After (1 day). */
export const RETRY_AFTER_MAX_SECONDS = 86_400; // G2: move to trackerPolicy

// ---------------------------------------------------------------------------
// HTTP-date parsing (RFC 9110 §5.6.7). Strict on purpose: Date.parse accepts far too much
// (e.g. "2" parses as a year), which would let a garbage header set a deadline.
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const LONG_DAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTH = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const TIME = '(\\d{2}):(\\d{2}):(\\d{2})';

/** IMF-fixdate: Sun, 06 Nov 1994 08:49:37 GMT */
const IMF_FIXDATE = new RegExp(`^${DAY}, (\\d{2}) ${MONTH} (\\d{4}) ${TIME} GMT$`);
/** Obsolete RFC 850: Sunday, 06-Nov-94 08:49:37 GMT */
const RFC_850 = new RegExp(`^${LONG_DAY}, (\\d{2})-${MONTH}-(\\d{2}) ${TIME} GMT$`);
/** Obsolete asctime: Sun Nov  6 08:49:37 1994 */
const ASCTIME = new RegExp(`^${DAY} ${MONTH} ([ \\d]\\d) ${TIME} (\\d{4})$`);

function utcMs(
  year: number,
  monthName: string,
  day: number,
  h: number,
  m: number,
  s: number,
): number | null {
  const month = MONTHS.indexOf(monthName);
  if (month < 0 || h > 23 || m > 59 || s > 60) return null;
  const ms = Date.UTC(year, month, day, h, m, Math.min(s, 59));
  const check = new Date(ms);
  // Reject impossible calendar dates such as 31 Feb instead of rolling them over.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month) return null;
  if (check.getUTCDate() !== day) return null;
  return ms;
}

export function parseHttpDate(value: string | null): number | null {
  if (value === null) return null;
  const text = value.trim();
  let match = IMF_FIXDATE.exec(text);
  if (match) {
    const [, d, mon, y, h, mi, s] = match;
    return utcMs(Number(y), mon ?? '', Number(d), Number(h), Number(mi), Number(s));
  }
  match = RFC_850.exec(text);
  if (match) {
    const [, d, mon, yy, h, mi, s] = match;
    // RFC 9110: a two-digit year more than 50 years in the future is in the past century.
    // Without a trusted clock here, pivot at 70 (1970–2069), as most HTTP stacks do.
    const two = Number(yy);
    const year = two >= 70 ? 1900 + two : 2000 + two;
    return utcMs(year, mon ?? '', Number(d), Number(h), Number(mi), Number(s));
  }
  match = ASCTIME.exec(text);
  if (match) {
    const [, mon, d, h, mi, s, y] = match;
    return utcMs(Number(y), mon ?? '', Number((d ?? '').trim()), Number(h), Number(mi), Number(s));
  }
  return null;
}

/**
 * Seconds form: digits only, 0..RETRY_AFTER_MAX_SECONDS. Date form: HTTP-date → epoch ms.
 * Anything else (1e9, +5, -1, 1.5, empty, > 1 day): null.
 */
export function parseRetryAfter(value: string | null): RetryAfter | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return seconds <= RETRY_AFTER_MAX_SECONDS ? { kind: 'seconds', seconds } : null;
  }
  const epochMs = parseHttpDate(text);
  return epochMs === null ? null : { kind: 'date', epochMs };
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const essence = (value.split(';')[0] ?? '').trim().toLowerCase();
  return essence === 'application/json';
}

/** Parsed Content-Length, or null when absent or not a plain non-negative integer. */
function contentLength(value: string | null): number | null {
  if (value === null) return null;
  const text = value.trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const ABORTED = Symbol('aborted');
type Aborted = typeof ABORTED;

type BodyResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'too-large' | 'read-failed' | 'aborted' };

function fail(failure: FetchFailure): FetchOutcome {
  return { ok: false, failure };
}

export function createIssClient(deps: IssClientDeps): IssClient {
  const { fetch, clock, timers } = deps;

  async function fetchPosition(signal: AbortSignal): Promise<FetchOutcome> {
    if (signal.aborted) return fail({ kind: 'aborted' });

    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = (): void => controller.abort();
    signal.addEventListener('abort', onCallerAbort, { once: true });
    const timeoutHandle = timers.set(() => {
      timedOut = true;
      controller.abort();
    }, trackerPolicy.requestTimeoutMs);

    // Resolves when either the caller or the timeout aborts, even if a fetch or stream
    // implementation ignores the signal. Guarantees we settle within the timeout.
    const abortedPromise = new Promise<Aborted>((resolve) => {
      if (controller.signal.aborted) resolve(ABORTED);
      else controller.signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
    });

    /** Classification order: caller aborted, then timeout, then the given failure. */
    const classify = (otherwise: FetchFailure): FetchOutcome => {
      if (signal.aborted) return fail({ kind: 'aborted' });
      if (timedOut) return fail({ kind: 'timeout' });
      return fail(otherwise);
    };

    try {
      let response: Response | Aborted;
      try {
        response = await Promise.race([
          fetch(trackerPolicy.endpointUrl, {
            method: 'GET',
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            // G1-v2: the API does not need our origin; only OSM tiles need a Referer.
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          }),
          abortedPromise,
        ]);
      } catch {
        // Includes redirect: 'error' rejections, which look identical to network errors.
        return classify({ kind: 'network' });
      }
      if (response === ABORTED) return classify({ kind: 'network' });

      if (response.redirected || response.type === 'opaqueredirect') {
        discardBody(response);
        return classify({ kind: 'redirect' });
      }

      if (!response.ok) {
        const failure: FetchFailure = {
          kind: 'http',
          status: response.status,
          retryAfter: parseRetryAfter(response.headers.get('Retry-After')),
          serverDateMs: parseHttpDate(response.headers.get('Date')),
        };
        discardBody(response);
        return classify(failure);
      }

      if (!isJsonContentType(response.headers.get('Content-Type'))) {
        discardBody(response);
        return classify({ kind: 'unexpected-content-type' });
      }

      const declared = contentLength(response.headers.get('Content-Length'));
      if (declared !== null && declared > trackerPolicy.maxBodyBytes) {
        discardBody(response);
        return classify({ kind: 'body-too-large' });
      }

      // G1-v2: a 200 without a body stream has nothing to parse.
      if (response.body === null) return classify({ kind: 'invalid-json' });
      const body = await readBounded(response.body, abortedPromise);
      if (!body.ok) {
        if (body.reason === 'too-large') return classify({ kind: 'body-too-large' });
        return classify({ kind: 'body-read-failed' });
      }
      const receivedAtMs = clock.wallNowMs();

      let parsed: unknown;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body.bytes);
        parsed = JSON.parse(text);
      } catch {
        return classify({ kind: 'invalid-json' });
      }

      const result = validatePosition(parsed, receivedAtMs);
      if (!result.ok) return classify({ kind: 'invalid-payload', rejection: result.rejection });
      if (signal.aborted) return fail({ kind: 'aborted' });
      return { ok: true, sample: result.sample, issues: result.issues };
    } catch {
      // Defensive: nothing above should throw, but this function must never reject.
      return classify({ kind: 'body-read-failed' });
    } finally {
      timers.clear(timeoutHandle);
      signal.removeEventListener('abort', onCallerAbort);
    }
  }

  return { fetchPosition };
}

function discardBody(response: Response): void {
  try {
    response.body?.cancel().catch(() => undefined);
  } catch {
    // Body already locked or unavailable; nothing to release.
  }
}

async function readBounded(
  body: ReadableStream<Uint8Array>,
  aborted: Promise<Aborted>,
): Promise<BodyResult> {
  const limit = trackerPolicy.maxBodyBytes;

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
  const cancel = (): void => {
    reader.cancel().catch(() => undefined);
  };

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await Promise.race([reader.read(), aborted]);
      if (step === ABORTED) {
        cancel();
        return { ok: false, reason: 'aborted' };
      }
      if (step.done) break;
      const value: unknown = step.value;
      if (!ArrayBuffer.isView(value)) {
        cancel();
        return { ok: false, reason: 'read-failed' };
      }
      const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      total += chunk.byteLength;
      if (total > limit) {
        cancel();
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(chunk);
    }
  } catch {
    cancel();
    return { ok: false, reason: 'read-failed' };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
