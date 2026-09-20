/**
 * The defer-the-rebuild threshold, which was the literal `5_000_000` written out
 * at three separate call sites in PointCloudViewer with no shared name.
 *
 * Three copies of one policy is a policy that drifts: changing the trade meant
 * finding all three, and nothing would have failed if one had been missed. The
 * source-level test at the bottom is the part that actually prevents the drift
 * coming back -- the unit tests below only pin the function's behaviour, and a
 * fourth inlined copy would pass them all.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFER_OCTREE_REBUILD_ABOVE_POINTS,
  shouldDeferOctreeRebuild,
} from './deferOctreeRebuild';

describe('shouldDeferOctreeRebuild', () => {
  it('defers only above the threshold', () => {
    const t = DEFER_OCTREE_REBUILD_ABOVE_POINTS;
    expect(shouldDeferOctreeRebuild(t + 1)).toBe(true);
    expect(shouldDeferOctreeRebuild(t)).toBe(false);
    expect(shouldDeferOctreeRebuild(t - 1)).toBe(false);
  });

  it('does not defer a small cloud', () => {
    expect(shouldDeferOctreeRebuild(0)).toBe(false);
    expect(shouldDeferOctreeRebuild(1)).toBe(false);
    expect(shouldDeferOctreeRebuild(100_000)).toBe(false);
  });

  it('does not defer when the point count is unknown', () => {
    // Deferring hides the recolour behind the refresh queue. Doing that to a
    // cloud that might be small trades a visible wait for an invisible one, so
    // an absent count must fall back to NOT deferring.
    expect(shouldDeferOctreeRebuild(null)).toBe(false);
    expect(shouldDeferOctreeRebuild(undefined)).toBe(false);
    expect(shouldDeferOctreeRebuild(NaN)).toBe(false);
    expect(shouldDeferOctreeRebuild(Infinity)).toBe(false);
  });
});

describe('the threshold is not re-inlined at the call sites', () => {
  const viewer = readFileSync(
    resolve(__dirname, '..', 'components', 'PointCloudViewer.tsx'), 'utf8',
  );

  it('every defer decision goes through the shared helper', () => {
    const decisions = viewer.match(/const willDefer = .*/g) ?? [];
    expect(decisions.length, 'expected the three defer_octree call sites').toBe(3);
    for (const line of decisions) {
      expect(line).toContain('shouldDeferOctreeRebuild');
    }
  });

  it('no call site compares a point count against a bare 5_000_000', () => {
    expect(viewer).not.toMatch(/pointCount[^\n]*[<>]=?\s*5_000_000/);
  });
});
