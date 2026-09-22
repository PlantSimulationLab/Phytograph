import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  projectionKindOf,
  isOrthographicProjection,
  pickPixelForNdc,
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
  it('points along the camera forward axis at the view centre', () => {
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

  it('DIVERGES through the eye under perspective', () => {
    // The bug this replaces: the direction used to be the camera forward under
    // BOTH projections, with the offset near-plane origin expected to carry the
    // cursor position. It cannot — the near plane is 0.1 units from the eye
    // here, so an off-centre origin is ~0.07 units off-axis on a ray travelling
    // hundreds of units dead ahead. Every pick landed on whatever sat at the
    // CENTRE of the viewport, which froze the label brush's sphere mid-scene.
    const cam = perspectiveCamera();
    const center = rayForNdc(cam, { x: 0, y: 0 });
    const corner = rayForNdc(cam, { x: 0.8, y: 0.8 });
    // Rays through the eye all share one origin...
    expect(corner.origin.distanceTo(cam.position)).toBeCloseTo(0, 6);
    expect(center.origin.distanceTo(cam.position)).toBeCloseTo(0, 6);
    // ...and it is the DIRECTION that carries the cursor. Unmissably so: the
    // corner ray leans up and to the right, not straight ahead.
    expect(corner.direction.x).toBeGreaterThan(0.2);
    expect(corner.direction.y).toBeGreaterThan(0.2);
    expect(center.direction.z).toBeCloseTo(-1, 6);
  });

  it('a perspective ray hits the world point that is actually under the cursor', () => {
    // The end-to-end property, stated as geometry rather than as component
    // parts: project a known world point to NDC, build the ray for that NDC,
    // and it must pass through the point. The old forward-axis ray misses this
    // by the point's whole lateral offset (2 world units here).
    const cam = perspectiveCamera();
    const target = new THREE.Vector3(2, 1.5, 0);
    const ndc = target.clone().project(cam);
    const ray = rayForNdc(cam, { x: ndc.x, y: ndc.y });
    expect(ray.distanceToPoint(target)).toBeCloseTo(0, 6);
  });

  it('an ortho ray hits the world point that is actually under the cursor', () => {
    const cam = overriddenCamera();
    const target = new THREE.Vector3(2, 1.5, 0);
    const ndc = target.clone().project(cam);
    const ray = rayForNdc(cam, { x: ndc.x, y: ndc.y });
    expect(ray.distanceToPoint(target)).toBeCloseTo(0, 6);
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

describe('pickPixelForNdc', () => {
  // A stand-in for the renderer: potree sizes its pick buffer from
  // clientWidth/Height x pixelRatio, so this helper must agree exactly.
  const renderer = (w: number, h: number, ratio: number) => ({
    domElement: { clientWidth: w, clientHeight: h } as HTMLCanvasElement,
    getPixelRatio: () => ratio,
  });

  it('maps NDC to device pixels, y UP from the bottom', () => {
    const gl = renderer(800, 600, 1);
    expect(pickPixelForNdc(gl, { x: 0, y: 0 })).toMatchObject({ x: 400, y: 300 });
    // NDC y = +1 is the TOP of the screen, which in GL pixel space is the
    // HIGHEST y — the opposite of a clientY. Getting this backwards would put
    // the pick window in the mirror image of the cursor's half of the canvas.
    expect(pickPixelForNdc(gl, { x: -1, y: -1 })).toMatchObject({ x: 0, y: 0 });
    expect(pickPixelForNdc(gl, { x: 1, y: 1 })).toMatchObject({ x: 800, y: 600 });
  });

  it('scales by the device pixel ratio', () => {
    // A retina canvas renders (and reads back) twice as many pixels, so a
    // ratio-blind pixel would sample the lower-left quarter of the viewport.
    expect(pickPixelForNdc(renderer(800, 600, 2), { x: 0, y: 0 }))
      .toMatchObject({ x: 800, y: 600 });
  });

  it('writes into the supplied target rather than allocating', () => {
    const target = new THREE.Vector3();
    const out = pickPixelForNdc(renderer(800, 600, 1), { x: 0, y: 0 }, target);
    expect(out).toBe(target);
  });
});
