import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { robustSceneScale, zoomLimits, clampDollyToSurface } from './cameraScale';

const box = (
  min: [number, number, number],
  max: [number, number, number],
  groundZ?: number,
) => ({
  min: new THREE.Vector3(...min),
  max: new THREE.Vector3(...max),
  groundZ,
});

describe('robustSceneScale with the backend percentile extent', () => {
  it('prefers the percentile extent over the AABB', () => {
    // The AABB says 1000 m across; the percentile span says the content is 6 m.
    const s = robustSceneScale({
      ...box([-500, -500, 0], [500, 500, 400]),
      robustExtent: [6, 6, 3],
    });
    expect(s).toBeCloseTo(6, 6);
  });

  it('handles outliers on ALL THREE axes — the case no AABB heuristic can', () => {
    // Every axis of the box is inflated, so the median-axis fallback reports
    // ~1000. Only the percentile extent gets this right.
    const bounds = box([-480, -495, 0], [500, 505, 400]);
    const fallback = robustSceneScale(bounds);
    const withExtent = robustSceneScale({ ...bounds, robustExtent: [6, 6, 3] });
    expect(fallback).toBeGreaterThan(500);   // the fallback genuinely cannot
    expect(withExtent).toBeCloseTo(6, 6);    // the percentile extent can
  });

  it('takes the largest axis of the percentile extent', () => {
    const s = robustSceneScale({
      ...box([0, 0, 0], [1, 1, 1]),
      robustExtent: [3, 40, 8],
    });
    expect(s).toBeCloseTo(40, 6);
  });

  it('falls back to the AABB when the extent is degenerate', () => {
    // An all-zero extent (single-point cloud) carries no information; the AABB
    // heuristic is better than a zero scale.
    const s = robustSceneScale({ ...box([0, 0, 0], [12, 12, 12]), robustExtent: [0, 0, 0] });
    expect(s).toBeCloseTo(12, 6);
  });
});

describe('robustSceneScale', () => {
  it('reports the scene size on a clean, roughly cubic scene', () => {
    // 20 m on every axis — nothing to be robust against, so the answer is 20.
    expect(robustSceneScale(box([0, 0, 0], [20, 20, 20]))).toBeCloseTo(20, 6);
  });

  it('ignores a far lateral outlier that inflates one axis', () => {
    // A 10 m plot with one stray return 1 km east. The raw AABB is 1000 m wide,
    // but Y and Z still describe the real content — the median axis is 10.
    const withOutlier = robustSceneScale(box([0, 0, 0], [1000, 10, 10]));
    expect(withOutlier).toBeCloseTo(10, 6);
    // A factor-100 error here is exactly what made maxDistance land inside the
    // scene, so assert it is nowhere near the inflated extent.
    expect(withOutlier).toBeLessThan(50);
  });

  it('ignores a sky/miss point that inflates only Z', () => {
    // Misses project ~1 km up. X and Y are clean, so the median is the true size.
    expect(robustSceneScale(box([0, 0, 0], [30, 30, 1000]))).toBeCloseTo(30, 6);
  });

  it('survives two inflated axes by taking the least-inflated one', () => {
    // Worst realistic case: outliers in X and Z. The median discards the largest,
    // so we get the middle value rather than the 1000 m extent.
    expect(robustSceneScale(box([0, 0, 0], [1000, 5, 800]))).toBeCloseTo(800, 6);
  });

  it('prefers the robust ground level over a sub-terrain noise point', () => {
    // A single bad return 500 m below ground makes the Z extent look 508 m.
    // A wide plot (200 m footprint) is the case where that matters: the median
    // of [508, 200, 200] is 200, but the median of a scene whose Z is ALSO the
    // middle value would be the outlier-driven 508. groundZ (a backend low-Z
    // percentile) puts the floor back at 0 so Z reports its real 8 m.
    const raw = robustSceneScale(box([0, 0, -500], [600, 200, 8]));
    const robust = robustSceneScale(box([0, 0, -500], [600, 200, 8], 0));
    expect(robust).toBeCloseTo(200, 6);
    // Without it, the sunken floor makes Z (508) the median instead of 200.
    expect(raw).toBeCloseTo(508, 6);
    expect(raw).toBeGreaterThan(robust);
  });

  it('ignores a groundZ that sits above the scene rather than producing a negative extent', () => {
    // A stale/mesh-scene groundZ above max.z must not invert the Z extent.
    const s = robustSceneScale(box([0, 0, 0], [10, 10, 4], 99));
    expect(s).toBeGreaterThan(0);
    expect(s).toBeCloseTo(10, 6);
  });

  it('handles a planar scene (flat DEM) via its in-plane extent', () => {
    // Zero Z extent sorts to the bottom, so the median is the smaller in-plane
    // axis — a real measure of the scene, not the degenerate zero.
    expect(robustSceneScale(box([0, 0, 0], [50, 40, 0]))).toBeCloseTo(40, 6);
  });

  it('falls back to the largest axis on a linear scene', () => {
    // A single scan line has only one non-zero axis; the median IS zero, which
    // is unusable as a scale, so the largest axis is the sensible answer.
    expect(robustSceneScale(box([0, 0, 0], [50, 0, 0]))).toBeCloseTo(50, 6);
  });

  it('falls back to 1 on a degenerate (single-point / empty) scene', () => {
    expect(robustSceneScale(box([0, 0, 0], [0, 0, 0]))).toBe(1);
  });

  it('is not fooled by a non-finite extent', () => {
    const s = robustSceneScale(box([0, 0, 0], [Infinity, 12, 12]));
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeCloseTo(12, 6);
  });
});

describe('zoomLimits', () => {
  it('scales both limits to the scene rather than using fixed constants', () => {
    const small = zoomLimits(box([0, 0, 0], [0.3, 0.3, 0.3]));   // a potted plant
    const large = zoomLimits(box([0, 0, 0], [400, 400, 400]));   // a UTM plot

    // The old hardcoded minDistance of 0.1 was a third of the small scene — you
    // could not get close enough to inspect anything. Now it is proportional.
    expect(small.minDistance).toBeLessThan(0.3 / 100);
    expect(large.minDistance).toBeGreaterThan(small.minDistance);

    // The old hardcoded maxDistance of 10000 sat well inside a big scene's
    // useful pull-back range on one hand and miles outside a small one's on the
    // other. Both now bracket their own scene.
    expect(small.maxDistance).toBeGreaterThan(0.3);
    expect(small.maxDistance).toBeLessThan(100);
    expect(large.maxDistance).toBeGreaterThan(400);
  });

  it('keeps min well below max so the usable range is wide at any scale', () => {
    for (const size of [0.05, 1, 25, 5000]) {
      const l = zoomLimits(box([0, 0, 0], [size, size, size]));
      expect(l.minDistance).toBeGreaterThan(0);
      expect(l.maxDistance / l.minDistance).toBeGreaterThan(1e5);
    }
  });

  it('derives limits from the robust scale, so one outlier does not move them', () => {
    const clean = zoomLimits(box([0, 0, 0], [10, 10, 10]));
    const outlier = zoomLimits(box([0, 0, 0], [1000, 10, 10]));
    expect(outlier.maxDistance).toBeCloseTo(clean.maxDistance, 6);
    expect(outlier.minDistance).toBeCloseTo(clean.minDistance, 6);
  });
});

describe('clampDollyToSurface', () => {
  it('lets a step that stops short of the surface through untouched', () => {
    expect(clampDollyToSurface(1, 10)).toBe(1);
  });

  it('stops short of the surface instead of tunnelling through it', () => {
    // Asking to move 10 m toward a surface 4 m away must not put the camera 6 m
    // behind it — the whole "I zoomed and the cloud vanished" failure.
    const step = clampDollyToSurface(10, 4);
    expect(step).toBeLessThan(4);
    expect(step).toBeGreaterThan(0);
  });

  it('approaches asymptotically, so a surface can be inspected arbitrarily closely', () => {
    // Repeated maximal zooms keep closing the gap and never cross it.
    let dist = 5;
    for (let i = 0; i < 50; i++) {
      dist -= clampDollyToSurface(Number.MAX_SAFE_INTEGER, dist);
      expect(dist).toBeGreaterThan(0);
    }
    expect(dist).toBeLessThan(5);
  });

  it('never restricts zooming OUT', () => {
    // Pulling away from a surface is always safe, even from very close in.
    expect(clampDollyToSurface(-100, 0.001)).toBe(-100);
  });

  it('passes the step through when there is no usable surface distance', () => {
    expect(clampDollyToSurface(3, Infinity)).toBe(3);
    expect(clampDollyToSurface(3, 0)).toBe(3);
    expect(clampDollyToSurface(3, -1)).toBe(3);
  });
});
