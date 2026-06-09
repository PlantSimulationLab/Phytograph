import { useMemo, useEffect } from 'react';
import * as THREE from 'three';

// Wireframe grid overlay for the unit-cube voxel mesh.
// Draws all internal grid lines for an Nx*Ny*Nz subdivision in local space [-0.5, 0.5]^3
// so the parent group's per-axis scale stretches the grid with the voxel.
export interface VoxelGridOverlayProps {
  subdivisions: { x: number; y: number; z: number };
  color?: string;
}

export function VoxelGridOverlay({ subdivisions, color = '#94a3b8' }: VoxelGridOverlayProps) {
  const geometry = useMemo(() => {
    const nx = Math.max(1, Math.floor(subdivisions.x));
    const ny = Math.max(1, Math.floor(subdivisions.y));
    const nz = Math.max(1, Math.floor(subdivisions.z));
    const xs = Array.from({ length: nx + 1 }, (_, i) => -0.5 + i / nx);
    const ys = Array.from({ length: ny + 1 }, (_, i) => -0.5 + i / ny);
    const zs = Array.from({ length: nz + 1 }, (_, i) => -0.5 + i / nz);
    const verts: number[] = [];
    // Lines along Z at each (x, y) grid intersection
    for (const x of xs) for (const y of ys) verts.push(x, y, -0.5, x, y, 0.5);
    // Lines along Y at each (x, z) grid intersection
    for (const x of xs) for (const z of zs) verts.push(x, -0.5, z, x, 0.5, z);
    // Lines along X at each (y, z) grid intersection
    for (const y of ys) for (const z of zs) verts.push(-0.5, y, z, 0.5, y, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    return geo;
  }, [subdivisions.x, subdivisions.y, subdivisions.z]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  // This is a non-occluding overlay: it must draw on top of everything without
  // hiding geometry behind it. `depthTest={false}` makes the lines always draw,
  // but LineBasicMaterial defaults `depthWrite` to true — and with the test
  // disabled, three.js would stamp the lines' (near-camera) depth across the
  // grid volume. Transparent objects are sorted by camera distance, so from
  // some view angles the grid renders before the triangulated mesh and that
  // stamped depth then fails the mesh's depth test, making ALL its triangles
  // vanish (the reported +X-view bug). Disabling depthWrite keeps the overlay
  // purely additive and leaves the depth buffer untouched.
  // renderOrder 2 keeps the grid lines drawing after the translucent voxel-box
  // faces (renderOrder 1) and the surface mesh (0), so the wireframe stays
  // crisply on top in the transparent pass.
  return (
    <lineSegments geometry={geometry} renderOrder={2}>
      <lineBasicMaterial color={color} transparent opacity={0.85} depthTest={false} depthWrite={false} />
    </lineSegments>
  );
}
