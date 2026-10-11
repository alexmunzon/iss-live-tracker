import { describe, expect, it } from 'vitest';
import { trackerPolicy } from '../../../src/config/trackerPolicy';
import { createIssClient, parseRetryAfter } from '../../../src/data/issClient';
import type { FetchLike, FetchOutcome } from '../../../src/domain/position';
import { observedCurl, observedCurlSample, rawPosition } from '../../fixtures/canonical';
import { FakeEnv, flushMicrotasks } from './fakes';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS, ...init });
}

interface Harness {
  env: FakeEnv;
  calls: { url: string; init: RequestInit }[];
  run: (signal?: AbortSignal) => Promise<FetchOutcome>;
}

function harness(respond: (init: RequestInit) => Promise<Response> | Response): Harness {
  const env = new FakeEnv();
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(respond(init));
  };
  const client = createIssClient({ fetch, clock: env.clock, timers: env.timers });
  return {
    env,
    calls,
    run: (signal = new AbortController().signal) => client.fetchPosition(signal),
  };
}

function streamOf(
  chunks: Uint8Array[],
  options: { hangAfter?: boolean; onCancel?: () => void; errorAfter?: boolean } = {},
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk !== undefined) {
        controller.enqueue(chunk);
        return;
      }
      if (options.errorAfter) {
        controller.error(new Error('reset'));
        return;
      }
      if (options.hangAfter) return new Promise<void>(() => undefined);
      controller.close();
      return;
    },
    cancel() {
      options.onCancel?.();
    },
  });
}

const never = (): Promise<Response> => new Promise<Response>(() => undefined);

describe('A02 client: request shape and success', () => {
  it('A02 sends exactly one GET to the fixed endpoint with safe options and parses the sample', async () => {
    const h = harness(() => jsonResponse(observedCurl));
    h.env.wall = observedCurlSample.receivedAtMs;
    const outcome = await h.run();
    expect(outcome).toEqual({ ok: true, sample: observedCurlSample, issues: [] });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe(trackerPolicy.endpointUrl);
    expect(h.calls[0]?.init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' },
    });
    expect(h.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(h.env.pendingCount).toBe(0);
  });

  it('A02 accepts content-type with parameters and upper case', async () => {
    const h = harness(() =>
      jsonResponse(observedCurl, {
        headers: { 'Content-Type': 'Application/JSON; charset=utf-8' },
      }),
    );
    expect((await h.run()).ok).toBe(true);
  });
});

describe('A02 client: hostile responses', () => {
  async function failureOf(respond: () => Promise<Response> | Response): Promise<unknown> {
    const h = harness(respond);
    const outcome = await h.run();
    expect(h.env.pendingCount).toBe(0);
    return outcome.ok ? null : outcome.failure;
  }

  it('A02 invalid JSON → invalid-json', async () => {
    expect(await failureOf(() => new Response('{"id":', { headers: JSON_HEADERS }))).toEqual({
      kind: 'invalid-json',
    });
  });

  it('A02 HTML body with text/html → unexpected-content-type', async () => {
    const html = new Response('<html><script>alert(1)</script></html>', {
      headers: { 'Content-Type': 'text/html' },
    });
    expect(await failureOf(() => html)).toEqual({ kind: 'unexpected-content-type' });
  });

  it.each(['application/jsonp', 'text/html;x=application/json', 'application/json-seq', ''])(
    'G1-v2 content type %j → unexpected-content-type',
    async (type) => {
      const res = new Response(JSON.stringify(observedCurl), { headers: { 'Content-Type': type } });
      expect(await failureOf(() => res)).toEqual({ kind: 'unexpected-content-type' });
    },
  );

  it('A02 wrong identity / array → invalid-payload', async () => {
    expect(await failureOf(() => jsonResponse(rawPosition({ id: 1 })))).toEqual({
      kind: 'invalid-payload',
      rejection: 'wrong-identity',
    });
    expect(await failureOf(() => jsonResponse([observedCurl]))).toEqual({
      kind: 'invalid-payload',
      rejection: 'not-an-object',
    });
  });

  it('A02 oversized body via Content-Length is rejected without reading', async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const res = new Response(body, {
      headers: { ...JSON_HEADERS, 'Content-Length': String(trackerPolicy.maxBodyBytes + 1) },
    });
    expect(await failureOf(() => res)).toEqual({ kind: 'body-too-large' });
    expect(pulled).toBe(false);
  });

  it('A02 oversized streamed body without Content-Length cancels the reader', async () => {
    let cancelled = false;
    let extraPulls = 0;
    const big = new Uint8Array(40 * 1024).fill(32);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        extraPulls += 1;
        controller.enqueue(big);
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(body, { headers: JSON_HEADERS });
    expect(res.headers.get('Content-Length')).toBeNull();
    expect(await failureOf(() => res)).toEqual({ kind: 'body-too-large' });
    await flushMicrotasks();
    expect(cancelled).toBe(true);
    expect(extraPulls).toBeLessThan(5);
  });

  it('A02 body of exactly maxBodyBytes is allowed through to parsing', async () => {
    const json = JSON.stringify(observedCurl);
    const padded = json + ' '.repeat(trackerPolicy.maxBodyBytes - json.length);
    const res = new Response(padded, { headers: JSON_HEADERS });
    const h = harness(() => res);
    expect((await h.run()).ok).toBe(true);
  });

  it('A02 stream error → body-read-failed', async () => {
    const res = new Response(streamOf([new TextEncoder().encode('{"a"')], { errorAfter: true }), {
      headers: JSON_HEADERS,
    });
    expect(await failureOf(() => res)).toEqual({ kind: 'body-read-failed' });
  });

  it('G1-v2 null body on a 200 → invalid-json', async () => {
    const res = new Response(null, { status: 200, headers: JSON_HEADERS });
    expect(res.body).toBeNull();
    expect(await failureOf(() => res)).toEqual({ kind: 'invalid-json' });
  });

  it('G1-v2 invalid UTF-8 → invalid-json', async () => {
    const bytes = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    const res = new Response(streamOf([bytes]), { headers: JSON_HEADERS });
    expect(await failureOf(() => res)).toEqual({ kind: 'invalid-json' });
  });

  it('A02 redirected response → redirect', async () => {
    const res = jsonResponse(observedCurl);
    Object.defineProperty(res, 'redirected', { value: true });
    expect(await failureOf(() => res)).toEqual({ kind: 'redirect' });
  });
});

describe('A07 client: timeouts, network and HTTP errors', () => {
  it('A07 timeout before headers (8 s), even if fetch ignores the signal', async () => {
    const h = harness(never);
    const pending = h.run();
    await h.env.advance(7_999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    await h.env.advance(1);
    expect(await pending).toEqual({ ok: false, failure: { kind: 'timeout' } });
    expect(h.calls[0]?.init.signal?.aborted).toBe(true);
    expect(h.env.pendingCount).toBe(0);
  });

  it('A07 timeout during the body read cancels the reader', async () => {
    let cancelled = false;
    const res = new Response(
      streamOf([new TextEncoder().encode('{"id":')], {
        hangAfter: true,
        onCancel: () => {
          cancelled = true;
        },
      }),
      { headers: JSON_HEADERS },
    );
    const h = harness(() => res);
    const pending = h.run();
    await h.env.advance(8_000);
    expect(await pending).toEqual({ ok: false, failure: { kind: 'timeout' } });
    await flushMicrotasks();
    expect(cancelled).toBe(true);
    expect(h.env.pendingCount).toBe(0);
  });

  it('A07 fetch rejection → network', async () => {
    const h = harness(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await h.run()).toEqual({ ok: false, failure: { kind: 'network' } });
    expect(h.env.pendingCount).toBe(0);
  });

  it('A07 caller abort → aborted (wins over timeout and network)', async () => {
    const h = harness(never);
    const controller = new AbortController();
    const pending = h.run(controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, failure: { kind: 'aborted' } });
    expect(h.env.pendingCount).toBe(0);
    const already = new AbortController();
    already.abort();
    expect(await h.run(already.signal)).toEqual({ ok: false, failure: { kind: 'aborted' } });
  });

  it.each([500, 503, 401, 403, 404, 408, 429])(
    'A07 HTTP %d → http failure, body cancelled unread',
    async (status) => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      const h = harness(() => new Response(body, { status, headers: { 'Retry-After': '120' } }));
      const outcome = await h.run();
      expect(outcome).toEqual({
        ok: false,
        failure: {
          kind: 'http',
          status,
          retryAfter: { kind: 'seconds', seconds: 120 },
          serverDateMs: null,
        },
      });
      await flushMicrotasks();
      expect(cancelled).toBe(true);
    },
  );

  it('A08 http failure carries Date header when readable', async () => {
    const h = harness(
      () =>
        new Response('', {
          status: 429,
          headers: {
            'Retry-After': 'Sun, 11 Oct 2026 14:05:00 GMT',
            Date: 'Sun, 11 Oct 2026 14:01:23 GMT',
          },
        }),
    );
    const outcome = await h.run();
    expect(outcome.ok ? null : outcome.failure).toEqual({
      kind: 'http',
      status: 429,
      retryAfter: { kind: 'date', epochMs: Date.UTC(2026, 9, 11, 14, 5, 0) },
      serverDateMs: Date.UTC(2026, 9, 11, 14, 1, 23),
    });
  });
});

describe('A08 parseRetryAfter', () => {
  it.each([
    ['0', 0],
    ['5', 5],
    ['120', 120],
    [' 120 ', 120],
    ['86400', 86_400],
  ])('A08 seconds form %j → %d', (value, seconds) => {
    expect(parseRetryAfter(value)).toEqual({ kind: 'seconds', seconds });
  });

  it('A08 IMF-fixdate, RFC 850 and asctime date forms', () => {
    const expected = { kind: 'date', epochMs: Date.UTC(1994, 10, 6, 8, 49, 37) };
    expect(parseRetryAfter('Sun, 06 Nov 1994 08:49:37 GMT')).toEqual(expected);
    expect(parseRetryAfter('Sunday, 06-Nov-94 08:49:37 GMT')).toEqual(expected);
    expect(parseRetryAfter('Sun Nov  6 08:49:37 1994')).toEqual(expected);
  });

  it.each([
    null,
    '',
    '   ',
    '1e9',
    '+5',
    '-1',
    '1.5',
    '86401',
    '99999999999',
    'soon',
    '2026-10-11T14:05:00Z',
    'Sun, 31 Feb 2026 08:49:37 GMT',
    'Sun, 06 Nov 1994 25:49:37 GMT',
    'Sun, 06 Nov 1994 08:49:37 PST',
  ])('A08/G1-v2 invalid Retry-After %j → null', (value) => {
    expect(parseRetryAfter(value)).toBeNull();
  });
});
