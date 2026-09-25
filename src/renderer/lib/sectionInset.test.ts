import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { insetFrame, sampleOctreeFootprint, slabFootprint } from './sectionInset';
import type { SlabRegion } from './crossSection';

const slab = (over: Partial<SlabRegion> = {}): SlabRegion => ({
  kind: 'slab', a: { x: 0, y: 0 }, b: { x: 10, y: 0 },
  depth: 2, zMin: 0, zMax: 1, offset: 0, ...over,
});

describe('slabFootprint', () => {
  it('is the centreline widened by the depth', () => {
    const c = slabFootprint(slab());
    expect(c).toEqual([
      { x: 0, y: -1 }, { x: 10, y: -1 }, { x: 10, y: 1 }, { x: 0, y: 1 },
    ]);
  });

  it('moves with the step offset, across the centreline', () => {
    const ys = slabFootprint(slab({ offset: 5 })).map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(4);
    expect(Math.max(...ys)).toBeCloseTo(6);
  });

  it('follows a diagonal centreline', () => {
    const c = slabFootprint(slab({ b: { x: 3, y: 4 }, depth: 0 }));
    expect(c[1].x).toBeCloseTo(3);
    expect(c[1].y).toBeCloseTo(4);
  });
});

describe('insetFrame', () => {
  it('keeps the aspect ratio and puts +Y up', () => {
    const f = insetFrame({ minX: 0, minY: 0, maxX: 10, maxY: 5 }, [], 120, 10);
    expect(f.scale).toBeCloseTo(10);
    const lo = f.toPx(0, 0);
    const hi = f.toPx(10, 5);
    expect(hi.x - lo.x).toBeCloseTo(100);
    expect(lo.y - hi.y).toBeCloseTo(50);   // 5 units at the same scale, flipped
  });

  it('widens to keep a slab stepped outside the cloud on the map', () => {
    const f = insetFrame({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, [{ x: 30, y: 5 }], 120, 10);
    const p = f.toPx(30, 5);
    expect(p.x).toBeLessThanOrEqual(110 + 1e-9);
    expect(p.x).toBeGreaterThan(100);
  });
});

describe('sampleOctreeFootprint', () => {
  const node = (xy: Array<[number, number]>, at: [number, number], children: any[] = []) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(xy.flatMap(([x, y]) => [x, y, 0]), 3));
    const p = new THREE.Points(g);
    p.position.set(at[0], at[1], 0);
    p.updateMatrixWorld(true);
    return { sceneNode: p, children, isTreeNode: true };
  };

  it('maps node-local positions to world through matrixWorld and the display offset', () => {
    const root = node([[1, 2]], [10, 20]);
    const s = sampleOctreeFootprint(root, { x: 100, y: 200 });
    expect(Array.from(s)).toEqual([111, 222]);
  });

  it('stops at maxDepth and strides down to the budget', () => {
    const deep = node([[9, 9]], [0, 0]);
    const child = node([[1, 0], [2, 0], [3, 0], [4, 0]], [0, 0], [deep]);
    const root = node([[0, 0]], [0, 0], [child, null]);
    expect(sampleOctreeFootprint(root, null, 100, 1).length / 2).toBe(5);   // deep excluded
    expect(sampleOctreeFootprint(root, null, 100, 2).length / 2).toBe(6);
    expect(sampleOctreeFootprint(root, null, 3, 2).length / 2).toBe(3);     // stride 2 over 6
  });

  it('is empty before any node has loaded', () => {
    expect(sampleOctreeFootprint(null, null).length).toBe(0);
    expect(sampleOctreeFootprint({ children: [] }, null).length).toBe(0);
  });
});
