import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  deleteRegionToClipBoxes,
  pendingDeletesToClipBoxes,
  pendingDeletesToCropMaskRules,
  splitDeletesByClipBudget,
  MAX_CLIP_BOXES,
} from './deletePreview';
import { cropRulesKeep } from './cropGeometry';
import type { PendingDeleteRegion } from './pointCloudTypes';

// A clip box matrix maps world → box space; a point is "inside" (CLIP_INSIDE
// removes it) iff applying the INVERSE lands it in the unit cube [-0.5,0.5]^3.
function isInside(matrix: THREE.Matrix4, p: THREE.Vector3): boolean {
  const inv = new THREE.Matrix4().copy(matrix).invert();
  const q = p.clone().applyMatrix4(inv);
  return Math.abs(q.x) <= 0.5 + 1e-6 && Math.abs(q.y) <= 0.5 + 1e-6 && Math.abs(q.z) <= 0.5 + 1e-6;
}

describe('deleteRegionToClipBoxes — box', () => {
  const region: PendingDeleteRegion = {
    kind: 'box',
    min: [0, 0, 0],
    max: [2, 4, 6],
    invert: false,
  };

  it('produces one box matrix', () => {
    expect(deleteRegionToClipBoxes(region)).toHaveLength(1);
  });

  it('contains points inside the AABB and excludes points outside', () => {
    const [m] = deleteRegionToClipBoxes(region);
    // Center of the box is inside.
    expect(isInside(m, new THREE.Vector3(1, 2, 3))).toBe(true);
    // Just inside each face.
    expect(isInside(m, new THREE.Vector3(0.01, 2, 3))).toBe(true);
    expect(isInside(m, new THREE.Vector3(1.99, 2, 3))).toBe(true);
    // Outside the box on each axis.
    expect(isInside(m, new THREE.Vector3(-0.5, 2, 3))).toBe(false);
    expect(isInside(m, new THREE.Vector3(1, 5, 3))).toBe(false);
    expect(isInside(m, new THREE.Vector3(1, 2, 7))).toBe(false);
  });

  it('returns no boxes for an inverted (keep-complement) region', () => {
    // Inverted box deletes "everything outside" — handled by bake, not preview.
    expect(deleteRegionToClipBoxes({ ...region, invert: true })).toHaveLength(0);
  });
});

describe('deleteRegionToClipBoxes — squares_union', () => {
  // Build a simple orthographic camera looking down -Z so projection/view are
  // well-conditioned for the screen→world unprojection.
  const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  cam.position.set(0, 0, 20);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const projection = cam.projectionMatrix.toArray();
  const view = cam.matrixWorldInverse.toArray();
  const canvas = { width: 200, height: 200 };

  it('produces one box per square stamp', () => {
    const region: PendingDeleteRegion = {
      kind: 'squares_union',
      centers: [[100, 100], [50, 50]],
      half_sizes: [10, 10],
      projection, view, canvas,
      invert: false,
    };
    const boxes = deleteRegionToClipBoxes(region);
    expect(boxes).toHaveLength(2);
    // Each is a finite, invertible matrix.
    for (const m of boxes) {
      expect(m.elements.every(Number.isFinite)).toBe(true);
      expect(Math.abs(m.determinant())).toBeGreaterThan(0);
    }
  });

  it('a center-screen stamp contains the world origin it projects from', () => {
    // Canvas center (100,100) unprojects to the view axis through origin.
    const region: PendingDeleteRegion = {
      kind: 'squares_union',
      centers: [[100, 100]],
      half_sizes: [20],
      projection, view, canvas,
      invert: false,
    };
    const [m] = deleteRegionToClipBoxes(region);
    expect(isInside(m, new THREE.Vector3(0, 0, 0))).toBe(true);
  });
});

describe('pendingDeletesToClipBoxes', () => {
  it('flattens a stack of regions into one matrix list', () => {
    const stack: PendingDeleteRegion[] = [
      { kind: 'box', min: [0, 0, 0], max: [1, 1, 1], invert: false },
      { kind: 'box', min: [2, 2, 2], max: [3, 3, 3], invert: false },
    ];
    expect(pendingDeletesToClipBoxes(stack)).toHaveLength(2);
  });

  it('skips inverted regions (baked, not previewed)', () => {
    const stack: PendingDeleteRegion[] = [
      { kind: 'box', min: [0, 0, 0], max: [1, 1, 1], invert: true },
      { kind: 'box', min: [2, 2, 2], max: [3, 3, 3], invert: false },
    ];
    expect(pendingDeletesToClipBoxes(stack)).toHaveLength(1);
  });
});

// The other half of the committed-delete preview. `deleteRegionToClipBoxes`
// returns nothing for an INVERTED region — "keep what is inside" cannot be
// expressed as a CLIP_INSIDE union — and that hole is exactly why an applied
// crop used to need the octree rebuilt before its result was visible. These
// clauses close it per point.
describe('pendingDeletesToCropMaskRules', () => {
  const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  cam.position.set(0, 0, 20);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const projection = cam.projectionMatrix.toArray();
  const view = cam.matrixWorldInverse.toArray();
  const canvas = { width: 200, height: 200 };

  it('covers exactly the regions the clip boxes cannot, and nothing they can', () => {
    const stack: PendingDeleteRegion[] = [
      { kind: 'box', min: [0, 0, 0], max: [1, 1, 1], invert: false },  // clip box handles it
      { kind: 'box', min: [2, 2, 2], max: [3, 3, 3], invert: true },   // needs a predicate
    ];
    expect(pendingDeletesToClipBoxes(stack)).toHaveLength(1);
    expect(pendingDeletesToCropMaskRules(stack)).toHaveLength(1);
  });

  it('takes polygons off the GPU path entirely, in both senses', () => {
    // A box can only approximate a lasso by its bounding rect. That was a blink
    // while the bake ran; with the rebuild in the background it would be the
    // picture for seconds, so a concave lasso would render as its bounding box.
    for (const invert of [false, true]) {
      const stack: PendingDeleteRegion[] = [
        { kind: 'polygon', points: [[50, 50], [150, 50], [150, 150], [50, 150]],
          projection, view, canvas, invert },
      ];
      expect(pendingDeletesToClipBoxes(stack), `invert=${invert}`).toEqual([]);
      expect(pendingDeletesToCropMaskRules(stack), `invert=${invert}`).toHaveLength(1);
    }
  });

  it('a non-inverted polygon DELETES what is inside it (Keep Outside)', () => {
    // The sense flip: a delete region names the points it removes, a mask clause
    // names the ones it keeps. Getting this backwards renders a Keep-Outside
    // crop inside out — the half the user asked to discard is the half left on
    // screen, and nothing else in the app would contradict it until the
    // background rebuild landed.
    const rules = pendingDeletesToCropMaskRules([
      { kind: 'polygon', points: [[50, 50], [150, 50], [150, 150], [50, 150]],
        projection, view, canvas, invert: false },
    ]);
    expect(cropRulesKeep(rules, 0, 0, 0), 'inside the lasso — deleted').toBe(false);
    expect(cropRulesKeep(rules, 8, 0, 0), 'outside the lasso — kept').toBe(true);
  });

  it('an inverted box keeps the points INSIDE it', () => {
    // A crop is "keep inside"; as a delete region that is inverted (delete the
    // complement). Getting this the wrong way round would hide the kept points
    // and draw the cropped-away ones — the crop rendering inside out.
    const rules = pendingDeletesToCropMaskRules([
      { kind: 'box', min: [0, 0, 0], max: [2, 2, 2], invert: true },
    ]);
    expect(cropRulesKeep(rules, 1, 1, 1)).toBe(true);
    expect(cropRulesKeep(rules, 5, 1, 1)).toBe(false);
    expect(cropRulesKeep(rules, 1, 1, -3)).toBe(false);
  });

  it('an inverted polygon keeps the points that project inside it', () => {
    // A square lasso over the middle half of the canvas. Under this orthographic
    // camera, canvas x 50..150 spans world x -5..5.
    const rules = pendingDeletesToCropMaskRules([
      {
        kind: 'polygon',
        points: [[50, 50], [150, 50], [150, 150], [50, 150]],
        projection, view, canvas,
        invert: true,
      },
    ]);
    expect(cropRulesKeep(rules, 0, 0, 0)).toBe(true);
    expect(cropRulesKeep(rules, 8, 0, 0)).toBe(false);
    expect(cropRulesKeep(rules, 0, -8, 0)).toBe(false);
  });

  it('stacks two crops so a point must survive both', () => {
    const rules = pendingDeletesToCropMaskRules([
      { kind: 'box', min: [0, 0, 0], max: [10, 10, 10], invert: true },
      { kind: 'box', min: [5, 0, 0], max: [10, 10, 10], invert: true },
    ]);
    expect(rules).toHaveLength(2);
    expect(cropRulesKeep(rules, 7, 1, 1)).toBe(true);
    expect(cropRulesKeep(rules, 2, 1, 1), 'survived only the first crop').toBe(false);
  });

  it('gives each clause a key that changes with its geometry and its position', () => {
    const a = pendingDeletesToCropMaskRules([
      { kind: 'box', min: [0, 0, 0], max: [1, 1, 1], invert: true },
    ])[0];
    const b = pendingDeletesToCropMaskRules([
      { kind: 'box', min: [0, 0, 0], max: [2, 1, 1], invert: true },
    ])[0];
    expect(a.key).not.toBe(b.key);
    // Stack position too: two identical crops applied in a row are two entries
    // and must not collapse to one key, or undoing one would leave the tile
    // masks unchanged.
    const pair = pendingDeletesToCropMaskRules([
      { kind: 'box', min: [0, 0, 0], max: [1, 1, 1], invert: true },
      { kind: 'box', min: [0, 0, 0], max: [1, 1, 1], invert: true },
    ]);
    expect(pair[0].key).not.toBe(pair[1].key);
  });

  it('ignores the erase and label brushes, which the clip volume already hides', () => {
    const stack: PendingDeleteRegion[] = [
      {
        kind: 'squares_union',
        centers: [[100, 100]], half_sizes: [20],
        projection, view, canvas, invert: false,
      },
    ];
    expect(pendingDeletesToCropMaskRules(stack)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shader's clip-box budget
// ---------------------------------------------------------------------------
//
// potree's vertex shader is a fixed `mat4[30]` (`#define max_clip_boxes 30`),
// not sized from the count we pass, and `setClipBoxes` does not clamp. Handing
// it more makes the uniform upload INVALID_VALUE and WebGL drops the WHOLE
// array — so past 30 boxes NOTHING is clipped and every deleted point draws
// again, over a backend that has already deleted them. The erase brush reaches
// this in one drag: one box per stamp, stamped at half-brush pitch.

describe('splitDeletesByClipBudget', () => {
  const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  cam.position.set(0, 0, 20);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  const projection = cam.projectionMatrix.toArray();
  const view = cam.matrixWorldInverse.toArray();
  const canvas = { width: 200, height: 200 };

  const stamps = (n: number, x0 = 0): PendingDeleteRegion => ({
    kind: 'squares_union',
    centers: Array.from({ length: n }, (_, i) => [x0 + i, 100] as [number, number]),
    half_sizes: [4],
    projection, view, canvas,
    invert: false,
  });

  it('keeps a small stack entirely on the GPU', () => {
    const stack = [stamps(3), stamps(4)];
    const { gpu, cpu } = splitDeletesByClipBudget(stack);
    expect(gpu).toHaveLength(2);
    expect(cpu).toHaveLength(0);
  });

  it('never lets the GPU list exceed the shader limit', () => {
    // One drag of the default brush across a wide canvas: ~50 stamps.
    const stack = [stamps(50)];
    const { gpu } = splitDeletesByClipBudget(stack);
    expect(pendingDeletesToClipBoxes(gpu).length).toBeLessThanOrEqual(MAX_CLIP_BOXES);
  });

  it('spills whole regions to the CPU rather than truncating one', () => {
    const stack = [stamps(20, 0), stamps(20, 500)];
    const { gpu, cpu } = splitDeletesByClipBudget(stack);
    expect(gpu).toHaveLength(1);
    expect(cpu).toHaveLength(1);
    expect(pendingDeletesToClipBoxes(gpu).length).toBeLessThanOrEqual(MAX_CLIP_BOXES);
    // The NEWEST region keeps the frame-rate path: it is what the user is
    // looking at, and the live stroke is appended after it.
    expect(gpu[0]).toBe(stack[1]);
    expect(cpu[0]).toBe(stack[0]);
  });

  it('honours a reserve for the live erase stamps', () => {
    const stack = [stamps(25)];
    // 10 live boxes are about to be appended, so only 20 remain for committed.
    const { gpu, cpu } = splitDeletesByClipBudget(stack, MAX_CLIP_BOXES - 10);
    expect(gpu).toHaveLength(0);
    expect(cpu).toHaveLength(1);
  });

  it('does not spend budget on regions that produce no boxes', () => {
    const inverted: PendingDeleteRegion = {
      kind: 'box', min: [0, 0, 0], max: [1, 1, 1], invert: true,
    };
    const { gpu, cpu } = splitDeletesByClipBudget([inverted, stamps(30)]);
    // The inverted region is the CPU path's business already, and must not
    // push the 30 real stamps off the GPU.
    expect(pendingDeletesToClipBoxes(gpu).length).toBe(30);
    expect(cpu).toHaveLength(0);
  });
});

describe('overflow is still hidden, just on the CPU', () => {
  it('a point inside a spilled brush stamp is masked out', () => {
    const cam = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
    cam.position.set(0, 0, 20);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    const projection = cam.projectionMatrix.toArray();
    const view = cam.matrixWorldInverse.toArray();
    const canvas = { width: 200, height: 200 };

    // A stamp over canvas centre, which covers the world origin.
    const region: PendingDeleteRegion = {
      kind: 'squares_union',
      centers: [[100, 100]],
      half_sizes: [20],
      projection, view, canvas,
      invert: false,
    };
    // Treated as overflow: the GPU never got it, so the mask must hide it.
    const rules = pendingDeletesToCropMaskRules([region], [region]);
    expect(rules).toHaveLength(1);
    expect(cropRulesKeep(rules, 0, 0, 0)).toBe(false);          // deleted
    expect(cropRulesKeep(rules, 9.5, 9.5, 0)).toBe(true);       // far corner survives
  });

  it('a spilled sphere brush masks its bounding cube, matching the GPU box', () => {
    const region: PendingDeleteRegion = {
      kind: 'spheres_union',
      centers: [[5, 5, 5]],
      radii: [1],
      invert: false,
    };
    const rules = pendingDeletesToCropMaskRules([region], [region]);
    expect(cropRulesKeep(rules, 5, 5, 5)).toBe(false);          // centre deleted
    expect(cropRulesKeep(rules, 5.9, 5.9, 5.9)).toBe(false);    // cube corner too
    expect(cropRulesKeep(rules, 8, 8, 8)).toBe(true);           // outside survives
  });

  it('a region the GPU DID take is not masked twice', () => {
    const region: PendingDeleteRegion = {
      kind: 'spheres_union', centers: [[0, 0, 0]], radii: [1], invert: false,
    };
    // Not in the overflow list => the clip volume owns it => no CPU rule.
    expect(pendingDeletesToCropMaskRules([region], [])).toHaveLength(0);
  });
});
