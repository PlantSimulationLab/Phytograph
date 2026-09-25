import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import contract from '../../shared/profileLine.contract.json';
import {
  profileLinePredicate, profileLineRegion, screenToProfile, type PolylineHalfspaceRegion,
} from './profileLine';
import { projectWorldToCanvasPixel } from './cropGeometry';
import type { SlabRegion } from './crossSection';

describe('profileLinePredicate — the shared contract', () => {
  // backend-api/tests/test_profile_line.py asserts the same cases against
  // _region_mask: the preview must label exactly what the session will.
  for (const c of contract.cases as Array<{
    name: string; region: PolylineHalfspaceRegion; points?: number[][]; expected: boolean[];
  }>) {
    it(c.name, () => {
      const test = profileLinePredicate(c.region);
      const pts = (c.points ?? contract.points) as number[][];
      expect(pts.map(([x, y, z]) => test(x, y, z))).toEqual(c.expected);
    });
  }
});

describe('screenToProfile', () => {
  const slab: SlabRegion = {
    kind: 'slab', a: { x: 0, y: 2 }, b: { x: 10, y: 2 }, depth: 1, zMin: 0, zMax: 5, offset: 0.5,
  };
  const canvas = { width: 800, height: 600 };

  const roundTrip = (camera: THREE.Camera, world: THREE.Vector3) => {
    camera.updateMatrixWorld();
    const projection = camera.projectionMatrix.toArray();
    const view = camera.matrixWorldInverse.toArray();
    const px = projectWorldToCanvasPixel(world, projection, view, canvas)!;
    return screenToProfile(px.x, px.y, projection, view, canvas, slab);
  };

  it('recovers [along, z] of a point on the section plane — face-on ortho', () => {
    const cam = new THREE.OrthographicCamera(-8, 8, 6, -6, 0.1, 100);
    cam.up.set(0, 0, 1);
    cam.position.set(5, 2.5 - 20, 2);   // in front of the plane y = 2.5, looking +y
    cam.lookAt(5, 2.5, 2);
    const p = roundTrip(cam, new THREE.Vector3(3, 2.5, 1.25))!;
    expect(p[0]).toBeCloseTo(3, 6);
    expect(p[1]).toBeCloseTo(1.25, 6);
  });

  it('lands on the plane (not the point) for an oblique perspective ray', () => {
    const cam = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 200);
    cam.up.set(0, 0, 1);
    cam.position.set(-4, -15, 6);
    cam.lookAt(5, 2.5, 2);
    // A point ON the plane (offset 0.5 from y = 2) round-trips exactly.
    const p = roundTrip(cam, new THREE.Vector3(7, 2.5, 3))!;
    expect(p[0]).toBeCloseTo(7, 5);
    expect(p[1]).toBeCloseTo(3, 5);
  });

  it('is null when the view is edge-on to the section', () => {
    const cam = new THREE.OrthographicCamera(-8, 8, 6, -6, 0.1, 100);
    cam.up.set(0, 0, 1);
    cam.position.set(-20, 2.5, 2);   // looking along +x, i.e. along the section
    cam.lookAt(5, 2.5, 2);
    cam.updateMatrixWorld();
    expect(screenToProfile(400, 300, cam.projectionMatrix.toArray(),
      cam.matrixWorldInverse.toArray(), canvas, slab)).toBeNull();
  });
});

describe('profileLineRegion', () => {
  const slab: SlabRegion = {
    kind: 'slab', a: { x: 1, y: 2 }, b: { x: 3, y: 4 }, depth: 1, zMin: 0, zMax: 5, offset: 2,
  };
  it('takes the section frame and drops an empty band', () => {
    expect(profileLineRegion(slab, [[0, 1], [2, 3]], 'above', null)).toEqual({
      kind: 'polyline_halfspace', a: [1, 2], b: [3, 4], line: [[0, 1], [2, 3]], side: 'above',
    });
    expect(profileLineRegion(slab, [[0, 1], [2, 3]], 'below', 0)).not.toHaveProperty('band');
    expect(profileLineRegion(slab, [[0, 1], [2, 3]], 'near', 0.3).band).toBe(0.3);
  });
});
