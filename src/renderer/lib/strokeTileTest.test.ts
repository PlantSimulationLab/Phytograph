import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { screenStrokeTileTest } from './strokeTileTest';
import type { PendingDeleteRegion } from './pointCloudTypes';

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// Identity projection and view: world x,y ARE ndc, so on a 100x100 canvas the
// pixel is ((x+1)*50, (1-y)*50).
const lasso = (projection = I): PendingDeleteRegion => ({
  kind: 'polygon',
  points: [[0, 0], [50, 0], [50, 50], [0, 50]],   // the top-left quarter
  projection, view: I, canvas: { width: 100, height: 100 },
} as unknown as PendingDeleteRegion);
const box = (x0: number, y0: number, x1: number, y1: number, z0 = -0.5, z1 = -0.4) =>
  new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));

describe('screenStrokeTileTest', () => {
  it('keeps a tile inside the lasso and rejects one wholly outside it', () => {
    const test = screenStrokeTileTest(lasso())!;
    expect(test(box(-0.9, 0.5, -0.5, 0.9))).toBe(true);      // top-left
    expect(test(box(0.5, -0.9, 0.9, -0.5))).toBe(false);     // bottom-right
    expect(test(box(-0.1, -0.1, 0.1, 0.1))).toBe(true);      // straddles the corner
  });

  it('keeps a tile it cannot project (a corner behind the camera)', () => {
    // A perspective row: clip w = -z, so z > 0 is behind the camera.
    const persp = [...I]; persp[11] = -1; persp[15] = 0;
    const test = screenStrokeTileTest(lasso(persp))!;
    expect(test(box(0.5, -0.9, 0.9, -0.5, -0.1, 0.2))).toBe(true);
  });

  it('offers no test for a stroke that is not screen-space', () => {
    expect(screenStrokeTileTest({ kind: 'box', min: [0, 0, 0], max: [1, 1, 1] } as never))
      .toBeUndefined();
  });
});
