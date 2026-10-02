import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { visibleContentDepth } from './visibleDepth';

const FOV = 50;
const ASPECT = 16 / 9;
const TAN = Math.tan((FOV * Math.PI) / 360);

/** A camera at `eye` looking at `at`, returning its view matrix elements. */
function viewOf(eye: [number, number, number], at: [number, number, number]): number[] {
  const cam = new THREE.PerspectiveCamera(FOV, ASPECT, 0.1, 1000);
  cam.up.set(0, 0, 1);
  cam.position.set(...eye);
  cam.lookAt(...at);
  cam.updateMatrixWorld();
  return Array.from(cam.matrixWorldInverse.elements);
}

/** A filled wall of points facing +y, `depth` in front of a camera at the origin. */
function wall(depth: number, halfW: number, halfH: number, n = 40): Array<[number, number, number]> {
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      pts.push([(i / (n - 1) - 0.5) * 2 * halfW, depth, (j / (n - 1) - 0.5) * 2 * halfH]);
    }
  }
  return pts;
}

const visitor = (pts: Array<[number, number, number]>) =>
  (visit: (x: number, y: number, z: number) => void) => { for (const p of pts) visit(p[0], p[1], p[2]); };

describe('visibleContentDepth', () => {
  const view = viewOf([0, 0, 0], [0, 1, 0]);

  it('returns the depth of a surface filling the view', () => {
    const d = visibleContentDepth(visitor(wall(12, 20, 20)), view, TAN, ASPECT);
    expect(d).toBeCloseTo(12, 6);
  });

  it('reports the FRONT surface, not what lies behind it', () => {
    // Same screen footprint at both depths: the far wall is fully hidden.
    const pts = [...wall(5, 5 * TAN * ASPECT, 5 * TAN), ...wall(50, 50 * TAN * ASPECT, 50 * TAN)];
    expect(visibleContentDepth(visitor(pts), view, TAN, ASPECT)).toBeCloseTo(5, 6);
  });

  it('is weighted by screen area, not by point count', () => {
    // A million-to-one density imbalance: a tiny dense clump up close against a
    // sparse wall covering the view. The wall owns the screen, so it wins.
    const clump: Array<[number, number, number]> = [];
    for (let i = 0; i < 20000; i++) clump.push([0.001 * (i % 7), 1, 0.001 * (i % 5)]);
    const d = visibleContentDepth(visitor([...clump, ...wall(30, 60, 60, 60)]), view, TAN, ASPECT);
    expect(d).toBeCloseTo(30, 6);
  });

  it('follows what is in the middle of the view, not what covers most of it', () => {
    // A subject mid-screen at 6 against a backdrop at 40 that owns ~90% of the
    // viewport. A plain median over the screen says 40 and the subject changes
    // size when the view flattens; the subject's own depth is the answer.
    const subject = wall(6, 6 * TAN * ASPECT * 0.3, 6 * TAN * 0.3);
    const d = visibleContentDepth(visitor([...subject, ...wall(40, 80, 80, 80)]), view, TAN, ASPECT);
    expect(d).toBeCloseTo(6, 6);
  });

  it('falls back to off-center content when the middle of the view is empty', () => {
    const pts = wall(9, 2, 2).map(([x, y, z]) => [x + 5, y, z] as [number, number, number]);
    expect(visibleContentDepth(visitor(pts), view, TAN, ASPECT)).toBeCloseTo(9, 6);
  });

  it('ignores points behind the camera and outside the frustum', () => {
    const pts: Array<[number, number, number]> = [
      ...wall(8, 3, 3),
      [0, -2, 0], // behind
      [500, 8, 0], // far off to the side
    ];
    expect(visibleContentDepth(visitor(pts), view, TAN, ASPECT)).toBeCloseTo(8, 6);
  });

  it('measures depth along the view axis for an off-origin, oblique camera', () => {
    const eye: [number, number, number] = [10, -10, 8];
    const at: [number, number, number] = [0, 0, 0];
    const dist = Math.hypot(...eye);
    // A small patch at the look-at point: every sample sits ~dist down the axis.
    const pts: Array<[number, number, number]> = [];
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) pts.push([i * 0.01, j * 0.01, 0]);
    const d = visibleContentDepth(visitor(pts), viewOf(eye, at), TAN, ASPECT);
    expect(d).not.toBeNull();
    expect(Math.abs((d as number) - dist)).toBeLessThan(0.05);
  });

  it('returns null when nothing is on screen', () => {
    expect(visibleContentDepth(visitor([]), view, TAN, ASPECT)).toBeNull();
    expect(visibleContentDepth(visitor([[0, -5, 0]]), view, TAN, ASPECT)).toBeNull();
  });
});
