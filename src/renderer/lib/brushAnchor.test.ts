import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { brushAnchorAt, type PickableOctree } from './brushAnchor';

/** A plane of points at height y, x,z in [-1, 1]. */
function plane(y: number): THREE.Points {
  const pos: number[] = [];
  for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) pos.push(i / 5, y, j / 5);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Points(g);
}

/** An "octree" whose GPU pick misses (the sparse-cloud case), holding `tiles`. */
function octreeOf(tiles: THREE.Object3D[], pick = vi.fn(() => null)): PickableOctree {
  const g = new THREE.Group() as unknown as PickableOctree;
  tiles.forEach((t) => g.add(t));
  (g as any).pick = pick;
  return g;
}

const camera = new THREE.PerspectiveCamera();
camera.position.set(0, 10, 0);
const down = new THREE.Ray(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, -1, 0));
const args = (octree: PickableOctree | null) => ({
  octree, gl: {} as THREE.WebGLRenderer, camera, ray: down,
  pixelPosition: new THREE.Vector3(), viewDist: 10, cpuPointBudget: 1e6,
  isOverlay: () => false,
});

describe('brushAnchorAt', () => {
  it('asks the GPU pick for visible points only, and uses its hit', () => {
    const pick = vi.fn(() => ({ position: { x: 0, y: 3, z: 0 } }));
    const hit = brushAnchorAt(args(octreeOf([plane(0)], pick)));
    expect(pick.mock.calls[0][3]).toMatchObject({ pickOutsideClipRegion: false });
    expect(hit?.y).toBe(3);
  });

  it('the CPU fallback anchors on the TARGET, not a cloud in front of it', () => {
    // Another cloud's plane sits between the camera and the target. Raycasting
    // the whole scene anchored on it, where the target has no points at all.
    const scene = new THREE.Scene();
    const target = octreeOf([plane(0)]);
    scene.add(plane(5), target);
    scene.updateMatrixWorld(true);
    const hit = brushAnchorAt(args(target));
    expect(hit).not.toBeNull();
    expect(Math.abs(hit!.y)).toBeLessThan(0.5);
  });

  it('has no anchor without a target cloud', () => {
    expect(brushAnchorAt(args(null))).toBeNull();
  });

  it('skips the CPU pass above its point budget', () => {
    const target = octreeOf([plane(0)]);
    target.updateMatrixWorld(true);
    expect(brushAnchorAt({ ...args(target), cpuPointBudget: 10 })).toBeNull();
  });
});
