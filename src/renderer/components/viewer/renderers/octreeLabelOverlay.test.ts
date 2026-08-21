import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  LABEL_ATTRIBUTE,
  ensureLabelAttribute,
  applyStrokesToGeometry,
  swapLabelIntoIntensity,
  clearLabelOverlayFromGeometry,
  applyLabelOverlayToVisibleNodes,
  clearLabelOverlayFromVisibleNodes,
  publishLabelOverlayStats,
  type LabelOverlayState,
  type LabelStrokeRender,
} from './octreeLabelOverlay';

// Minimal stand-in for a potree tile geometry: the attribute surface this
// module drives, plus the bounding-box hook the AABB rejection uses.
function makeGeometry(points: Array<[number, number, number]>, extra: Record<string, any> = {}) {
  const arr = new Float32Array(points.flat());
  const geom: any = {
    attributes: { position: new THREE.BufferAttribute(arr, 3), ...extra },
    boundingBox: null as THREE.Box3 | null,
    setAttribute(name: string, attr: any) { this.attributes[name] = attr; },
    deleteAttribute(name: string) { delete this.attributes[name]; },
    computeBoundingBox() {
      const b = new THREE.Box3();
      for (const p of points) b.expandByPoint(new THREE.Vector3(p[0], p[1], p[2]));
      this.boundingBox = b;
    },
  };
  return geom;
}

// potree tiles carry matrixAutoUpdate=false and a directly-authored `matrix`.
function makeNode(geom: any, matrix = new THREE.Matrix4()) {
  return { sceneNode: { geometry: geom, matrix, matrixAutoUpdate: false } };
}

function makeOctree(nodes: any[], matrixWorld = new THREE.Matrix4()) {
  return {
    visibleNodes: nodes,
    matrixWorld,
    updateWorldMatrix() {},
    traverse(fn: (o: any) => void) {
      for (const n of nodes) {
        fn({ isPoints: true, visible: true, geometry: n.sceneNode.geometry });
      }
    },
  };
}

const identity = new THREE.Matrix4();

/** Paint everything with x < 0.5 — a shape no AABB clip box could express. */
function lowX(toIndex: number, fromIndices: Set<number> | null = null): LabelStrokeRender {
  return { predicate: (x) => x < 0.5, aabb: null, toIndex, fromIndices };
}

function state(strokes: LabelStrokeRender[], key = 'k1', unlabeledIndex = 0): LabelOverlayState {
  return { strokes, key, unlabeledIndex };
}

function labels(geom: any): number[] {
  return Array.from(geom.attributes[LABEL_ATTRIBUTE].array as Float32Array);
}

beforeEach(() => {
  (globalThis as any).__labelOverlay = undefined;
});

describe('ensureLabelAttribute', () => {
  it('creates a column sized to the tile, filled with the unlabelled index', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    const attr = ensureLabelAttribute(geom, 0);
    expect(attr?.count).toBe(2);
    expect(labels(geom)).toEqual([0, 0]);
  });

  it('honours a non-zero unlabelled index', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    ensureLabelAttribute(geom, 7);
    expect(labels(geom)).toEqual([7, 7]);
  });

  it('is idempotent — re-running keeps the same buffer', () => {
    const geom = makeGeometry([[0, 0, 0]]);
    const a = ensureLabelAttribute(geom, 0);
    const b = ensureLabelAttribute(geom, 0);
    expect(a).toBe(b);
  });

  it('rebuilds when the tile point count changed under it', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    ensureLabelAttribute(geom, 0);
    geom.attributes.position = new THREE.BufferAttribute(new Float32Array(9), 3);
    expect(ensureLabelAttribute(geom, 0)?.count).toBe(3);
  });

  it('returns null for a geometry with no positions', () => {
    expect(ensureLabelAttribute({ attributes: {} }, 0)).toBeNull();
  });
});

describe('applyStrokesToGeometry', () => {
  it('paints exactly the points the predicate selects', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0], [0.2, 0, 0]]);
    applyStrokesToGeometry(geom, identity, undefined, null, state([lowX(3)]));
    expect(labels(geom)).toEqual([3, 0, 3]);
  });

  it('applies strokes IN ORDER — later strokes win', () => {
    // Labelling is not commutative; this is why the stroke list is never sorted.
    const geom = makeGeometry([[0, 0, 0]]);
    applyStrokesToGeometry(geom, identity, undefined, null,
      state([lowX(1), lowX(2)]));
    expect(labels(geom)).toEqual([2]);
  });

  it('REPLAYS FROM SCRATCH, so a re-run is not cumulative', () => {
    // The property that makes LOD refinement correct: replaying the same list
    // against any tile at any detail level yields the same answer.
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    applyStrokesToGeometry(geom, identity, undefined, null, state([lowX(5)]));
    applyStrokesToGeometry(geom, identity, undefined, null, state([]));
    expect(labels(geom)).toEqual([0, 0]);
  });

  it('a finer tile with different points gets correct labels from the same strokes', () => {
    // The LOD answer, stated directly: no per-point identity is involved.
    const coarse = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    const fine = makeGeometry([[0, 0, 0], [0.25, 0, 0], [0.75, 0, 0], [1, 0, 0]]);
    const s = state([lowX(4)]);
    applyStrokesToGeometry(coarse, identity, undefined, null, s);
    applyStrokesToGeometry(fine, identity, undefined, null, s);
    expect(labels(coarse)).toEqual([4, 0]);
    expect(labels(fine)).toEqual([4, 4, 0, 0]);
  });

  it('honours the From-class gate', () => {
    const geom = makeGeometry([[0, 0, 0], [0.1, 0, 0]]);
    applyStrokesToGeometry(geom, identity, undefined, null, state([lowX(1)]));
    // Only repaint index 2 -> nothing matches, so this is a no-op.
    applyStrokesToGeometry(geom, identity, undefined, null,
      state([lowX(1), { ...lowX(9), fromIndices: new Set([2]) }]));
    expect(labels(geom)).toEqual([1, 1]);
    // Now gate on the index that IS present.
    applyStrokesToGeometry(geom, identity, undefined, null,
      state([lowX(1), { ...lowX(9), fromIndices: new Set([1]) }]));
    expect(labels(geom)).toEqual([9, 9]);
  });

  it('starts from committed labels when the octree carries them', () => {
    // After a commit rebuild the baked column is the baseline, so previously
    // saved work does not vanish while new strokes are pending.
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    applyStrokesToGeometry(geom, identity, undefined, [8, 8], state([]));
    expect(labels(geom)).toEqual([8, 8]);
    applyStrokesToGeometry(geom, identity, undefined, [8, 8], state([lowX(3)]));
    expect(labels(geom)).toEqual([3, 8]);
  });

  it('ignores a committed array whose length does not match the tile', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    applyStrokesToGeometry(geom, identity, undefined, [8], state([]));
    expect(labels(geom)).toEqual([0, 0]);
  });

  it('adds the display offset back before testing (world-frame predicates)', () => {
    // matrixWorld lands a point in the DISPLAY frame; predicates speak world.
    // Same round trip applyCropMaskToGeometry does.
    const geom = makeGeometry([[0, 0, 0]]);
    const offset = { x: 10, y: 0, z: 0 };
    // World x is 0 + 10 = 10, so a "x < 0.5" stroke must NOT paint it.
    applyStrokesToGeometry(geom, identity, offset, null, state([lowX(3)]));
    expect(labels(geom)).toEqual([0]);
  });

  it('respects the tile world transform', () => {
    const geom = makeGeometry([[0, 0, 0]]);
    const shifted = new THREE.Matrix4().makeTranslation(5, 0, 0);
    applyStrokesToGeometry(geom, shifted, undefined, null, state([lowX(3)]));
    expect(labels(geom)).toEqual([0]);   // moved to x=5, outside the predicate
  });

  it('skips a stroke whose AABB misses the tile', () => {
    // The cost bound that makes a long session affordable.
    const geom = makeGeometry([[0, 0, 0], [0.1, 0, 0]]);
    const far = new THREE.Box3(
      new THREE.Vector3(100, 100, 100), new THREE.Vector3(101, 101, 101),
    );
    applyStrokesToGeometry(geom, identity, undefined, null,
      state([{ ...lowX(6), aabb: far }]));
    expect(labels(geom)).toEqual([0, 0]);
  });

  it('applies a stroke whose AABB overlaps the tile', () => {
    const geom = makeGeometry([[0, 0, 0], [0.1, 0, 0]]);
    const near = new THREE.Box3(
      new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1),
    );
    applyStrokesToGeometry(geom, identity, undefined, null,
      state([{ ...lowX(6), aabb: near }]));
    expect(labels(geom)).toEqual([6, 6]);
  });

  it('flags the attribute for re-upload (three.js only uploads on a version bump)', () => {
    // `needsUpdate` is a write-only setter that increments `version`; reading it
    // back gives undefined, so assert on the version the renderer actually
    // checks. Without this bump the GPU keeps drawing the stale buffer and the
    // paint is invisible.
    const geom = makeGeometry([[0, 0, 0]]);
    const before = (ensureLabelAttribute(geom, 0) as THREE.BufferAttribute).version;
    applyStrokesToGeometry(geom, identity, undefined, null, state([lowX(1)]));
    expect(geom.attributes[LABEL_ATTRIBUTE].version).toBeGreaterThan(before);
  });
});

describe('intensity aliasing', () => {
  it('aliases the label column into intensity, backing up what was there', () => {
    const original = new THREE.BufferAttribute(new Float32Array([9, 9]), 1);
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]], { intensity: original });
    ensureLabelAttribute(geom, 0);
    expect(swapLabelIntoIntensity(geom)).toBe(true);
    expect(geom.attributes.intensity).toBe(geom.attributes[LABEL_ATTRIBUTE]);

    clearLabelOverlayFromGeometry(geom);
    expect(geom.attributes.intensity).toBe(original);
    expect(geom.attributes[LABEL_ATTRIBUTE]).toBeUndefined();
  });

  it('is idempotent by reference compare', () => {
    const geom = makeGeometry([[0, 0, 0]], {
      intensity: new THREE.BufferAttribute(new Float32Array([1]), 1),
    });
    ensureLabelAttribute(geom, 0);
    swapLabelIntoIntensity(geom);
    const after = geom.attributes.intensity;
    swapLabelIntoIntensity(geom);
    expect(geom.attributes.intensity).toBe(after);
  });

  it('is a no-op on a tile with no label column', () => {
    expect(swapLabelIntoIntensity(makeGeometry([[0, 0, 0]]))).toBe(false);
  });

  it('survives a tile that never had an intensity attribute', () => {
    const geom = makeGeometry([[0, 0, 0]]);
    ensureLabelAttribute(geom, 0);
    swapLabelIntoIntensity(geom);
    clearLabelOverlayFromGeometry(geom);
    expect(geom.attributes[LABEL_ATTRIBUTE]).toBeUndefined();
  });
});

describe('applyLabelOverlayToVisibleNodes', () => {
  it('paints every visible tile and keys them', () => {
    const a = makeGeometry([[0, 0, 0]]);
    const b = makeGeometry([[1, 0, 0]]);
    const octree = makeOctree([makeNode(a), makeNode(b)]);
    applyLabelOverlayToVisibleNodes(octree, undefined, state([lowX(2)]));
    expect(labels(a)).toEqual([2]);
    expect(labels(b)).toEqual([0]);
  });

  it('skips a tile already built for the same key (the steady-state fast path)', () => {
    const geom = makeGeometry([[0, 0, 0]]);
    const octree = makeOctree([makeNode(geom)]);
    applyLabelOverlayToVisibleNodes(octree, undefined, state([lowX(2)], 'k1'));
    // Mutate behind the module's back; the same key must NOT rebuild it.
    geom.attributes[LABEL_ATTRIBUTE].array[0] = 99;
    applyLabelOverlayToVisibleNodes(octree, undefined, state([lowX(2)], 'k1'));
    expect(labels(geom)).toEqual([99]);
    // A new key rebuilds from scratch.
    applyLabelOverlayToVisibleNodes(octree, undefined, state([lowX(2)], 'k2'));
    expect(labels(geom)).toEqual([2]);
  });

  it('builds a tile that streamed in after the last pass', () => {
    const first = makeGeometry([[0, 0, 0]]);
    const nodes = [makeNode(first)];
    const octree = makeOctree(nodes);
    const s = state([lowX(5)], 'k1');
    applyLabelOverlayToVisibleNodes(octree, undefined, s);

    const late = makeGeometry([[0.1, 0, 0]]);
    nodes.push(makeNode(late));
    applyLabelOverlayToVisibleNodes(octree, undefined, s);
    expect(labels(late)).toEqual([5]);
  });

  it('starts a post-commit tile from the octree\'s own committed column', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]], {
      manual_class: new THREE.BufferAttribute(new Float32Array([4, 4]), 1),
    });
    const octree = makeOctree([makeNode(geom)]);
    applyLabelOverlayToVisibleNodes(octree, undefined, state([]), 'manual_class');
    expect(labels(geom)).toEqual([4, 4]);
  });

  it('clears the overlay from every tile', () => {
    const geom = makeGeometry([[0, 0, 0]], {
      intensity: new THREE.BufferAttribute(new Float32Array([3]), 1),
    });
    const octree = makeOctree([makeNode(geom)]);
    applyLabelOverlayToVisibleNodes(octree, undefined, state([lowX(1)]));
    clearLabelOverlayFromVisibleNodes(octree);
    expect(geom.attributes[LABEL_ATTRIBUTE]).toBeUndefined();
    expect((geom.attributes.intensity.array as Float32Array)[0]).toBe(3);
  });

  it('tolerates a missing visibleNodes list', () => {
    expect(() => applyLabelOverlayToVisibleNodes(null, undefined, state([]))).not.toThrow();
    expect(() => clearLabelOverlayFromVisibleNodes({})).not.toThrow();
  });
});

describe('publishLabelOverlayStats', () => {
  it('publishes a narrow painted/total fact for E2E', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0], [0.2, 0, 0]]);
    const octree = makeOctree([makeNode(geom)]);
    applyLabelOverlayToVisibleNodes(octree, undefined, state([lowX(3)], 'kx'));
    const stats = (globalThis as any).__labelOverlay;
    expect(stats).toEqual({ painted: 2, total: 3, tiles: 1, key: 'kx' });
  });

  it('counts nothing painted before any stroke', () => {
    const geom = makeGeometry([[0, 0, 0], [1, 0, 0]]);
    const octree = makeOctree([makeNode(geom)]);
    applyLabelOverlayToVisibleNodes(octree, undefined, state([], 'k0'));
    expect((globalThis as any).__labelOverlay.painted).toBe(0);
  });

  it('is a no-op with no octree', () => {
    publishLabelOverlayStats(null, state([]));
    expect((globalThis as any).__labelOverlay).toBeUndefined();
  });
});
