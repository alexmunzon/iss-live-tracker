import { describe, expect, it } from 'vitest';
import type { PositionSample, TrailState } from '../../../src/domain/position';
import { appendTrail, EMPTY_TRAIL, toTrailSegments } from '../../../src/domain/trail';
import { datelineEastward, datelineWestward, sample, T0_MS } from '../../fixtures/canonical';

function build(samples: readonly PositionSample[]): TrailState {
  return samples.reduce<TrailState>((trail, s) => appendTrail(trail, s), EMPTY_TRAIL);
}

function every5s(count: number, start = T0_MS): PositionSample[] {
  return Array.from({ length: count }, (_, i) =>
    sample({
      latitudeDeg: (i % 100) / 10,
      longitudeDeg: (i % 300) / 10,
      positionTimeMs: start + i * 5_000,
    }),
  );
}

describe('A18 trail', () => {
  it('A18 keeps at most 120 points', () => {
    const trail = build(every5s(119)); // 590 s span, under 10 min
    expect(trail.points).toHaveLength(119);
    const longer = build(
      every5s(121, T0_MS).map((s, i) => ({ ...s, positionTimeMs: T0_MS + i * 1000 })),
    );
    expect(longer.points).toHaveLength(120);
    expect(longer.points[0]?.positionTimeMs).toBe(T0_MS + 1000);
  });

  it('A18 spans at most 10 minutes of position time', () => {
    const trail = build(every5s(200));
    const first = trail.points[0]?.positionTimeMs ?? 0;
    const last = trail.points[trail.points.length - 1]?.positionTimeMs ?? 0;
    expect(last - first).toBeLessThanOrEqual(600_000);
    expect(trail.points.length).toBeLessThanOrEqual(120);
  });

  it('A18 drops points older than 10 minutes even below the point limit', () => {
    const trail = build([
      sample({ positionTimeMs: T0_MS }),
      sample({ positionTimeMs: T0_MS + 600_000 }),
      sample({ positionTimeMs: T0_MS + 600_001 }),
    ]);
    expect(trail.points.map((p) => p.positionTimeMs)).toEqual([T0_MS + 600_000, T0_MS + 600_001]);
  });

  it('A18 does not append duplicates or older samples', () => {
    const one = appendTrail(EMPTY_TRAIL, sample({ positionTimeMs: T0_MS }));
    expect(appendTrail(one, sample({ positionTimeMs: T0_MS }))).toBe(one);
    expect(appendTrail(one, sample({ positionTimeMs: T0_MS - 1 }))).toBe(one);
    expect(one.points).toHaveLength(1);
  });

  it.each([
    ['eastward', datelineEastward],
    ['westward', datelineWestward],
  ])('A18 splits at the antimeridian %s', (_label, crossing) => {
    const segments = toTrailSegments(build(crossing));
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual([
      [crossing[0]?.latitudeDeg, crossing[0]?.longitudeDeg],
      [crossing[1]?.latitudeDeg, crossing[1]?.longitudeDeg],
    ]);
    for (const segment of segments) {
      for (let i = 1; i < segment.length; i += 1) {
        expect(Math.abs((segment[i]?.[1] ?? 0) - (segment[i - 1]?.[1] ?? 0))).toBeLessThanOrEqual(
          180,
        );
      }
    }
  });

  it('A18 splits on a gap above 30 s, not at exactly 30 s', () => {
    const trail = build([
      sample({ longitudeDeg: 0, positionTimeMs: T0_MS }),
      sample({ longitudeDeg: 1, positionTimeMs: T0_MS + 30_000 }),
      sample({ longitudeDeg: 2, positionTimeMs: T0_MS + 60_001 }),
      sample({ longitudeDeg: 3, positionTimeMs: T0_MS + 65_001 }),
    ]);
    const segments = toTrailSegments(trail);
    expect(segments.map((s) => s.map((p) => p[1]))).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('A18 drops single-point segments', () => {
    const trail = build([
      sample({ longitudeDeg: 10, positionTimeMs: T0_MS }),
      sample({ longitudeDeg: 11, positionTimeMs: T0_MS + 60_000 }),
      sample({ longitudeDeg: 12, positionTimeMs: T0_MS + 65_000 }),
      sample({ longitudeDeg: -170, positionTimeMs: T0_MS + 70_000 }),
    ]);
    expect(toTrailSegments(trail).map((s) => s.map((p) => p[1]))).toEqual([[11, 12]]);
    expect(toTrailSegments(EMPTY_TRAIL)).toEqual([]);
    expect(toTrailSegments(appendTrail(EMPTY_TRAIL, sample()))).toEqual([]);
  });

  it('A18 segments are [lat, lon] Leaflet order', () => {
    const trail = build([
      sample({ latitudeDeg: 51, longitudeDeg: -1, positionTimeMs: T0_MS }),
      sample({ latitudeDeg: 52, longitudeDeg: -2, positionTimeMs: T0_MS + 5_000 }),
    ]);
    expect(toTrailSegments(trail)).toEqual([
      [
        [51, -1],
        [52, -2],
      ],
    ]);
  });
});
