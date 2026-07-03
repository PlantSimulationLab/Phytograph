import { describe, it, expect } from 'vitest';
import {
  boundsCenterDiagonal,
  detectFrameMismatch,
  recenterShiftFor,
  FRAME_MISMATCH_ABS_THRESHOLD,
  FRAME_MISMATCH_K,
} from './frameMismatch';

describe('boundsCenterDiagonal', () => {
  it('computes the center and space-diagonal of a box', () => {
    const { center, diagonal } = boundsCenterDiagonal(
      { x: -1, y: -2, z: -2 },
      { x: 1, y: 2, z: 2 },
    );
    expect(center).toEqual({ x: 0, y: 0, z: 0 });
    // diagonal of a 2×4×4 box = sqrt(4+16+16) = 6
    expect(diagonal).toBeCloseTo(6, 6);
  });
});

describe('detectFrameMismatch', () => {
  it('reports no mismatch when the scene is empty (new entity is the anchor)', () => {
    const r = detectFrameMismatch({
      newAnchor: { x: 476638, y: 5428859, z: 955 },
      existing: null,
    });
    expect(r.mismatch).toBe(false);
  });

  it('trips on a UTM trajectory vs a small origin-based plane', () => {
    // A 25×25 m plane at the origin (diagonal ≈ 35 m).
    const existing = boundsCenterDiagonal(
      { x: -12.5, y: -12.5, z: 0 },
      { x: 12.5, y: 12.5, z: 0 },
    );
    const r = detectFrameMismatch({
      newAnchor: { x: 476638, y: 5428859, z: 955 },
      existing,
    });
    expect(r.mismatch).toBe(true);
    // The abs threshold dominates: K·diag (≈354) < abs (1e4) < distance (~5.4M).
    expect(FRAME_MISMATCH_K * existing.diagonal).toBeLessThan(FRAME_MISMATCH_ABS_THRESHOLD);
    expect(r.distance).toBeGreaterThan(FRAME_MISMATCH_ABS_THRESHOLD);
  });

  it('does NOT trip for a scan legitimately offset within one plot', () => {
    // A 200 m plot (diagonal ≈ 283 m), add a scan 150 m from its center.
    const existing = boundsCenterDiagonal(
      { x: -100, y: -100, z: 0 },
      { x: 100, y: 100, z: 0 },
    );
    const r = detectFrameMismatch({
      newAnchor: { x: 150, y: 0, z: 0 },
      existing,
    });
    // 150 m < max(1e4, 10·283=2828) → no mismatch.
    expect(r.mismatch).toBe(false);
  });

  it('uses the relative K·diagonal bound for a large scene past the abs threshold', () => {
    // A huge scene: diagonal 5000 m → K·diag = 50000 > abs (1e4).
    const existing = { center: { x: 0, y: 0, z: 0 }, diagonal: 5000 };
    // 30 km away → mismatch (30000 < 50000? no → not a mismatch by the relative bound).
    expect(
      detectFrameMismatch({ newAnchor: { x: 30000, y: 0, z: 0 }, existing }).mismatch,
    ).toBe(false);
    // 60 km away → past K·diag=50000 → mismatch.
    expect(
      detectFrameMismatch({ newAnchor: { x: 60000, y: 0, z: 0 }, existing }).mismatch,
    ).toBe(true);
  });

  it('is strict (>) at exactly the limit', () => {
    const existing = { center: { x: 0, y: 0, z: 0 }, diagonal: 0 };
    // limit = max(1e4, 0) = 1e4; distance exactly 1e4 → NOT a mismatch.
    expect(
      detectFrameMismatch({ newAnchor: { x: 1e4, y: 0, z: 0 }, existing }).mismatch,
    ).toBe(false);
    // just past it → mismatch.
    expect(
      detectFrameMismatch({ newAnchor: { x: 1e4 + 1, y: 0, z: 0 }, existing }).mismatch,
    ).toBe(true);
  });

  it('honors custom thresholds', () => {
    const existing = { center: { x: 0, y: 0, z: 0 }, diagonal: 10 };
    const r = detectFrameMismatch({
      newAnchor: { x: 100, y: 0, z: 0 },
      existing,
      absThreshold: 50,
      k: 2,
    });
    // limit = max(50, 20) = 50; distance 100 > 50 → mismatch.
    expect(r.mismatch).toBe(true);
  });
});

describe('recenterShiftFor', () => {
  it('returns newAnchor - existingCenter', () => {
    expect(
      recenterShiftFor({ x: 476638, y: 5428859, z: 955 }, { x: 0, y: 0, z: 0 }),
    ).toEqual([476638, 5428859, 955]);
  });

  it('round-trips: subtracting the shift lands the anchor on the center', () => {
    const anchor = { x: 476638.59, y: 5428859.08, z: 954.99 };
    const center = { x: 3, y: -2, z: 1 };
    const [dx, dy, dz] = recenterShiftFor(anchor, center);
    expect(anchor.x - dx).toBeCloseTo(center.x, 6);
    expect(anchor.y - dy).toBeCloseTo(center.y, 6);
    expect(anchor.z - dz).toBeCloseTo(center.z, 6);
  });
});
