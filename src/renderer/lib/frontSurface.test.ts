import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import contract from '../../shared/frontSurface.contract.json';
import {
  buildDepthLimit, decodeFloat32, depthLimitPredicate, encodeFloat32, forEachDrawnPoint,
  MAX_DEPTH_CELLS, pixelWorldSize, type DepthLimit,
} from './frontSurface';

describe('depthLimitPredicate — the shared contract', () => {
  // backend-api/tests/test_front_surface.py asserts the same vectors against
  // _depth_limit_mask: the preview must label exactly what the session will.
  it('matches every golden vector', () => {
    const test = depthLimitPredicate(contract.limit as DepthLimit);
    expect(contract.points.map(([x, y, z]) => test(x, y, z))).toEqual(contract.expected);
  });
});

describe('float32 base64', () => {
  it('round-trips, including infinity', () => {
    const a = new Float32Array([1.5, Infinity, -2, 0]);
    expect(Array.from(decodeFloat32(encodeFloat32(a)))).toEqual([1.5, Infinity, -2, 0]);
  });
});

// Camera at z = 10 looking down, over a 200 x 200 canvas.
const cam = (ortho: boolean) => {
  const c = ortho
    ? new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    : new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  c.position.set(0, 0, 10);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  return { projection: c.projectionMatrix.toArray(), view: c.matrixWorldInverse.toArray() };
};
const canvas = { width: 200, height: 200 };
const everywhere: Array<[number, number]> = [[0, 0], [200, 0], [200, 200], [0, 200]];

/** A 0.02-spaced sheet at height z over x, y in [-0.5, 0.5]. */
const sheet = (z: number): Array<[number, number, number]> => {
  const out: Array<[number, number, number]> = [];
  for (let i = -25; i <= 25; i++) for (let j = -25; j <= 25; j++) out.push([i * 0.02, j * 0.02, z]);
  return out;
};
const visitAll = (pts: Array<[number, number, number]>) =>
  (v: (x: number, y: number, z: number) => void) => pts.forEach(([x, y, z]) => v(x, y, z));

describe('buildDepthLimit', () => {
  for (const ortho of [true, false]) {
    it(`keeps the front sheet and drops the one behind it (${ortho ? 'ortho' : 'perspective'})`, () => {
      const { projection, view } = cam(ortho);
      const front = sheet(2);
      const back = sheet(0);
      const limit = buildDepthLimit(everywhere, projection, view, canvas, visitAll([...front, ...back]))!;
      const test = depthLimitPredicate(limit);
      expect(front.every(([x, y, z]) => test(x, y, z))).toBe(true);
      // The back sheet is hidden where the front sheet covers it — which, from
      // above, is everywhere the back sheet projects (it is further away, so it
      // projects no larger).
      expect(back.filter(([x, y, z]) => test(x, y, z)).length).toBe(0);
    });
  }

  it('lets the back surface through where nothing is in front of it', () => {
    const { projection, view } = cam(true);
    const front = sheet(2).filter(([x]) => x < 0);   // covers only the left half
    const back = sheet(0);
    const test = depthLimitPredicate(
      buildDepthLimit(everywhere, projection, view, canvas, visitAll([...front, ...back]))!);
    expect(back.filter(([x, y, z]) => x > 0.1 && test(x, y, z)).length)
      .toBe(back.filter(([x]) => x > 0.1).length);
    expect(back.filter(([x, y, z]) => x < -0.1 && test(x, y, z)).length).toBe(0);
  });

  it('fills the gaps a sparse LOD tile leaves, so the back sheet cannot show through', () => {
    const { projection, view } = cam(true);
    // Front sheet at 0.06 spacing — about 6 px apart on screen, wider than a cell.
    const front = sheet(2).filter((_, i) => i % 3 === 0);
    const back = sheet(0).filter(([x, y]) => Math.abs(x) < 0.4 && Math.abs(y) < 0.4);
    const test = depthLimitPredicate(
      buildDepthLimit(everywhere, projection, view, canvas, visitAll([...front, ...back]))!);
    expect(back.filter(([x, y, z]) => test(x, y, z)).length).toBe(0);
  });

  it('adds the tolerance, and an allowance of two cells at that depth', () => {
    const { projection, view } = cam(false);
    const limit = buildDepthLimit([[90, 90], [110, 110]], projection, view, canvas,
      visitAll([[0, 0, 2]]), 0.5)!;
    const t = decodeFloat32(limit.thresholds);
    const k = Math.floor((100 - limit.y0) / limit.cell) * limit.cols + Math.floor((100 - limit.x0) / limit.cell);
    expect(t[k]).toBeCloseTo(8 + 0.5 + 2 * limit.cell * pixelWorldSize(projection, 200, 8), 4);
  });

  it('grows its cells to stay within the budget on a huge outline', () => {
    const { projection, view } = cam(true);
    const big = { width: 4000, height: 3000 };
    const limit = buildDepthLimit([[0, 0], [4000, 3000]], projection, view, big, () => {})!;
    expect(limit.cols * limit.rows).toBeLessThanOrEqual(MAX_DEPTH_CELLS * 1.05);
  });

  it('is null for an outline entirely off the canvas', () => {
    const { projection, view } = cam(true);
    expect(buildDepthLimit([[-50, -50], [-10, -10]], projection, view, canvas, () => {})).toBeNull();
  });
});

describe('forEachDrawnPoint', () => {
  it('visits visible tiles only, in world, and honours keep', () => {
    const tile = (xs: number[], visible: boolean, children: any[] = []) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(xs.flatMap((x) => [x, 0, 0]), 3));
      const p = new THREE.Points(g);
      p.visible = visible;
      p.position.set(1, 0, 0);
      p.updateMatrixWorld(true);
      return { sceneNode: p, children, isTreeNode: true };
    };
    const root = tile([0, 1], true, [tile([5], false), tile([7, 8], true)]);
    const seen: number[] = [];
    forEachDrawnPoint(root, { x: 100, y: 0, z: 0 }, (x) => x !== 109)((x) => seen.push(x));
    expect(seen).toEqual([101, 102, 108]);
  });
});
