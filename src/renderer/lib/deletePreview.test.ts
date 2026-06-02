import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { deleteRegionToClipBoxes, pendingDeletesToClipBoxes } from './deletePreview';
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
