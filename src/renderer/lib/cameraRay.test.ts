import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  projectionKindOf,
  isOrthographicProjection,
  rayForNdc,
  worldPerPixelAt,
} from './cameraRay';

// A perspective and an orthographic camera with the SAME framing, used
// throughout: 800x600, looking down -Z from +Z at the origin.
function perspectiveCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

function orthographicCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 1000);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

/**
 * The case this whole module exists for: a PerspectiveCamera INSTANCE whose
 * projectionMatrix has been overwritten with an orthographic one in place, as
 * OrthoProjectionOverride does. `isPerspectiveCamera` stays true.
 */
function overriddenCamera(): THREE.PerspectiveCamera {
  const cam = perspectiveCamera();
  cam.projectionMatrix.makeOrthographic(-4, 4, 3, -3, 0.1, 1000);
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  return cam;
}

describe('projectionKindOf', () => {
  it('identifies a perspective matrix', () => {
    expect(projectionKindOf(perspectiveCamera().projectionMatrix.elements))
      .toBe('perspective');
  });

  it('identifies an orthographic matrix', () => {
    expect(projectionKindOf(orthographicCamera().projectionMatrix.elements))
      .toBe('orthographic');
  });

  it('reads the MATRIX, not the camera class, on an overridden camera', () => {
    // The regression this guards: branching on isPerspectiveCamera here would
    // report 'perspective' and every downstream pick would be center-biased.
    const cam = overriddenCamera();
    expect(cam.isPerspectiveCamera).toBe(true);
    expect(projectionKindOf(cam.projectionMatrix.elements)).toBe('orthographic');
  });

  it('accepts a plain number[] (a frozen region projection)', () => {
    // Crop/erase regions store the matrix as a plain array; the E2E
    // data-*-projection-kind diagnostics read it back in this form.
    const frozen = Array.from(orthographicCamera().projectionMatrix.elements);
    expect(projectionKindOf(frozen)).toBe('orthographic');
  });

  it('isOrthographicProjection agrees with projectionKindOf', () => {
    const ortho = orthographicCamera().projectionMatrix.elements;
    const persp = perspectiveCamera().projectionMatrix.elements;
    expect(isOrthographicProjection(ortho)).toBe(true);
    expect(isOrthographicProjection(persp)).toBe(false);
  });
});

describe('rayForNdc', () => {
  it('points along the camera forward axis', () => {
    const ray = rayForNdc(perspectiveCamera(), { x: 0, y: 0 });
    expect(ray.direction.x).toBeCloseTo(0, 6);
    expect(ray.direction.y).toBeCloseTo(0, 6);
    expect(ray.direction.z).toBeCloseTo(-1, 6);
  });

  it('gives PARALLEL rays under an orthographic projection', () => {
    // The defining property of ortho picking, and exactly what
    // Raycaster.setFromCamera gets wrong on an overridden camera.
    const cam = overriddenCamera();
    const center = rayForNdc(cam, { x: 0, y: 0 });
    const corner = rayForNdc(cam, { x: 0.8, y: 0.8 });
    expect(corner.direction.x).toBeCloseTo(center.direction.x, 6);
    expect(corner.direction.y).toBeCloseTo(center.direction.y, 6);
    expect(corner.direction.z).toBeCloseTo(center.direction.z, 6);
    // ...and their origins are laterally offset, which is what makes the ray
    // land under the cursor rather than collapsing toward the view center.
    expect(corner.origin.x).toBeGreaterThan(center.origin.x + 1);
    expect(corner.origin.y).toBeGreaterThan(center.origin.y + 1);
  });

  it('offsets the near-plane origin under perspective too', () => {
    // Documented contract: the direction is ALWAYS the camera forward axis,
    // under both projections. That is exact for ortho and "good enough for
    // picking" under perspective, where the origin lands on the near plane
    // beneath the cursor. This test pins the origin behaviour so a future
    // change to true per-pixel perspective directions is a deliberate one.
    const cam = perspectiveCamera();
    const center = rayForNdc(cam, { x: 0, y: 0 });
    const corner = rayForNdc(cam, { x: 0.8, y: 0.8 });
    expect(corner.origin.x).toBeGreaterThan(center.origin.x);
    expect(corner.origin.y).toBeGreaterThan(center.origin.y);
    expect(corner.direction.z).toBeCloseTo(-1, 6);
  });

  it('an ortho ray through an off-center NDC passes through the expected world x', () => {
    // Frustum is [-4,4] in x, so ndc.x = 0.5 is world x = 2.
    const ray = rayForNdc(overriddenCamera(), { x: 0.5, y: 0 });
    expect(ray.origin.x).toBeCloseTo(2, 5);
  });

  it('writes into the supplied target ray rather than allocating', () => {
    const target = new THREE.Ray();
    const out = rayForNdc(perspectiveCamera(), { x: 0, y: 0 }, target);
    expect(out).toBe(target);
  });
});

describe('worldPerPixelAt', () => {
  it('is constant with distance under orthographic', () => {
    const cam = overriddenCamera();
    const near = worldPerPixelAt(cam, new THREE.Vector3(0, 0, 9), 800, 600);
    const far = worldPerPixelAt(cam, new THREE.Vector3(0, 0, -90), 800, 600);
    expect(far.x).toBeCloseTo(near.x, 10);
    expect(far.y).toBeCloseTo(near.y, 10);
    // 8 world units across 800px.
    expect(near.x).toBeCloseTo(0.01, 10);
    expect(near.y).toBeCloseTo(0.01, 10);
  });

  it('grows with distance under perspective', () => {
    const cam = perspectiveCamera();
    const near = worldPerPixelAt(cam, new THREE.Vector3(0, 0, 5), 800, 600);
    const far = worldPerPixelAt(cam, new THREE.Vector3(0, 0, -10), 800, 600);
    // Distance from the eye at z=10 is 5 vs 20 — a 4x span.
    expect(far.y / near.y).toBeCloseTo(4, 4);
  });

  it('clamps a degenerate zero distance rather than dividing by zero', () => {
    const cam = perspectiveCamera();
    const atEye = worldPerPixelAt(cam, cam.position.clone(), 800, 600);
    expect(Number.isFinite(atEye.x)).toBe(true);
    expect(Number.isFinite(atEye.y)).toBe(true);
  });

  it('returns zeros for a zero-sized canvas', () => {
    const cam = perspectiveCamera();
    expect(worldPerPixelAt(cam, new THREE.Vector3(), 0, 0)).toEqual({ x: 0, y: 0 });
  });
});
