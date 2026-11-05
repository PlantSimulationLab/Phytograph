// Mesh import axes, Blender-style: the user says which of the FILE's axes
// points up and which points forward, and the mesh is rotated so those land on
// Phytograph's own up (+Z) and forward (+Y).
//
// Why it is needed: Phytograph's world is Z-up, and a mesh's vertices are
// imported exactly as the file has them. Many tools write Y-up (OBJ by
// convention, most game/DCC exports), so such a mesh lands lying on its side.
//
// The conversion is applied as the mesh's initial ROTATION (the value the
// transform panel shows and edits, recorded in the same undoable add), not
// baked into the vertices: the file's own coordinates stay untouched and the
// choice stays visible and reversible.

import * as THREE from 'three';

export type MeshAxis = 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z';
export const MESH_AXES: MeshAxis[] = ['X', 'Y', 'Z', '-X', '-Y', '-Z'];

export interface MeshAxes {
  up: MeshAxis;
  forward: MeshAxis;
}

// Phytograph's own convention: identity, i.e. today's import unchanged.
export const DEFAULT_MESH_AXES: MeshAxes = { up: 'Z', forward: 'Y' };

function vec(a: MeshAxis): THREE.Vector3 {
  const s = a.startsWith('-') ? -1 : 1;
  const k = a.slice(-1);
  return new THREE.Vector3(k === 'X' ? s : 0, k === 'Y' ? s : 0, k === 'Z' ? s : 0);
}

/** Forward must be perpendicular to up (not the same axis, nor its opposite). */
export function axesCompatible(up: MeshAxis, forward: MeshAxis): boolean {
  return up.slice(-1) !== forward.slice(-1);
}

/**
 * The forward axis to use once `up` changes: `current` when it still works,
 * otherwise the conventional partner — a Y-up file faces -Z (the OBJ and
 * Blender convention), and an X- or Z-up file faces Y.
 */
export function forwardFor(up: MeshAxis, current: MeshAxis): MeshAxis {
  if (axesCompatible(up, current)) return current;
  if (up.endsWith('Y')) return '-Z';
  return 'Y';
}

export function isMeshAxes(v: unknown): v is MeshAxes {
  const o = v as MeshAxes | null;
  return !!o && MESH_AXES.includes(o.up) && MESH_AXES.includes(o.forward) && axesCompatible(o.up, o.forward);
}

/**
 * The rotation taking file coordinates into Phytograph's (+Z up, +Y forward):
 * file `up` -> +Z, file `forward` -> +Y, and file right (forward x up) -> +X.
 * Those three rows form a proper rotation for any perpendicular pair, so a
 * mesh is never mirrored. Returned as XYZ Euler degrees, the form the mesh
 * transform stores (meshWorldMatrix).
 */
export function meshAxesRotationMatrix({ up, forward }: MeshAxes): THREE.Matrix4 {
  if (!axesCompatible(up, forward)) throw new Error(`Forward (${forward}) must differ from up (${up})`);
  const u = vec(up);
  const f = vec(forward);
  const r = new THREE.Vector3().crossVectors(f, u);
  return new THREE.Matrix4().set(
    r.x, r.y, r.z, 0,
    f.x, f.y, f.z, 0,
    u.x, u.y, u.z, 0,
    0, 0, 0, 1,
  );
}

export function meshAxesRotationDeg(axes: MeshAxes): { x: number; y: number; z: number } {
  const e = new THREE.Euler().setFromRotationMatrix(meshAxesRotationMatrix(axes), 'XYZ');
  // Clean -0 and float dust (89.99999999 -> 90) so the transform panel shows
  // the round angle the conversion actually is.
  const clean = (rad: number) => {
    const d = Math.round(THREE.MathUtils.radToDeg(rad) * 1e6) / 1e6;
    return Object.is(d, -0) ? 0 : d;
  };
  return { x: clean(e.x), y: clean(e.y), z: clean(e.z) };
}

export function isIdentityAxes(axes: MeshAxes): boolean {
  return axes.up === 'Z' && axes.forward === 'Y';
}
