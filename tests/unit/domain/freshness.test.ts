import { describe, expect, it } from 'vitest';
import { computeFreshness, createAnchor, decideAcceptance } from '../../../src/domain/freshness';
import { sample, T0_MS } from '../../fixtures/canonical';
import { FakeEnv } from '../data/fakes';

describe('A03 decideAcceptance: future skew', () => {
  it('A03 accepts a sample up to 30 s in the future', () => {
    expect(decideAcceptance(null, sample({ positionTimeMs: T0_MS + 30_000 }), T0_MS)).toBe(
      'accept',
    );
  });

  it('A03 rejects a sample beyond 30 s in the future as too-far-future', () => {
    expect(decideAcceptance(null, sample({ positionTimeMs: T0_MS + 30_001 }), T0_MS)).toBe(
      'too-far-future',
    );
  });

  it('A03 future-within-skew sample is anchored with futureSkew', () => {
    const env = new FakeEnv();
    const anchor = createAnchor(sample({ positionTimeMs: env.wall + 10_000 }), env.clock);
    expect(anchor.futureSkew).toBe(true);
    expect(anchor.sourceAgeAtReceiptMs).toBe(0);
  });
});

describe('A04 decideAcceptance: ordering', () => {
  const current = sample({ positionTimeMs: T0_MS });

  it('A04 accepts newer', () => {
    expect(decideAcceptance(current, sample({ positionTimeMs: T0_MS + 1000 }), T0_MS + 1000)).toBe(
      'accept',
    );
  });

  it('A04 duplicate: same time, same coordinates', () => {
    expect(decideAcceptance(current, sample({ positionTimeMs: T0_MS }), T0_MS)).toBe('duplicate');
  });

  it('A04 conflict: same time, different coordinates', () => {
    expect(
      decideAcceptance(current, sample({ positionTimeMs: T0_MS, latitudeDeg: 1 }), T0_MS),
    ).toBe('conflict');
  });

  it('A04 older is ignored', () => {
    expect(decideAcceptance(current, sample({ positionTimeMs: T0_MS - 1000 }), T0_MS)).toBe(
      'older',
    );
  });

  it('A04 too-far-future wins over ordering', () => {
    expect(decideAcceptance(current, sample({ positionTimeMs: T0_MS + 60_000 }), T0_MS)).toBe(
      'too-far-future',
    );
  });
});

describe('A05 computeFreshness', () => {
  function anchoredAt(ageAtReceiptMs: number): {
    env: FakeEnv;
    anchor: ReturnType<typeof createAnchor>;
  } {
    const env = new FakeEnv();
    const anchor = createAnchor(sample({ positionTimeMs: env.wall - ageAtReceiptMs }), env.clock);
    return { env, anchor };
  }

  it('A05 empty without an anchor', () => {
    expect(computeFreshness(null, new FakeEnv().clock)).toEqual({
      state: 'empty',
      ageMs: null,
      clockWarning: null,
    });
  });

  it.each([
    [15_000, 'fresh'],
    [15_001, 'delayed'],
    [60_000, 'delayed'],
    [60_001, 'stale'],
  ])('A05 boundary: age %d ms → %s', async (age, state) => {
    const { env, anchor } = anchoredAt(0);
    await env.advance(age);
    expect(computeFreshness(anchor, env.clock)).toEqual({ state, ageMs: age, clockWarning: null });
  });

  it('A05 stale at first receipt when the source is already old', () => {
    const { env, anchor } = anchoredAt(120_000);
    expect(computeFreshness(anchor, env.clock).state).toBe('stale');
  });

  it('A05 age keeps advancing with monotonic time (failures, pause do not stop it)', async () => {
    const { env, anchor } = anchoredAt(2_000);
    await env.advance(30_000);
    expect(computeFreshness(anchor, env.clock).ageMs).toBe(32_000);
    await env.advance(60_000);
    expect(computeFreshness(anchor, env.clock)).toMatchObject({ ageMs: 92_000, state: 'stale' });
  });

  it('A05 future-skewed sample is never fresh', async () => {
    const env = new FakeEnv();
    const anchor = createAnchor(sample({ positionTimeMs: env.wall + 5_000 }), env.clock);
    expect(computeFreshness(anchor, env.clock)).toEqual({
      state: 'delayed',
      ageMs: 0,
      clockWarning: 'future-skew',
    });
    await env.advance(60_001);
    expect(computeFreshness(anchor, env.clock).state).toBe('stale');
  });

  it.each([5_001, -5_001])('A05 wall jump of %d ms → unverified', (jump) => {
    const { env, anchor } = anchoredAt(0);
    env.jumpWall(jump);
    expect(computeFreshness(anchor, env.clock)).toEqual({
      state: 'unverified',
      ageMs: 0,
      clockWarning: 'time-unverified',
    });
  });

  it('A05 wall jump of exactly 5000 ms is still verified', () => {
    const { env, anchor } = anchoredAt(0);
    env.jumpWall(5_000);
    expect(computeFreshness(anchor, env.clock).state).toBe('fresh');
  });

  it('A05 backward wall jump never makes data fresher', async () => {
    const { env, anchor } = anchoredAt(10_000);
    await env.advance(20_000);
    const before = computeFreshness(anchor, env.clock).ageMs ?? 0;
    env.jumpWall(-3_600_000);
    const after = computeFreshness(anchor, env.clock);
    expect(after.ageMs ?? 0).toBeGreaterThanOrEqual(before);
    expect(after.state).not.toBe('fresh');
  });
});

describe('A05 future-skew tolerance (D16, live finding 2026-10-11)', () => {
  it('a sample 1 s ahead (1-second timestamp resolution) is fresh with no clock warning', () => {
    const env = new FakeEnv();
    const anchor = createAnchor(sample({ positionTimeMs: env.wall + 1_000 }), env.clock);
    expect(anchor.futureSkew).toBe(false);
    expect(anchor.sourceAgeAtReceiptMs).toBe(0);
    expect(computeFreshness(anchor, env.clock)).toEqual({
      state: 'fresh',
      ageMs: 0,
      clockWarning: null,
    });
  });

  it('exactly 2000 ms ahead is still on time; 2001 ms ahead is future-skewed and never fresh', () => {
    const env = new FakeEnv();
    expect(createAnchor(sample({ positionTimeMs: env.wall + 2_000 }), env.clock).futureSkew).toBe(
      false,
    );
    const skewed = createAnchor(sample({ positionTimeMs: env.wall + 2_001 }), env.clock);
    expect(skewed.futureSkew).toBe(true);
    expect(computeFreshness(skewed, env.clock).state).toBe('delayed');
    expect(computeFreshness(skewed, env.clock).clockWarning).toBe('future-skew');
  });
});
