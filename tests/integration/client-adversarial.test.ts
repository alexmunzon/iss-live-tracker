// Integration: issClient + validatePosition against adversarial transport data.
// Contract G1-v2. Expected values are literal (docs/contracts.md §1, §2 + G1-v2),
// never computed by calling production code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIssClient } from '../../src/data/issClient';
import type { FetchOutcome, IssClient } from '../../src/domain/position';
import { T0_MS } from '../fixtures/canonical/index';
import { payloadCases, responseCases, validJsonText } from '../fixtures/adversarial/payloads';
import {
  createFakeFetch,
  fromCase,
  installVirtualTime,
  json,
  uninstallVirtualTime,
  type FakeFetch,
  type VirtualEnv,
} from './harness';

const ENDPOINT = 'https://api.wheretheiss.at/v1/satellites/25544';

let env: VirtualEnv;
let fake: FakeFetch;
let client: IssClient;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeEach(() => {
  env = installVirtualTime();
  fake = createFakeFetch(env);
  client = createIssClient({ fetch: fake.fetch, clock: env.clock, timers: env.timers });
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  // Never logs payloads (§2): no console call may contain payload content.
  for (const spy of consoleSpies) {
    for (const args of spy.mock.calls) {
      const text = args.map((a: unknown) => String(a)).join(' ');
      expect(text).not.toMatch(/45\.0057|wheretheiss|onerror|<img/);
    }
  }
  uninstallVirtualTime();
});

async function run(signal: AbortSignal = new AbortController().signal): Promise<FetchOutcome> {
  const promise = client.fetchPosition(signal);
  await env.flush();
  return promise;
}

describe('A03 request shape (G1-v2)', () => {
  it('uses only the fixed endpoint with the hardened RequestInit', async () => {
    fake.queue(json(validJsonText));
    await run();
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe(ENDPOINT);
    expect(call?.init.method).toBe('GET');
    expect(call?.init.credentials).toBe('omit');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.cache).toBe('no-store');
    expect(call?.init.referrerPolicy).toBe('no-referrer');
    expect(new Headers(call?.init.headers).get('accept')).toBe('application/json');
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(call?.init.body ?? null).toBeNull();
  });
});

describe('A02 payload validation through the client', () => {
  for (const c of payloadCases) {
    it(c.name, async () => {
      fake.queue(json(c.jsonText));
      const outcome = await run();
      const e = c.expected;
      if ('failure' in e) {
        expect(outcome).toEqual({ ok: false, failure: { kind: e.failure } });
      } else if (!e.ok) {
        expect(outcome).toEqual({
          ok: false,
          failure: { kind: 'invalid-payload', rejection: e.rejection },
        });
      } else {
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const s = outcome.sample;
        expect(s.provider).toBe('where-the-iss-at');
        expect(s.satelliteId).toBe(25544);
        expect(s.latitudeDeg).toBe(e.latitudeDeg);
        expect(s.longitudeDeg).toBe(e.longitudeDeg);
        expect(s.positionTimeMs).toBe(e.positionTimeMs);
        expect(s.receivedAtMs).toBe(T0_MS);
        if (e.altitudeKm === undefined) expect('altitudeKm' in s).toBe(false);
        else expect(s.altitudeKm).toBe(e.altitudeKm);
        if (e.velocityKmh === undefined) expect('velocityKmh' in s).toBe(false);
        else expect(s.velocityKmh).toBe(e.velocityKmh);
        expect([...outcome.issues].sort()).toEqual([...e.issues].sort());
        // Remote strings must never be copied into the normalized sample.
        expect(JSON.stringify(s)).not.toMatch(/onerror|<script|<svg|qaPolluted/);
      }
      expect(Object.prototype).not.toHaveProperty('qaPolluted');
    });
  }
});

describe('A03 transport classification', () => {
  for (const c of responseCases) {
    it(c.name, async () => {
      fake.queue(fromCase(c));
      const outcome = await run();
      if (c.expected.ok) {
        expect(outcome.ok).toBe(true);
      } else {
        expect(outcome).toEqual({ ok: false, failure: c.expected.failure });
      }
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it('opaqueredirect response type is a redirect', async () => {
    fake.queue(json(validJsonText, { opaqueRedirect: true }));
    expect(await run()).toEqual({ ok: false, failure: { kind: 'redirect' } });
  });

  it('fetch rejection (also what redirect:error produces) is network', async () => {
    fake.queue({ kind: 'network' });
    expect(await run()).toEqual({ ok: false, failure: { kind: 'network' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a fetch that throws synchronously still resolves (never throws)', async () => {
    const throwing = createIssClient({
      fetch: () => {
        throw new TypeError('sync boom');
      },
      clock: env.clock,
      timers: env.timers,
    });
    const outcome = await throwing.fetchPosition(new AbortController().signal);
    expect(outcome.ok).toBe(false);
  });

  it('times out at exactly 8 000 ms before headers and clears the timer', async () => {
    fake.queue({ kind: 'hang' });
    let outcome: FetchOutcome | undefined;
    void client.fetchPosition(new AbortController().signal).then((o) => (outcome = o));
    await env.advance(7_999);
    expect(outcome).toBeUndefined();
    await env.advance(1);
    expect(outcome).toEqual({ ok: false, failure: { kind: 'timeout' } });
    expect(fake.calls[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('timeout stays armed through a stalled body read', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(validJsonText.slice(0, 50)));
        // never closes
      },
    });
    const throughFetch = createIssClient({
      fetch: () =>
        Promise.resolve(
          new Response(stalled, { status: 200, headers: { 'Content-Type': 'application/json' } }),
        ),
      clock: env.clock,
      timers: env.timers,
    });
    let outcome: FetchOutcome | undefined;
    void throughFetch
      .fetchPosition(new AbortController().signal)
      .then((o: FetchOutcome) => (outcome = o));
    await env.advance(7_999);
    expect(outcome).toBeUndefined();
    await env.advance(1);
    expect(outcome).toEqual({ ok: false, failure: { kind: 'timeout' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stream error during body read is body-read-failed', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"name":'));
        controller.error(new Error('connection reset'));
      },
    });
    const c = createIssClient({
      fetch: () =>
        Promise.resolve(new Response(broken, { headers: { 'Content-Type': 'application/json' } })),
      clock: env.clock,
      timers: env.timers,
    });
    expect(await c.fetchPosition(new AbortController().signal)).toEqual({
      ok: false,
      failure: { kind: 'body-read-failed' },
    });
  });

  it('caller abort is aborted, not timeout or network', async () => {
    fake.queue({ kind: 'hang' });
    const controller = new AbortController();
    const promise = client.fetchPosition(controller.signal);
    await env.advance(1_000);
    controller.abort();
    await env.flush();
    expect(await promise).toEqual({ ok: false, failure: { kind: 'aborted' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an already-aborted signal yields aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    fake.queue(json(validJsonText));
    expect(await run(controller.signal)).toEqual({ ok: false, failure: { kind: 'aborted' } });
  });

  it('receivedAtMs is the wall clock when the body completes (slow 3.7 s response)', async () => {
    fake.queue(json(validJsonText, { delayMs: 3_700 }));
    const promise = client.fetchPosition(new AbortController().signal);
    await env.advance(3_700);
    const outcome = await promise;
    expect(outcome.ok && outcome.sample.receivedAtMs).toBe(T0_MS + 3_700);
    expect(vi.getTimerCount()).toBe(0);
  });
});
