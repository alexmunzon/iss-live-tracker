// Ordering and freshness (docs/contracts.md §3, §4). Pure; time comes from the injected Clock.

import { trackerPolicy } from '../config/trackerPolicy';
import type {
  AcceptanceDecision,
  Clock,
  FreshnessAnchor,
  FreshnessView,
  PositionSample,
} from './position';

export function decideAcceptance(
  current: PositionSample | null,
  incoming: PositionSample,
  wallNowMs: number,
): AcceptanceDecision {
  if (incoming.positionTimeMs > wallNowMs + trackerPolicy.maxFutureSkewMs) return 'too-far-future';
  if (current === null) return 'accept';
  if (incoming.positionTimeMs > current.positionTimeMs) return 'accept';
  if (incoming.positionTimeMs === current.positionTimeMs) {
    return incoming.latitudeDeg === current.latitudeDeg &&
      incoming.longitudeDeg === current.longitudeDeg
      ? 'duplicate'
      : 'conflict';
  }
  return 'older';
}

export function createAnchor(sample: PositionSample, clock: Clock): FreshnessAnchor {
  const wallNow = clock.wallNowMs();
  const monoNow = clock.monotonicNowMs();
  return {
    sample,
    anchorWallMs: wallNow,
    anchorMonoMs: monoNow,
    sourceAgeAtReceiptMs: Math.max(0, wallNow - sample.positionTimeMs),
    futureSkew: sample.positionTimeMs > wallNow + trackerPolicy.futureSkewToleranceMs,
  };
}

const EMPTY_VIEW: FreshnessView = { state: 'empty', ageMs: null, clockWarning: null };

export function computeFreshness(anchor: FreshnessAnchor | null, clock: Clock): FreshnessView {
  if (anchor === null) return EMPTY_VIEW;
  const monoElapsed = clock.monotonicNowMs() - anchor.anchorMonoMs;
  const wallElapsed = clock.wallNowMs() - anchor.anchorWallMs;
  // Age only ever uses monotonic elapsed time, so a wall jump cannot make data fresher.
  const ageMs = anchor.sourceAgeAtReceiptMs + monoElapsed;

  if (Math.abs(wallElapsed - monoElapsed) > trackerPolicy.clockMismatchThresholdMs) {
    return { state: 'unverified', ageMs, clockWarning: 'time-unverified' };
  }
  if (anchor.futureSkew) {
    return {
      state: ageMs <= trackerPolicy.delayedMaxAgeMs ? 'delayed' : 'stale',
      ageMs,
      clockWarning: 'future-skew',
    };
  }
  if (ageMs <= trackerPolicy.freshMaxAgeMs) return { state: 'fresh', ageMs, clockWarning: null };
  if (ageMs <= trackerPolicy.delayedMaxAgeMs)
    return { state: 'delayed', ageMs, clockWarning: null };
  return { state: 'stale', ageMs, clockWarning: null };
}
