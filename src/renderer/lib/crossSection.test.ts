import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  slabTangent, slabNormal, slabLength, slabCenter,
  slabPredicate, slabToPlanes, slabToBox,
  slabViewPose, slabOrthoFrustum,
  slabStepDistance, stepSlab, slabCoverage,
  defaultSlabForBounds, slabToPayload,
  type SlabRegion,
} from './crossSection';

/** Axis-aligned slab along +X, 2 units thick, spanning z 0..10. */
const SLAB: SlabRegion = {
  kind: 'slab',
  a: { x: 0, y: 0 },
  b: { x: 10, y: 0 },
  depth: 2,
  zMin: 0,
  zMax: 10,
  offset: 0,
};

describe('slab axes', () => {
  it('tangent runs along the centreline, normal is perpendicular', () => {
    expect(slabTangent(SLAB)).toEqual({ x: 1, y: 0 });
    expect(slabNormal(SLAB)).toEqual({ x: -0, y: 1 });
    expect(slabLength(SLAB)).toBe(10);
  });

  it('handles a diagonal centreline', () => {
    const s: SlabRegion = { ...SLAB, a: { x: 0, y: 0 }, b: { x: 3, y: 4 } };
    const t = slabTangent(s);
    expect(t.x).toBeCloseTo(0.6, 10);
    expect(t.y).toBeCloseTo(0.8, 10);
    // Normal is perpendicular and unit-length.
    const n = slabNormal(s);
    expect(t.x * n.x + t.y * n.y).toBeCloseTo(0, 10);
    expect(Math.hypot(n.x, n.y)).toBeCloseTo(1, 10);
    expect(slabLength(s)).toBeCloseTo(5, 10);
  });

  it('degenerates safely when the centreline has no length', () => {
    const s: SlabRegion = { ...SLAB, b: { x: 0, y: 0 } };
    expect(() => slabPredicate(s)(0, 0, 5)).not.toThrow();
    expect(slabLength(s)).toBe(0);
    expect(slabTangent(s)).toEqual({ x: 1, y: 0 });
  });

  it('centre follows the step offset along the normal', () => {
    expect(slabCenter(SLAB).toArray()).toEqual([5, 0, 5]);
    expect(slabCenter({ ...SLAB, offset: 3 }).toArray()).toEqual([5, 3, 5]);
  });
});

describe('slabPredicate', () => {
  const inside = slabPredicate(SLAB);

  it('accepts a point on the centreline', () => {
    expect(inside(5, 0, 5)).toBe(true);
  });

  it('accepts to the slab face and rejects past it', () => {
    expect(inside(5, 0.99, 5)).toBe(true);
    expect(inside(5, -0.99, 5)).toBe(true);
    expect(inside(5, 1.01, 5)).toBe(false);
    expect(inside(5, -1.01, 5)).toBe(false);
  });

  it('bounds along the centreline, not infinitely', () => {
    expect(inside(-0.01, 0, 5)).toBe(false);
    expect(inside(10.01, 0, 5)).toBe(false);
    expect(inside(0, 0, 5)).toBe(true);
    expect(inside(10, 0, 5)).toBe(true);
  });

  it('bounds vertically', () => {
    expect(inside(5, 0, -0.01)).toBe(false);
    expect(inside(5, 0, 10.01)).toBe(false);
  });

  it('follows the step offset', () => {
    const stepped = slabPredicate({ ...SLAB, offset: 5 });
    expect(stepped(5, 5, 5)).toBe(true);
    expect(stepped(5, 0, 5)).toBe(false);   // where the slab used to be
  });
});

describe('slabToPlanes', () => {
  it('agrees with slabPredicate over a sampled volume', () => {
    // The property everything rests on: the GPU (planes) and the CPU/backend
    // (predicate) must classify identically, or the preview shows one thing and
    // the apply does another.
    for (const s of [
      SLAB,
      { ...SLAB, offset: 3 },
      { ...SLAB, a: { x: -2, y: 1 }, b: { x: 6, y: 5 }, depth: 1.5 },
    ] as SlabRegion[]) {
      const planes = slabToPlanes(s);
      const pred = slabPredicate(s);
      const p = new THREE.Vector3();
      for (let i = 0; i < 400; i++) {
        p.set(
          -4 + Math.random() * 18,
          -6 + Math.random() * 14,
          (s.zMin + s.zMax) / 2,      // planes do not bound z; hold it inside
        );
        const byPlanes = planes.every((pl) => pl.distanceToPoint(p) >= 0);
        expect(byPlanes).toBe(pred(p.x, p.y, p.z));
      }
    }
  });

  it('produces four planes with unit normals', () => {
    for (const pl of slabToPlanes(SLAB)) {
      expect(pl.normal.length()).toBeCloseTo(1, 10);
    }
    expect(slabToPlanes(SLAB)).toHaveLength(4);
  });
});

describe('slabToBox', () => {
  it('maps the unit cube onto the slab volume', () => {
    const { matrix, halfExtents, center } = slabToBox(SLAB);
    expect(center.toArray()).toEqual([5, 0, 5]);
    expect(halfExtents.toArray()).toEqual([5, 1, 5]);
    // A unit-cube corner lands on the slab's corner.
    const corner = new THREE.Vector3(0.5, 0.5, 0.5).applyMatrix4(matrix);
    expect(corner.x).toBeCloseTo(10, 6);
    expect(corner.y).toBeCloseTo(1, 6);
    expect(corner.z).toBeCloseTo(10, 6);
  });
});

describe('slabViewPose', () => {
  it('places the eye off the face, looking back along the normal', () => {
    const { eye, target, up } = slabViewPose(SLAB, 20);
    expect(target.toArray()).toEqual([5, 0, 5]);
    expect(eye.toArray()).toEqual([5, 20, 5]);
    expect(up.toArray()).toEqual([0, 0, 1]);
    // Flipping the side mirrors it.
    expect(slabViewPose(SLAB, 20, -1).eye.y).toBe(-20);
  });
});

describe('slabOrthoFrustum', () => {
  it('frames the slab face with margin', () => {
    // Face is 10 long x 10 tall; a square viewport needs 5 x 5 plus margin.
    const { halfW, halfH } = slabOrthoFrustum(SLAB, 1, 0.1);
    expect(halfW).toBeCloseTo(5.5, 6);
    expect(halfH).toBeCloseTo(5.5, 6);
  });

  it('grows the short axis to satisfy a wide viewport', () => {
    const { halfW, halfH } = slabOrthoFrustum(SLAB, 2, 0);
    expect(halfW / halfH).toBeCloseTo(2, 6);
    // Never crops: the face still fits.
    expect(halfW).toBeGreaterThanOrEqual(5);
    expect(halfH).toBeGreaterThanOrEqual(5);
  });
});

describe('stepping', () => {
  it('half-depth is the default and OVERLAPS consecutive sections', () => {
    // The property that makes stepping safe: nothing can fall between two
    // sections unseen. TerraScan recommends exactly this.
    expect(slabStepDistance(SLAB, 'half')).toBe(1);
    expect(slabStepDistance(SLAB, 'half')).toBeLessThan(SLAB.depth);

    const next = stepSlab(SLAB, 1, 'half');
    const a = slabPredicate(SLAB);
    const b = slabPredicate(next);
    // A point in the overlap belongs to BOTH sections.
    expect(a(5, 0.5, 5) && b(5, 0.5, 5)).toBe(true);
  });

  it('full-depth tiles exactly — no overlap, no gap', () => {
    expect(slabStepDistance(SLAB, 'full')).toBe(2);
    const next = stepSlab(SLAB, 1, 'full');
    // The shared boundary is the only point both contain.
    expect(slabPredicate(SLAB)(5, 1, 5)).toBe(true);
    expect(slabPredicate(next)(5, 1, 5)).toBe(true);
    expect(slabPredicate(next)(5, 0.99, 5)).toBe(false);
  });

  it('every step mode leaves no gap between consecutive sections', () => {
    for (const mode of ['half', 'almost', 'full'] as const) {
      expect(slabStepDistance(SLAB, mode)).toBeLessThanOrEqual(SLAB.depth);
    }
  });

  it('fixed mode honours the value, falling back to half', () => {
    expect(slabStepDistance(SLAB, 'fixed', 0.25)).toBe(0.25);
    expect(slabStepDistance(SLAB, 'fixed', 0)).toBe(1);
  });

  it('steps move OFFSET only, so the centreline is untouched', () => {
    const next = stepSlab(SLAB, 1, 'half');
    expect(next.a).toEqual(SLAB.a);
    expect(next.b).toEqual(SLAB.b);
    expect(next.offset).toBe(1);
    // ...and reset-to-origin is therefore free.
    expect(stepSlab(next, -1, 'half').offset).toBe(0);
  });
});

describe('slabCoverage', () => {
  const bounds = {
    min: new THREE.Vector3(0, -10, 0),
    max: new THREE.Vector3(10, 10, 10),
  };

  it('reports a 1-based position and a total spanning the bounds', () => {
    // 20 units across the normal, 1-unit steps -> ~21 sections.
    const { index, total } = slabCoverage(SLAB, bounds, 'half');
    expect(total).toBeGreaterThan(1);
    expect(index).toBeGreaterThanOrEqual(1);
    expect(index).toBeLessThanOrEqual(total);
  });

  it('advances the index as the slab steps', () => {
    const first = slabCoverage(SLAB, bounds, 'half').index;
    const later = slabCoverage(stepSlab(SLAB, 1, 'half'), bounds, 'half').index;
    expect(later).toBe(first + 1);
  });

  it('a coarser step yields fewer sections', () => {
    const fine = slabCoverage(SLAB, bounds, 'half').total;
    const coarse = slabCoverage(SLAB, bounds, 'full').total;
    expect(coarse).toBeLessThan(fine);
  });

  it('clamps the index inside the traverse', () => {
    const far = { ...SLAB, offset: 1e6 };
    const { index, total } = slabCoverage(far, bounds, 'half');
    expect(index).toBe(total);
  });
});

describe('defaultSlabForBounds', () => {
  const bounds = {
    min: new THREE.Vector3(0, 0, 0),
    max: new THREE.Vector3(10, 20, 5),
  };

  it('centres a readable slab across the cloud', () => {
    const s = defaultSlabForBounds(bounds);
    expect(s.depth).toBeGreaterThan(0);
    expect(s.depth).toBeLessThan(20);        // thin relative to the cloud
    // Spans the full X extent and sits at the Y centre.
    expect(s.a.x).toBeCloseTo(0, 6);
    expect(s.b.x).toBeCloseTo(10, 6);
    expect(s.a.y).toBeCloseTo(10, 6);
    // Vertical extent covers the cloud with padding.
    expect(s.zMin).toBeLessThanOrEqual(0);
    expect(s.zMax).toBeGreaterThanOrEqual(5);
  });

  it('contains points at the middle of the cloud', () => {
    const inside = slabPredicate(defaultSlabForBounds(bounds));
    expect(inside(5, 10, 2.5)).toBe(true);
  });

  it('survives a degenerate (flat) bounding box', () => {
    const flat = {
      min: new THREE.Vector3(0, 0, 0),
      max: new THREE.Vector3(0, 0, 0),
    };
    const s = defaultSlabForBounds(flat);
    expect(Number.isFinite(s.depth)).toBe(true);
    expect(s.depth).toBeGreaterThan(0);
  });
});

describe('slabToPayload', () => {
  it('flattens to the backend wire shape', () => {
    expect(slabToPayload({ ...SLAB, offset: 2 })).toEqual({
      kind: 'slab',
      a: [0, 0],
      b: [10, 0],
      depth: 2,
      zMin: 0,
      zMax: 10,
      offset: 2,
    });
  });
});
