import { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { LADVoxel } from '../../../lib/pointCloudTypes';
import { sampleColormap, type ColormapName } from '../../../lib/colormaps';
import { ladColorT } from '../../../lib/pointCloudHelpers';

// Renders a leaf-area-density result as instanced, translucent voxel cells in
// world space, each colored by its LAD value through the shared colormap.
// Empty cells (no hits / lad<=0) are hidden when `hideEmpty`, else drawn faint
// gray. Hover/click report the voxel under the cursor so the caller can show a
// value readout.
export interface LADVoxelGridProps {
  voxels: LADVoxel[];
  colormap: ColormapName;
  min: number;            // colorbar domain low
  max: number;            // colorbar domain high
  opacity: number;        // 0..1 cell translucency
  hideEmpty: boolean;
  onHoverVoxel?: (v: LADVoxel | null) => void;
  onClickVoxel?: (v: LADVoxel | null) => void;
}

const EMPTY_COLOR = new THREE.Color('#3a3a3a');

export function LADVoxelGrid({
  voxels,
  colormap,
  min,
  max,
  opacity,
  hideEmpty,
  onHoverVoxel,
  onClickVoxel,
}: LADVoxelGridProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  // The cells actually drawn (after the hide-empty filter). We keep the mapping
  // back to the original voxel so instanceId → voxel is correct for hover/click.
  const drawn = useMemo(
    () => voxels.filter(v => !hideEmpty || (v.hitCount > 0 && v.lad > 0)),
    [voxels, hideEmpty],
  );

  const geometry = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Write per-instance transforms + colors whenever inputs change.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    for (let i = 0; i < drawn.length; i++) {
      const v = drawn[i];
      m.compose(
        new THREE.Vector3(v.center[0], v.center[1], v.center[2]),
        new THREE.Quaternion(),
        new THREE.Vector3(v.size[0], v.size[1], v.size[2]),
      );
      mesh.setMatrixAt(i, m);
      if (v.hitCount === 0 || v.lad <= 0) {
        color.copy(EMPTY_COLOR);
      } else {
        const rgb = sampleColormap(colormap, ladColorT(v.lad, min, max));
        color.setRGB(rgb[0], rgb[1], rgb[2]);
      }
      mesh.setColorAt(i, color);
    }
    mesh.count = drawn.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [drawn, colormap, min, max]);

  const handleMove = (e: ThreeEvent<PointerEvent>) => {
    if (!onHoverVoxel) return;
    e.stopPropagation();
    const id = e.instanceId;
    onHoverVoxel(id != null && id < drawn.length ? drawn[id] : null);
  };

  const handleOut = () => onHoverVoxel?.(null);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    if (!onClickVoxel) return;
    e.stopPropagation();
    const id = e.instanceId;
    onClickVoxel(id != null && id < drawn.length ? drawn[id] : null);
  };

  if (drawn.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      // Re-key so the instance buffers resize when the cell count changes.
      key={drawn.length}
      args={[geometry, undefined, drawn.length]}
      onPointerMove={onHoverVoxel ? handleMove : undefined}
      onPointerOut={onHoverVoxel ? handleOut : undefined}
      onClick={onClickVoxel ? handleClick : undefined}
    >
      <meshStandardMaterial
        transparent
        opacity={opacity}
        depthWrite={false}
        roughness={0.9}
        metalness={0}
      />
    </instancedMesh>
  );
}
