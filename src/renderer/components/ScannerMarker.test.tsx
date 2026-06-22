import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { scannerOrientation, decimatePosesForDisplay, MAX_DISPLAY_POSES } from './ScannerMarker';

// The scanner meshes are authored forward-along-+Y. scannerOrientation() returns
// the quaternion the marker group is rotated by, so applying it to the mesh's
// authored forward (+Y) yields where the scanner ends up facing in world space.
const MESH_FORWARD = new THREE.Vector3(0, 1, 0);

function forwardAfter(roll: number, pitch: number, heading: number): THREE.Vector3 {
  const q = scannerOrientation(roll, pitch, heading);
  return MESH_FORWARD.clone().applyQuaternion(q);
}

describe('scannerOrientation', () => {
  it('leaves the body facing +Y at heading 0 with no tilt (identity)', () => {
    const q = scannerOrientation(0, 0, 0);
    // Level + default heading = no rotation at all.
    expect(q.x).toBeCloseTo(0, 6);
    expect(q.y).toBeCloseTo(0, 6);
    expect(q.z).toBeCloseTo(0, 6);
    expect(q.w).toBeCloseTo(1, 6);

    const f = forwardAfter(0, 0, 0);
    expect(f.x).toBeCloseTo(0, 6);
    expect(f.y).toBeCloseTo(1, 6);
    expect(f.z).toBeCloseTo(0, 6);
  });

  it('yaws the forward axis CCW about +Z by the heading', () => {
    // Heading 90° rotates the authored +Y forward to -X.
    const f90 = forwardAfter(0, 0, 90);
    expect(f90.x).toBeCloseTo(-1, 6);
    expect(f90.y).toBeCloseTo(0, 6);
    expect(f90.z).toBeCloseTo(0, 6);

    // Heading -90° rotates +Y forward to +X.
    const fNeg90 = forwardAfter(0, 0, -90);
    expect(fNeg90.x).toBeCloseTo(1, 6);
    expect(fNeg90.y).toBeCloseTo(0, 6);
    expect(fNeg90.z).toBeCloseTo(0, 6);

    // Heading 180° flips forward to -Y.
    const f180 = forwardAfter(0, 0, 180);
    expect(f180.x).toBeCloseTo(0, 6);
    expect(f180.y).toBeCloseTo(-1, 6);
    expect(f180.z).toBeCloseTo(0, 6);
  });

  it('keeps yaw purely horizontal — forward stays in the XY plane', () => {
    for (const heading of [30, 45, 120, 270]) {
      const f = forwardAfter(0, 0, heading);
      expect(f.z).toBeCloseTo(0, 6);
      expect(f.length()).toBeCloseTo(1, 6);
    }
  });

  it('tilts pitch about the heading-rotated forward axis, leaving forward level', () => {
    // Pitch rotates about the body forward axis, so the forward direction itself
    // is unchanged by pitch — only the up/lateral axes tilt. Forward must stay in
    // the XY plane regardless of heading.
    const f = forwardAfter(0, 20, 90);
    expect(f.x).toBeCloseTo(-1, 6);
    expect(f.y).toBeCloseTo(0, 6);
    expect(f.z).toBeCloseTo(0, 6);
  });

  it('rolls about the lateral axis, dipping the forward axis out of plane', () => {
    // Roll rotates about the body lateral axis, which does tip the forward vector
    // out of the horizontal plane. At heading 0 forward = +Y, lateral = +X, so a
    // positive roll about +X drives +Y toward +Z (right-hand rule).
    const f = forwardAfter(20, 0, 0);
    expect(f.z).toBeGreaterThan(0);
    expect(f.length()).toBeCloseTo(1, 6);
  });
});

describe('decimatePosesForDisplay', () => {
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => [i, 0, 0, 0, 0, 0, 1] as
      [number, number, number, number, number, number, number]);

  it('returns the same array reference when under the cap', () => {
    const poses = make(10);
    expect(decimatePosesForDisplay(poses, 24)).toBe(poses);
  });

  it('caps a dense path at the max and keeps first + last', () => {
    const poses = make(400);
    const out = decimatePosesForDisplay(poses, 24);
    expect(out).toHaveLength(24);
    expect(out[0][0]).toBe(0);            // first pose kept
    expect(out[out.length - 1][0]).toBe(399); // last pose kept
    // Evenly spaced (monotonic, no duplicates beyond rounding).
    for (let i = 1; i < out.length; i++) expect(out[i][0]).toBeGreaterThan(out[i - 1][0]);
  });

  it('defaults to MAX_DISPLAY_POSES', () => {
    expect(decimatePosesForDisplay(make(1000)).length).toBe(MAX_DISPLAY_POSES);
  });

  it('handles an empty path', () => {
    expect(decimatePosesForDisplay([])).toEqual([]);
  });
});
