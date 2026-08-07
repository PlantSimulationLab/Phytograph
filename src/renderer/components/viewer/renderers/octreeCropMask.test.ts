import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  applyCropMaskToGeometry,
  clearCropMaskFromGeometry,
  applyCropMaskToVisibleNodes,
  clearCropMaskFromVisibleNodes,
  type CropPredicate,
} from './octreeCropMask';

// Minimal stand-in for a potree tile geometry: a non-indexed position
// attribute plus the setIndex/index surface this module drives.
function makeGeometry(points: Array<[number, number, number]>) {
  const arr = new Float32Array(points.flat());
  const geom: any = {
    attributes: { position: new THREE.BufferAttribute(arr, 3) },
    index: null as any,
    setIndex(idx: any) {
      this.index = idx;
    },
  };
  return geom;
}

// potree tiles carry `matrixAutoUpdate = false` and a directly-authored
// `matrix`; position/quaternion are never populated. The mask composes
// octree.matrixWorld * sceneNode.matrix, so the fake mirrors that shape.
function makeNode(geom: any, matrix = new THREE.Matrix4()) {
  return { sceneNode: { geometry: geom, matrix, matrixAutoUpdate: false } };
}

/** Minimal stand-in for the PointCloudOctree root. */
function makeOctree(nodes: any[], matrixWorld = new THREE.Matrix4()) {
  return { visibleNodes: nodes, matrixWorld, updateWorldMatrix() {} };
}

const identity = new THREE.Matrix4();
/** Keep points with x < 0.5 — a predicate no AABB clip box could express. */
const keepLowX: CropPredicate = (x) => x < 0.5;

describe('applyCropMaskToGeometry', () => {
  it('indexes only the points the predicate keeps', () => {
    const geom = makeGeometry([
      [0, 0, 0], // keep
      [1, 0, 0], // drop
      [0.2, 0, 0], // keep
      [2, 0, 0], // drop
    ]);
    applyCropMaskToGeometry(geom, identity, undefined, keepLowX, false);
    expect(Array.from(geom.index.array)).toEqual([0, 2]);
  });

  it('inverts the test for Keep-Outside', () => {
    const geom = makeGeometry([
      [0, 0, 0],
      [1, 0, 0],
      [0.2, 0, 0],
      [2, 0, 0],
    ]);
    applyCropMaskToGeometry(geom, identity, undefined, keepLowX, true);
    expect(Array.from(geom.index.array)).toEqual([1, 3]);
  });

  it('leaves the geometry unindexed when every point survives', () => {
    const geom = makeGeometry([[0, 0, 0], [0.1, 0, 0]]);
    applyCropMaskToGeometry(geom, identity, undefined, keepLowX, false);
    expect(geom.index).toBeNull();
  });

  it('drops a previous mask when a new region keeps everything', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    applyCropMaskToGeometry(geom, identity, undefined, keepLowX, false);
    expect(geom.index).not.toBeNull();
    // Region widens to include all points.
    applyCropMaskToGeometry(geom, identity, undefined, () => true, false);
    expect(geom.index).toBeNull();
  });

  it('produces an empty index when the predicate rejects everything', () => {
    const geom = makeGeometry([[1, 0, 0], [2, 0, 0]]);
    applyCropMaskToGeometry(geom, identity, undefined, keepLowX, false);
    expect(geom.index.array.length).toBe(0);
  });

  it('never mutates the position attribute', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
    const before = Float32Array.from(geom.attributes.position.array);
    applyCropMaskToGeometry(geom, identity, undefined, keepLowX, false);
    expect(Array.from(geom.attributes.position.array)).toEqual(Array.from(before));
    expect(geom.attributes.position.count).toBe(3);
  });

  it('transforms node-local positions through matrixWorld before testing', () => {
    // Local x=0 sits at world x=10 under this matrix, so it must be REJECTED
    // even though the raw local coordinate would pass.
    const geom = makeGeometry([[0, 0, 0]]);
    const m = new THREE.Matrix4().makeTranslation(10, 0, 0);
    applyCropMaskToGeometry(geom, m, undefined, keepLowX, false);
    expect(geom.index.array.length).toBe(0);
  });

  it('adds the display offset back to recover true world coordinates', () => {
    // The scene renders at world − offset. A point whose WORLD x is 0.2 sits
    // at display x = 0.2 − 100 under a 100-unit offset; without adding the
    // offset back the predicate would see -99.8 and wrongly keep it by a
    // different rule. Here the predicate demands the true world value.
    // Two points, so the assertion distinguishes "kept by the predicate" from
    // "no mask applied at all" — a single surviving point leaves the geometry
    // unindexed and would pass no matter what the predicate saw.
    const geom = makeGeometry([
      [0.2 - 100, 0, 0], // world x = 0.2  → keep
      [5 - 100, 0, 0], // world x = 5    → drop
    ]);
    // Tolerance is 1e-4, not 1e-6: the position attribute is float32, so
    // storing (0.2 − 100) and adding 100 back recovers 0.19999695 — ~3e-6 of
    // inherent storage error. Recentering large coords is precisely why the
    // display offset exists; the predicate only needs to land in the right
    // region, and a sub-micron discrepancy cannot change a crop decision.
    const nearWorldPoint: CropPredicate = (x) => Math.abs(x - 0.2) < 1e-4;
    applyCropMaskToGeometry(geom, identity, { x: 100, y: 0, z: 0 }, nearWorldPoint, false);
    expect(Array.from(geom.index.array)).toEqual([0]);
  });

  it('uses a 32-bit index when the tile exceeds the 16-bit range', () => {
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < 70000; i++) pts.push([i < 69999 ? 0 : 1, 0, 0]);
    const geom = makeGeometry(pts);
    applyCropMaskToGeometry(geom, identity, undefined, keepLowX, false);
    expect(geom.index.array).toBeInstanceOf(Uint32Array);
  });
});

describe('clearCropMaskFromGeometry', () => {
  it('removes a mask this module set', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    applyCropMaskToGeometry(geom, identity, undefined, keepLowX, false);
    clearCropMaskFromGeometry(geom);
    expect(geom.index).toBeNull();
  });

  it('leaves an index it did not set alone', () => {
    const geom = makeGeometry([[0, 0, 0]]);
    const foreign = new THREE.BufferAttribute(new Uint16Array([0]), 1);
    geom.setIndex(foreign);
    clearCropMaskFromGeometry(geom);
    expect(geom.index).toBe(foreign);
  });
});

describe('applyCropMaskToVisibleNodes', () => {
  it('masks every loaded tile', () => {
    const a = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    const b = makeGeometry([[0.1, 0, 0], [2, 0, 0]]);
    const octree: any = makeOctree([makeNode(a), makeNode(b)]);
    applyCropMaskToVisibleNodes(octree, undefined, keepLowX, false, 'k1');
    expect(Array.from(a.index.array)).toEqual([0]);
    expect(Array.from(b.index.array)).toEqual([0]);
  });

  it('skips a tile already masked under the same key', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    let calls = 0;
    const counting: CropPredicate = (x) => {
      calls++;
      return x < 0.5;
    };
    const octree: any = makeOctree([makeNode(geom)]);
    applyCropMaskToVisibleNodes(octree, undefined, counting, false, 'k1');
    const afterFirst = calls;
    applyCropMaskToVisibleNodes(octree, undefined, counting, false, 'k1');
    expect(calls).toBe(afterFirst);
  });

  it('re-masks when the key changes (the region was redrawn)', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    const octree: any = makeOctree([makeNode(geom)]);
    applyCropMaskToVisibleNodes(octree, undefined, keepLowX, false, 'k1');
    expect(Array.from(geom.index.array)).toEqual([0]);
    // New region: keep the high-x point instead.
    applyCropMaskToVisibleNodes(octree, undefined, (x) => x > 0.5, false, 'k2');
    expect(Array.from(geom.index.array)).toEqual([1]);
  });

  it('masks a tile that streams in after the region was set', () => {
    const first = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    const octree: any = makeOctree([makeNode(first)]);
    applyCropMaskToVisibleNodes(octree, undefined, keepLowX, false, 'k1');
    // A newly arrived tile appears under the SAME key — it must still be
    // masked, or its cropped-away points render.
    const late = makeGeometry([[0.2, 0, 0], [3, 0, 0]]);
    octree.visibleNodes.push(makeNode(late));
    applyCropMaskToVisibleNodes(octree, undefined, keepLowX, false, 'k1');
    expect(Array.from(late.index.array)).toEqual([0]);
  });

  it('tolerates nodes with no geometry yet', () => {
    const octree: any = makeOctree([{ sceneNode: null }, { sceneNode: {} }]);
    expect(() =>
      applyCropMaskToVisibleNodes(octree, undefined, keepLowX, false, 'k1'),
    ).not.toThrow();
  });
});

describe('clearCropMaskFromVisibleNodes', () => {
  it('restores full density and allows a later re-mask', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    const octree: any = makeOctree([makeNode(geom)]);
    applyCropMaskToVisibleNodes(octree, undefined, keepLowX, false, 'k1');
    clearCropMaskFromVisibleNodes(octree);
    expect(geom.index).toBeNull();
    // The key was forgotten, so the SAME key must re-apply rather than skip.
    applyCropMaskToVisibleNodes(octree, undefined, keepLowX, false, 'k1');
    expect(Array.from(geom.index.array)).toEqual([0]);
  });
});

describe('invert re-masking (regression)', () => {
  it('re-masks an already-masked tile when only invert flips', () => {
    // Keep Outside after Keep Inside must select the COMPLEMENT. The counts
    // can look right while the wrong points are selected, so assert the
    // actual indices.
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0], [0.2, 0, 0], [2, 0, 0]]);
    const octree: any = makeOctree([makeNode(geom)]);
    applyCropMaskToVisibleNodes(octree, undefined, keepLowX, false, 'poly|false');
    expect(Array.from(geom.index.array)).toEqual([0, 2]);
    applyCropMaskToVisibleNodes(octree, undefined, keepLowX, true, 'poly|true');
    expect(Array.from(geom.index.array)).toEqual([1, 3]);
  });

  it('re-masks a tile whose geometry was left unindexed by the previous mode', () => {
    // The trap: under Keep Inside every point survived, so the tile was left
    // UNINDEXED (the all-survive fast path). Flipping to Keep Outside must
    // then hide all of them — if the key were not consulted, or the fast path
    // marked it done, the tile would keep drawing at full length.
    const geom = makeGeometry([[0, 0, 0], [0.1, 0, 0]]);
    const octree: any = makeOctree([makeNode(geom)]);
    applyCropMaskToVisibleNodes(octree, undefined, keepLowX, false, 'poly|false');
    expect(geom.index).toBeNull();
    applyCropMaskToVisibleNodes(octree, undefined, keepLowX, true, 'poly|true');
    expect(geom.index).not.toBeNull();
    expect(geom.index.array.length).toBe(0);
  });
});
