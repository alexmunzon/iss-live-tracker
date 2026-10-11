// Observed session trail (docs/contracts.md §5 "Trail", §6). Pure. Never predicts or extends.

import { trackerPolicy } from '../config/trackerPolicy';
import type { LatLngTuple, PositionSample, TrailPoint, TrailSegment, TrailState } from './position';

export const EMPTY_TRAIL: TrailState = Object.freeze({ points: Object.freeze([]) });

export function appendTrail(trail: TrailState, sample: PositionSample): TrailState {
  const last = trail.points[trail.points.length - 1];
  // Duplicates and older samples are never appended (callers should only append on 'accept').
  if (last !== undefined && sample.positionTimeMs <= last.positionTimeMs) return trail;

  const point: TrailPoint = {
    latDeg: sample.latitudeDeg,
    lonDeg: sample.longitudeDeg,
    positionTimeMs: sample.positionTimeMs,
  };
  const cutoff = sample.positionTimeMs - trackerPolicy.trailMaxAgeMs;
  const kept = [...trail.points, point].filter((p) => p.positionTimeMs >= cutoff);
  return { points: kept.slice(-trackerPolicy.trailMaxPoints) };
}

export function toTrailSegments(trail: TrailState): TrailSegment[] {
  const segments: TrailSegment[] = [];
  let current: LatLngTuple[] = [];
  let previous: TrailPoint | undefined;

  for (const point of trail.points) {
    if (
      previous !== undefined &&
      (Math.abs(point.lonDeg - previous.lonDeg) > 180 ||
        point.positionTimeMs - previous.positionTimeMs > trackerPolicy.trailGapSplitMs)
    ) {
      if (current.length >= 2) segments.push(current);
      current = [];
    }
    current.push([point.latDeg, point.lonDeg]);
    previous = point;
  }
  if (current.length >= 2) segments.push(current);
  return segments;
}
