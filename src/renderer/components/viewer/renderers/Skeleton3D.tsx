import { useMemo, useEffect } from 'react';
import * as THREE from 'three';
import type { SkeletonData } from '../../../lib/pointCloudTypes';

// Skeleton visualization component - renders skeleton as connected tubes
export interface Skeleton3DProps {
  data: SkeletonData;
  color?: string;
  opacity?: number;
  tubeRadius?: number;
  showDiameters?: boolean;
  colorByBranchOrder?: boolean;
}

// Branch order color palette (from high order/trunk to low order/tips)
export const BRANCH_ORDER_COLORS = [
  new THREE.Color('#dc2626'),  // Order 1 (tips) - red
  new THREE.Color('#f97316'),  // Order 2 - orange
  new THREE.Color('#eab308'),  // Order 3 - yellow
  new THREE.Color('#22c55e'),  // Order 4 - green
  new THREE.Color('#06b6d4'),  // Order 5 - cyan
  new THREE.Color('#3b82f6'),  // Order 6 - blue
  new THREE.Color('#8b5cf6'),  // Order 7 - violet
  new THREE.Color('#ec4899'),  // Order 8+ (trunk) - pink
];

export function Skeleton3D({ data, color = '#f59e0b', opacity = 1.0, tubeRadius = 0.02, showDiameters = false, colorByBranchOrder = false }: Skeleton3DProps) {
  const geometry = useMemo(() => {
    // Get all skeleton points
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < data.pointCount; i++) {
      points.push(new THREE.Vector3(
        data.points[i * 3],
        data.points[i * 3 + 1],
        data.points[i * 3 + 2]
      ));
    }

    if (points.length < 2) return null;

    // If we have edges, render each edge as a cylinder
    if (data.edges && data.edges.length > 0) {
      const mergedGeometry = new THREE.BufferGeometry();
      const positions: number[] = [];
      const normals: number[] = [];
      const colors: number[] = [];
      const indices: number[] = [];
      let indexOffset = 0;

      // Create cylinder geometry for each edge
      const radialSegments = 6;  // Segments around the cylinder

      // Helper to get color for a branch order
      const getOrderColor = (order: number): THREE.Color => {
        const idx = Math.min(order - 1, BRANCH_ORDER_COLORS.length - 1);
        return BRANCH_ORDER_COLORS[Math.max(0, idx)];
      };

      for (const edge of data.edges) {
        const [fromIdx, toIdx] = edge;
        if (fromIdx >= points.length || toIdx >= points.length) continue;

        const start = points[fromIdx];
        const end = points[toIdx];
        const direction = new THREE.Vector3().subVectors(end, start);
        const length = direction.length();

        if (length < 0.0001) continue;  // Skip zero-length edges

        // Normalize direction
        direction.normalize();

        // Find perpendicular vectors for the circle
        const up = Math.abs(direction.y) < 0.99
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(1, 0, 0);
        const perp1 = new THREE.Vector3().crossVectors(direction, up).normalize();
        const perp2 = new THREE.Vector3().crossVectors(direction, perp1).normalize();

        // Create vertices for start and end circles
        const radius = showDiameters && data.diameters
          ? (data.diameters[fromIdx] + data.diameters[toIdx]) / 4
          : tubeRadius;

        // Get branch order colors for this edge
        const fromOrder = data.branchOrders ? data.branchOrders[fromIdx] || 1 : 1;
        const toOrder = data.branchOrders ? data.branchOrders[toIdx] || 1 : 1;
        const fromColor = getOrderColor(fromOrder);
        const toColor = getOrderColor(toOrder);

        // Generate circle vertices at start and end
        for (let ring = 0; ring <= 1; ring++) {
          const center = ring === 0 ? start : end;
          const edgeColor = ring === 0 ? fromColor : toColor;
          for (let j = 0; j < radialSegments; j++) {
            const angle = (j / radialSegments) * Math.PI * 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);

            // Position on circle
            const px = center.x + radius * (cos * perp1.x + sin * perp2.x);
            const py = center.y + radius * (cos * perp1.y + sin * perp2.y);
            const pz = center.z + radius * (cos * perp1.z + sin * perp2.z);
            positions.push(px, py, pz);

            // Normal pointing outward from center
            const nx = cos * perp1.x + sin * perp2.x;
            const ny = cos * perp1.y + sin * perp2.y;
            const nz = cos * perp1.z + sin * perp2.z;
            normals.push(nx, ny, nz);

            // Vertex color based on branch order
            colors.push(edgeColor.r, edgeColor.g, edgeColor.b);
          }
        }

        // Create indices for cylinder faces
        for (let j = 0; j < radialSegments; j++) {
          const j1 = (j + 1) % radialSegments;
          // Two triangles per quad
          const a = indexOffset + j;
          const b = indexOffset + j1;
          const c = indexOffset + radialSegments + j;
          const d = indexOffset + radialSegments + j1;
          indices.push(a, c, b);
          indices.push(b, c, d);
        }

        indexOffset += radialSegments * 2;
      }

      if (positions.length === 0) return null;

      mergedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      mergedGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      mergedGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      mergedGeometry.setIndex(indices);

      return mergedGeometry;
    }

    // Fallback: if no edges, create a simple curve (legacy behavior)
    const curve = new THREE.CatmullRomCurve3(points);
    const radius = showDiameters && data.diameters
      ? data.diameters[Math.floor(data.pointCount / 2)] / 2
      : tubeRadius;
    return new THREE.TubeGeometry(curve, Math.max(8, data.pointCount * 4), radius, 8, false);
  }, [data, tubeRadius, showDiameters, colorByBranchOrder]);

  const material = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: colorByBranchOrder ? 0xffffff : new THREE.Color(color),
      vertexColors: colorByBranchOrder,
      transparent: opacity < 1,
      opacity,
      roughness: 0.6,
      metalness: 0.2,
    });
  }, [color, opacity, colorByBranchOrder]);

  useEffect(() => () => { geometry?.dispose(); }, [geometry]);
  useEffect(() => () => { material.dispose(); }, [material]);

  if (!geometry) return null;

  return <mesh geometry={geometry} material={material} />;
}
