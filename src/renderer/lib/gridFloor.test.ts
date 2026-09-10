import { describe, it, expect } from 'vitest';
import { computeGridFloor } from './gridFloor';

describe('computeGridFloor', () => {
  it('snaps a scene authored at the origin to exactly 0', () => {
    // A synthetic plant standing on zero with a little noise below it.
    expect(computeGridFloor(-0.004, 2.5)).toBe(0);
    expect(computeGridFloor(0, 2.5)).toBe(0);
  });

  it('snaps a tiny scene whose floor is a hair below zero', () => {
    // 20 cm seedling, floor at -1 mm: the absolute tolerance carries it.
    expect(computeGridFloor(-0.001, 0.2)).toBe(0);
  });

  it('keeps the real ground for a georeferenced survey that straddles zero', () => {
    // The regression: a MiniVUX poplar survey in UTM/ellipsoidal height. Ground
    // -13.75 m, canopy top -3.61 m, sparse noise to +18.38. The span straddles
    // zero, so the old rule drew the grid at 0 — above the canopy.
    expect(computeGridFloor(-13.75, 18.38)).toBeCloseTo(-13.75);
  });

  it('does not snap just because the scene is wide', () => {
    // The old rule compared against half the 3D DIAGONAL, so a wide flat site
    // snapped from far away. Vertical extent is what matters.
    expect(computeGridFloor(-40, -10)).toBe(-40);
  });

  it('keeps a floor that is far above zero', () => {
    // A mountain plot sampled well above the datum must not snap down to 0.
    expect(computeGridFloor(1200, 1260)).toBe(1200);
  });

  it('scales the tolerance with the scene height', () => {
    // 5% of a 100 m-tall scene is 5 m.
    expect(computeGridFloor(-4, 96)).toBe(0);
    expect(computeGridFloor(-6, 94)).toBeCloseTo(-6);
  });

  it('survives degenerate input', () => {
    expect(computeGridFloor(Infinity, 10)).toBe(0);
    expect(computeGridFloor(NaN, 10)).toBe(0);
    expect(computeGridFloor(-5, Infinity)).toBe(-5);
    expect(computeGridFloor(3, 3)).toBeCloseTo(3);   // zero-height scene
  });
});
