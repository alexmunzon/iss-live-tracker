// Self-test of the QA harness. Runs without production code, so the harness
// itself is known-good before it is used to judge the implementation.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { T0_MS } from '../fixtures/canonical/index';
import { invalidUtf8Body, payloadCases, responseCases } from '../fixtures/adversarial/payloads';
import {
  createFakeFetch,
  installVirtualTime,
  json,
  MONO_BASE,
  uninstallVirtualTime,
} from './harness';

afterEach(() => uninstallVirtualTime());

describe('QA harness', () => {
  it('drives wall and monotonic time from fake timers', async () => {
    const env = installVirtualTime();
    expect(env.clock.wallNowMs()).toBe(T0_MS);
    expect(env.clock.monotonicNowMs()).toBe(MONO_BASE);
    await env.advance(5_000);
    expect(env.clock.wallNowMs()).toBe(T0_MS + 5_000);
    expect(env.clock.monotonicNowMs()).toBe(MONO_BASE + 5_000);
    env.jumpWall(-60_000);
    expect(env.clock.wallNowMs()).toBe(T0_MS - 55_000);
    expect(env.clock.monotonicNowMs()).toBe(MONO_BASE + 5_000);
  });

  it('delivers delayed responses at the exact virtual time and honours abort', async () => {
    const env = installVirtualTime();
    const fake = createFakeFetch(env);
    fake.queue(json('{"a":1}', { delayMs: 3_700 }), { kind: 'hang' });
    let settledAt = -1;
    void fake.fetch('u', { signal: new AbortController().signal }).then(async (r) => {
      settledAt = env.t();
      expect(await r.json()).toEqual({ a: 1 });
    });
    await env.advance(3_699);
    expect(settledAt).toBe(-1);
    await env.advance(1);
    expect(settledAt).toBe(3_700);

    const controller = new AbortController();
    const hung = fake.fetch('u', { signal: controller.signal });
    expect(fake.activeCount()).toBe(1);
    controller.abort();
    await expect(hung).rejects.toBeDefined();
    expect(fake.activeCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adversarial payload texts parse the way the expectations claim', () => {
    for (const c of payloadCases) {
      const parse = () => JSON.parse(c.jsonText) as unknown;
      if ('failure' in c.expected) expect(parse, c.name).toThrow();
      else expect(parse, c.name).not.toThrow();
    }
    expect(
      (
        JSON.parse(payloadCases.find((c) => c.name.includes('1e999'))?.jsonText ?? '') as {
          latitude: number;
        }
      ).latitude,
    ).toBe(Infinity);
    expect(Object.prototype).not.toHaveProperty('qaPolluted');
  });

  it('size fixtures have the intended byte lengths and invalid UTF-8 is really invalid', () => {
    const byName = (n: string) => {
      const found = responseCases.find((c) => c.name === n);
      if (!found) throw new Error(`missing fixture ${n}`);
      return found;
    };
    const len = (b: string | Uint8Array | null) =>
      typeof b === 'string' ? new TextEncoder().encode(b).length : (b?.length ?? 0);
    expect(len(byName('exactly 64 KiB is accepted').body)).toBe(65_536);
    expect(len(byName('64 KiB + 1 byte is rejected').body)).toBe(65_537);
    expect(len(byName('70 KiB JSON without Content-Length (streamed)').body)).toBeGreaterThan(
      70 * 1024,
    );
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(invalidUtf8Body)).toThrow();
  });
});
