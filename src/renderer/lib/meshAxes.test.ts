import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  DEFAULT_MESH_AXES,
  MESH_AXES,
  axesCompatible,
  forwardFor,
  isIdentityAxes,
  isMeshAxes,
  meshAxesRotationDeg,
  meshAxesRotationMatrix,
  type MeshAxis,
} from './meshAxes';
import { meshWorldMatrix } from './meshTransform';

const v = (a: MeshAxis) => {
  const s = a.startsWith('-') ? -1 : 1;
  const k = a.slice(-1);
  return new THREE.Vector3(k === 'X' ? s : 0, k === 'Y' ? s : 0, k === 'Z' ? s : 0);
};
const close = (a: THREE.Vector3, b: THREE.Vector3) => a.distanceTo(b) < 1e-9;

describe('mesh import axes', () => {
  it('the default is Phytograph\'s own frame: no rotation at all', () => {
    expect(isIdentityAxes(DEFAULT_MESH_AXES)).toBe(true);
    expect(meshAxesRotationDeg(DEFAULT_MESH_AXES)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('a Y-up, -Z-forward file (OBJ / Blender convention) is turned +90° about X', () => {
    expect(meshAxesRotationDeg({ up: 'Y', forward: '-Z' })).toEqual({ x: 90, y: 0, z: 0 });
  });

  it('for every valid pair, file up lands on +Z and file forward on +Y, never mirrored', () => {
    for (const up of MESH_AXES) {
      for (const forward of MESH_AXES) {
        if (!axesCompatible(up, forward)) continue;
        const m = meshAxesRotationMatrix({ up, forward });
        expect(close(v(up).applyMatrix4(m), new THREE.Vector3(0, 0, 1)), `${up}/${forward} up`).toBe(true);
        expect(close(v(forward).applyMatrix4(m), new THREE.Vector3(0, 1, 0)), `${up}/${forward} fwd`).toBe(true);
        expect(m.determinant()).toBeCloseTo(1, 9);
      }
    }
  });

  it('the Euler angles reproduce the same rotation through the mesh transform', () => {
    // The rotation is stored as XYZ Euler degrees and rebuilt by
    // meshWorldMatrix; a round trip that lost the order would tip the mesh.
    for (const up of MESH_AXES) {
      for (const forward of MESH_AXES) {
        if (!axesCompatible(up, forward)) continue;
        const world = meshWorldMatrix({ x: 0, y: 0, z: 0 }, meshAxesRotationDeg({ up, forward }), { x: 1, y: 1, z: 1 });
        expect(close(v(up).applyMatrix4(world), new THREE.Vector3(0, 0, 1)), `${up}/${forward}`).toBe(true);
        expect(close(v(forward).applyMatrix4(world), new THREE.Vector3(0, 1, 0)), `${up}/${forward}`).toBe(true);
      }
    }
  });

  it('refuses a forward parallel to up, and picks a conventional partner', () => {
    expect(axesCompatible('Y', '-Y')).toBe(false);
    expect(() => meshAxesRotationMatrix({ up: 'Z', forward: 'Z' })).toThrow();
    expect(forwardFor('Y', 'Y')).toBe('-Z');
    expect(forwardFor('-Y', 'Y')).toBe('-Z');
    expect(forwardFor('X', 'X')).toBe('Y');
    expect(forwardFor('Y', 'X')).toBe('X'); // still valid: kept
  });

  it('validates a remembered choice read back from the store', () => {
    expect(isMeshAxes({ up: 'Y', forward: '-Z' })).toBe(true);
    expect(isMeshAxes({ up: 'Y', forward: 'Y' })).toBe(false);
    expect(isMeshAxes({ up: 'W', forward: 'Y' })).toBe(false);
    expect(isMeshAxes(null)).toBe(false);
  });
});
