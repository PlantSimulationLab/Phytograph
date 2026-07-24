import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { collectHitPoints, scatterToFullLength } from './pointCloudHelpers';
import { MISS_ATTRIBUTE } from './classification';
import type { PointCloudData } from './pointCloudTypes';

// Regression guards for the sky/miss exclusion contract on the RENDERER's flat
// compute paths (tree segmentation, wood/leaf, skeleton).
//
// A miss is a ray that hit nothing, projected ~1 km out. Feeding misses to a
// gridding / KD-tree / cut-pursuit tool inflates the extent ~1000x and makes it
// HANG rather than error. Before this helper, only the DEM path filtered them —
// `MISS_ATTRIBUTE` appeared at exactly one compute site in the whole renderer.
//
// The second half of the contract matters just as much: backend results come
// back indexed against the HIT SUBSET, so they must be scattered back to full
// cloud length before anything indexes by cloud position i. Getting that wrong
// silently mislabels points instead of hanging.

function makeCloud(
  positions: number[],
  opts: { isMiss?: number[]; scalars?: Record<string, number[]> } = {},
): PointCloudData {
  const pointCount = positions.length / 3;
  const scalarFields: PointCloudData['scalarFields'] = {};
  if (opts.isMiss) {
    scalarFields[MISS_ATTRIBUTE] = {
      values: Float32Array.from(opts.isMiss), min: 0, max: 1,
    };
  }
  for (const [k, v] of Object.entries(opts.scalars ?? {})) {
    scalarFields[k] = { values: Float32Array.from(v), min: 0, max: 1 };
  }
  return {
    positions: Float32Array.from(positions),
    pointCount,
    scalarFields,
    bounds: {
      min: new THREE.Vector3(), max: new THREE.Vector3(),
      center: new THREE.Vector3(), size: new THREE.Vector3(),
    },
  };
}

describe('collectHitPoints', () => {
  it('drops miss points and keeps hits in order', () => {
    const cloud = makeCloud(
      [0, 0, 0,  1000, 1000, 1000,  1, 2, 3,  -900, 400, 700],
      { isMiss: [0, 1, 0, 1] },
    );
    const { points, hitIndices, droppedMisses } = collectHitPoints(cloud);

    expect(points).toEqual([[0, 0, 0], [1, 2, 3]]);
    expect(hitIndices).toEqual([0, 2]);
    expect(droppedMisses).toBe(2);
  });

  it('keeps every point when the cloud has no miss column', () => {
    const cloud = makeCloud([0, 0, 0, 1, 1, 1]);
    const { points, hitIndices, droppedMisses } = collectHitPoints(cloud);

    expect(points).toHaveLength(2);
    expect(hitIndices).toEqual([0, 1]);
    expect(droppedMisses).toBe(0);
  });

  it('ignores a miss column that is not aligned to the cloud', () => {
    // A stale/partial column must never silently delete real points.
    const cloud = makeCloud([0, 0, 0, 1, 1, 1, 2, 2, 2], { isMiss: [0, 1] });
    const { points, droppedMisses } = collectHitPoints(cloud);

    expect(points).toHaveLength(3);
    expect(droppedMisses).toBe(0);
  });

  it('filters aligned arrays in lockstep with the positions', () => {
    const cloud = makeCloud(
      [0, 0, 0,  1000, 1000, 1000,  1, 2, 3],
      { isMiss: [0, 1, 0], scalars: { ground: [1, 2, 3] } },
    );
    const { aligned } = collectHitPoints(cloud, {
      ground: cloud.scalarFields!.ground.values,
    });

    // Element for the dropped miss (index 1) must be gone, not shifted in.
    expect(aligned.ground).toEqual([1, 3]);
  });

  it('drops an aligned array whose length does not match the cloud', () => {
    const cloud = makeCloud([0, 0, 0, 1, 1, 1], { isMiss: [0, 0] });
    const { aligned } = collectHitPoints(cloud, {
      bad: Float32Array.from([1, 2, 3, 4]),
    });
    expect(aligned.bad).toBeUndefined();
  });

  it('handles an all-miss cloud without producing points', () => {
    const cloud = makeCloud([1000, 0, 0, 0, 1000, 0], { isMiss: [1, 1] });
    const { points, hitIndices, droppedMisses } = collectHitPoints(cloud);

    expect(points).toEqual([]);
    expect(hitIndices).toEqual([]);
    expect(droppedMisses).toBe(2);
  });
});

describe('scatterToFullLength', () => {
  it('places hit-subset results back at their original cloud indices', () => {
    // Backend labelled the 2 hits [7, 9]; cloud indices 1 and 3 were misses.
    const out = scatterToFullLength([7, 9], [0, 2], 4);
    expect(Array.from(out)).toEqual([7, 0, 9, 0]);
  });

  it('honours a custom fill for the non-hit slots', () => {
    const out = scatterToFullLength([5], [1], 3, -1);
    expect(Array.from(out)).toEqual([-1, 5, -1]);
  });

  it('round-trips with collectHitPoints so labels land on the right points', () => {
    const cloud = makeCloud(
      [0, 0, 0,  1000, 1000, 1000,  1, 2, 3,  -900, 400, 700,  4, 5, 6],
      { isMiss: [0, 1, 0, 1, 0] },
    );
    const { points, hitIndices } = collectHitPoints(cloud);
    // Pretend the backend returned one label per HIT point.
    const perHitLabels = points.map((_, i) => i + 1);
    const full = scatterToFullLength(perHitLabels, hitIndices, cloud.pointCount);

    expect(full).toHaveLength(cloud.pointCount);
    // Hits keep their labels in cloud-index space; misses stay 0.
    expect(Array.from(full)).toEqual([1, 0, 2, 0, 3]);
  });

  it('does not overrun when there are more values than hit indices', () => {
    const out = scatterToFullLength([1, 2, 3], [0], 2);
    expect(Array.from(out)).toEqual([1, 0]);
  });
});
