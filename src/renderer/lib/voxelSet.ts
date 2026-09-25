/**
 * The `voxel_set` region: a piece picked with the label tool's click-to-pick,
 * carried as explicit voxels rather than as "segment N of some segmentation".
 * That is what makes undo/redo and the live preview exact: nothing is
 * recomputed, whatever was edited since. Mirrors `label_segments.voxel_set_mask`;
 * both are pinned to src/shared/voxelSet.contract.json.
 */
import * as THREE from 'three';

export interface VoxelSetRegion {
  kind: 'voxel_set';
  voxel: number;
  origin: [number, number, number];
  /** base64 little-endian int32 (i, j, k) triplets. */
  keys: string;
  invert?: boolean;
}

export function decodeVoxelKeys(b64: string): Int32Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Int32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));
}

const keyOf = (i: number, j: number, k: number) => `${i},${j},${k}`;

/** Membership: floor((p - origin) / voxel) is one of the keys. */
export function voxelSetPredicate(r: VoxelSetRegion): (x: number, y: number, z: number) => boolean {
  const k = decodeVoxelKeys(r.keys);
  const set = new Set<string>();
  for (let n = 0; n + 2 < k.length; n += 3) set.add(keyOf(k[n], k[n + 1], k[n + 2]));
  const [ox, oy, oz] = r.origin;
  const v = r.voxel;
  const invert = !!r.invert;
  return (x, y, z) => set.has(keyOf(
    Math.floor((x - ox) / v), Math.floor((y - oy) / v), Math.floor((z - oz) / v),
  )) !== invert;
}

/** World AABB of the set, so the overlay can skip tiles it cannot touch. */
export function voxelSetAabb(r: VoxelSetRegion): THREE.Box3 | null {
  if (r.invert) return null;
  const k = decodeVoxelKeys(r.keys);
  if (k.length < 3) return null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let n = 0; n + 2 < k.length; n += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], k[n + a]);
      hi[a] = Math.max(hi[a], k[n + a]);
    }
  }
  const [ox, oy, oz] = r.origin;
  const v = r.voxel;
  return new THREE.Box3(
    new THREE.Vector3(ox + lo[0] * v, oy + lo[1] * v, oz + lo[2] * v),
    new THREE.Vector3(ox + (hi[0] + 1) * v, oy + (hi[1] + 1) * v, oz + (hi[2] + 1) * v),
  );
}
