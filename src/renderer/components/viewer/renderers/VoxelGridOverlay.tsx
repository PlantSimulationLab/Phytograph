import { useMemo, useEffect } from 'react';
import * as THREE from 'three';

// Wireframe grid overlay for the unit-cube voxel mesh.
// Draws all internal grid lines for an Nx*Ny*Nz subdivision in local space [-0.5, 0.5]^3
// so the parent group's per-axis scale stretches the grid with the voxel.
//
// Terrain following ("snap to ground"): when `columnLocalOffsets` is supplied
// (one LOCAL-z offset per (x,y) column, row-major [j*nx + i]; see
// gridColumnLocalOffsets), each column's vertical extent is shifted by its offset,
// producing an undulating grid that follows the ground. Columns flagged dropped in
// `keptMask` (0) are omitted. The offset is purely vertical and the parent group's
// only rotation is azimuthal (about +z), so the shift is rotation-invariant —
// matching how the backend bakes z then rotates.
export interface VoxelGridOverlayProps {
  subdivisions: { x: number; y: number; z: number };
  color?: string;
  columnLocalOffsets?: Float32Array;  // len nx*ny, row-major [j*nx+i], local-z units
  keptMask?: Uint8Array;              // len nx*ny; 0 = dropped column (not drawn)
}

export function VoxelGridOverlay({ subdivisions, color = '#94a3b8', columnLocalOffsets, keptMask }: VoxelGridOverlayProps) {
  const geometry = useMemo(() => {
    const nx = Math.max(1, Math.floor(subdivisions.x));
    const ny = Math.max(1, Math.floor(subdivisions.y));
    const nz = Math.max(1, Math.floor(subdivisions.z));
    const verts: number[] = [];

    const hasOffsets = columnLocalOffsets != null && columnLocalOffsets.length === nx * ny;

    if (!hasOffsets) {
      // Flat grid — the original full set of axis-aligned grid lines.
      const xs = Array.from({ length: nx + 1 }, (_, i) => -0.5 + i / nx);
      const ys = Array.from({ length: ny + 1 }, (_, i) => -0.5 + i / ny);
      const zs = Array.from({ length: nz + 1 }, (_, i) => -0.5 + i / nz);
      for (const x of xs) for (const y of ys) verts.push(x, y, -0.5, x, y, 0.5);
      for (const x of xs) for (const z of zs) verts.push(x, -0.5, z, x, 0.5, z);
      for (const y of ys) for (const z of zs) verts.push(-0.5, y, z, 0.5, y, z);
    } else {
      // Terrain-following grid: draw each kept column as its own little wireframe
      // box, shifted vertically by its per-column offset. This renders the
      // undulating bottom exactly (and omits dropped columns) without trying to
      // bridge horizontal lines across columns at different heights.
      const off = columnLocalOffsets!;
      const x0 = (i: number) => -0.5 + i / nx;
      const y0 = (j: number) => -0.5 + j / ny;
      const zEdges = Array.from({ length: nz + 1 }, (_, k) => -0.5 + k / nz);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const col = j * nx + i;
          if (keptMask && keptMask.length === nx * ny && keptMask[col] === 0) continue;
          const dz = off[col];
          const xa = x0(i), xb = x0(i + 1);
          const ya = y0(j), yb = y0(j + 1);
          // Vertical edges at the 4 corners of the column.
          for (const [cx, cy] of [[xa, ya], [xb, ya], [xb, yb], [xa, yb]] as const) {
            verts.push(cx, cy, -0.5 + dz, cx, cy, 0.5 + dz);
          }
          // Horizontal rings at each z subdivision (top, bottom, and internal cells).
          for (const ze of zEdges) {
            const z = ze + dz;
            verts.push(xa, ya, z, xb, ya, z);
            verts.push(xb, ya, z, xb, yb, z);
            verts.push(xb, yb, z, xa, yb, z);
            verts.push(xa, yb, z, xa, ya, z);
          }
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    return geo;
  }, [subdivisions.x, subdivisions.y, subdivisions.z, columnLocalOffsets, keptMask]);

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
