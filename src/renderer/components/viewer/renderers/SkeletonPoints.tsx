import { useMemo, useEffect } from 'react';
import * as THREE from 'three';
import type { SkeletonData } from '../../../lib/pointCloudTypes';
import { BRANCH_ORDER_COLORS } from './Skeleton3D';

// Skeleton visualization as node points only
export interface SkeletonPointsProps {
  data: SkeletonData;
  color?: string;
  pointSize?: number;
  colorByBranchOrder?: boolean;
}

export function SkeletonPoints({ data, color = '#f59e0b', pointSize = 8, colorByBranchOrder = false }: SkeletonPointsProps) {
  const geometry = useMemo(() => {
    // Early return if no points
    if (!data.points || data.pointCount === 0) {
      return null;
    }

    const geo = new THREE.BufferGeometry();
    // Clone the points array to avoid issues with shared references
    const positions = new Float32Array(data.points);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const colors = new Float32Array(data.pointCount * 3);

    if (colorByBranchOrder && data.branchOrders) {
      for (let i = 0; i < data.pointCount; i++) {
        const order = data.branchOrders[i] || 1;
        const idx = Math.min(order - 1, BRANCH_ORDER_COLORS.length - 1);
        const orderColor = BRANCH_ORDER_COLORS[Math.max(0, idx)];
        colors[i * 3] = orderColor.r;
        colors[i * 3 + 1] = orderColor.g;
        colors[i * 3 + 2] = orderColor.b;
      }
    } else {
      const baseColor = new THREE.Color(color);
      for (let i = 0; i < data.pointCount; i++) {
        colors[i * 3] = baseColor.r;
        colors[i * 3 + 1] = baseColor.g;
        colors[i * 3 + 2] = baseColor.b;
      }
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
    return geo;
  }, [data, color, colorByBranchOrder]);

  const material = useMemo(() => {
    return new THREE.PointsMaterial({
      size: pointSize,
      vertexColors: true,
      sizeAttenuation: false,
    });
  }, [pointSize]);

  useEffect(() => () => { geometry?.dispose(); }, [geometry]);
  useEffect(() => () => { material.dispose(); }, [material]);

  // Return null if geometry couldn't be created
  if (!geometry) return null;

  return <points geometry={geometry} material={material} />;
}
