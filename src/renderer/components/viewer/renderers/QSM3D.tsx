import { useMemo, useEffect } from 'react';
import * as THREE from 'three';
import type { QSMCylinder } from '../../../utils/backendApi';

// QSM (Quantitative Structure Model) visualization. Each cylinder is rendered at
// its TRUE fitted radius (frustum between start and end). Two color modes make the
// headline feature legible:
//   - 'rank'  : color by shoot rank (trunk=0, scaffolds=1, ...) -- the structure.
//   - 'shoot' : a distinct color per shoot id, so each continuous shoot reads as
//               ONE object -- directly demonstrates the continuous-shoot output.
// A selected shoot is highlighted (its cylinders brightened) so hovering/clicking
// a shoot shows the whole continuous axis.

export type QSMColorMode = 'rank' | 'shoot';

export interface QSM3DProps {
  cylinders: QSMCylinder[];
  colorMode?: QSMColorMode;
  /** shoot_id to highlight (the whole continuous axis), or null. */
  selectedShootId?: number | null;
  opacity?: number;
  /** radial resolution of each cylinder (more = smoother, costlier). */
  radialSegments?: number;
}

// Rank palette: trunk (0) dark/woody -> outward orders brighten. Index by rank,
// clamped. Chosen to read as "thick dark trunk, lighter branches".
export const RANK_COLORS = [
  new THREE.Color('#5b3a1e'), // rank 0 trunk - dark brown
  new THREE.Color('#c2761a'), // rank 1 scaffold - amber
  new THREE.Color('#3b82f6'), // rank 2 - blue
  new THREE.Color('#22c55e'), // rank 3 - green
  new THREE.Color('#a855f7'), // rank 4 - violet
  new THREE.Color('#ec4899'), // rank 5+ - pink
];

export function rankColor(rank: number): THREE.Color {
  const idx = Math.min(Math.max(rank, 0), RANK_COLORS.length - 1);
  return RANK_COLORS[idx];
}

// Deterministic distinct color per shoot id via the golden-ratio hue rotation
// (so adjacent shoot ids look clearly different, and the same id always maps to
// the same color across renders).
export function shootColor(shootId: number): THREE.Color {
  const hue = (shootId * 0.61803398875) % 1.0;
  return new THREE.Color().setHSL(hue, 0.62, 0.55);
}

export function QSM3D({
  cylinders,
  colorMode = 'rank',
  selectedShootId = null,
  opacity = 1.0,
  radialSegments = 8,
}: QSM3DProps) {
  const geometry = useMemo(() => {
    if (!cylinders || cylinders.length === 0) return null;

    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    let indexOffset = 0;

    const start = new THREE.Vector3();
    const end = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const up = new THREE.Vector3();
    const perp1 = new THREE.Vector3();
    const perp2 = new THREE.Vector3();
    const tmp = new THREE.Color();

    for (const c of cylinders) {
      start.set(c.start[0], c.start[1], c.start[2]);
      end.set(c.end[0], c.end[1], c.end[2]);
      dir.subVectors(end, start);
      const length = dir.length();
      if (length < 1e-5 || c.radius <= 0) continue;
      dir.normalize();

      // Perpendicular frame for the ring.
      up.set(0, 1, 0);
      if (Math.abs(dir.y) > 0.99) up.set(1, 0, 0);
      perp1.crossVectors(dir, up).normalize();
      perp2.crossVectors(dir, perp1).normalize();

      // Color for this cylinder. A selected shoot is brightened; non-selected
      // cylinders dim slightly when a selection is active so the axis pops.
      const base =
        colorMode === 'shoot' ? shootColor(c.shoot_id) : rankColor(c.rank);
      tmp.copy(base);
      if (selectedShootId != null) {
        if (c.shoot_id === selectedShootId) {
          tmp.lerp(new THREE.Color('#ffffff'), 0.35); // highlight
        } else {
          tmp.lerp(new THREE.Color('#000000'), 0.55); // dim others
        }
      }

      for (let ring = 0; ring <= 1; ring++) {
        const center = ring === 0 ? start : end;
        for (let j = 0; j < radialSegments; j++) {
          const angle = (j / radialSegments) * Math.PI * 2;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const nx = cos * perp1.x + sin * perp2.x;
          const ny = cos * perp1.y + sin * perp2.y;
          const nz = cos * perp1.z + sin * perp2.z;
          positions.push(
            center.x + c.radius * nx,
            center.y + c.radius * ny,
            center.z + c.radius * nz
          );
          normals.push(nx, ny, nz);
          colors.push(tmp.r, tmp.g, tmp.b);
        }
      }

      for (let j = 0; j < radialSegments; j++) {
        const j1 = (j + 1) % radialSegments;
        const a = indexOffset + j;
        const b = indexOffset + j1;
        const cc = indexOffset + radialSegments + j;
        const d = indexOffset + radialSegments + j1;
        indices.push(a, cc, b);
        indices.push(b, cc, d);
      }
      indexOffset += radialSegments * 2;
    }

    if (positions.length === 0) return null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    return geo;
  }, [cylinders, colorMode, selectedShootId, radialSegments]);

  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        transparent: opacity < 1,
        opacity,
        roughness: 0.7,
        metalness: 0.1,
      }),
    [opacity]
  );

  useEffect(() => () => geometry?.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  if (!geometry) return null;
  return <mesh geometry={geometry} material={material} />;
}
