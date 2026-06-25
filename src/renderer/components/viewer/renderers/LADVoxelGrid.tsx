import { useMemo, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
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
  // Azimuthal rotation of the grid box about +z (degrees). Helios returns voxel
  // centers UNROTATED, so we both rotate each center about `gridCenter` AND orient
  // each cube by this angle, so a rotated LAD result aligns with the original grid
  // mesh. 0 = axis-aligned.
  rotationDeg?: number;
  // World-space pivot the centers rotate about. Required for rotationDeg to have
  // any visible effect; when omitted (or rotationDeg 0) the centers are unchanged.
  gridCenter?: [number, number, number];
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
  rotationDeg = 0,
  gridCenter,
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

  // Write per-instance transforms + colors into a given mesh. Kept as a stable
  // callback so it can be driven from BOTH the ref callback (on every R3F
  // (re)assignment of the InstancedMesh) and a layout effect (on prop-only
  // changes while the mesh identity is stable). Driving it only from a
  // dep-array effect was the source of a "grid sometimes missing after
  // inversion" bug: when R3F re-created the mesh (its key={drawn.length}, or a
  // reconciliation re-create during the addLad batch), the new mesh was handed
  // to meshRef.current but the fill effect didn't re-run — its deps were
  // referentially unchanged — so the fresh mesh kept zero-matrix instances and
  // nothing drew until a visibility toggle remounted the component.
  const fillMesh = useCallback((mesh: THREE.InstancedMesh | null) => {
    if (!mesh) return;
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    // The grid's azimuthal rotation about +z (CCW, matching three.js rotation.z
    // and the Helios <grid>). Helios returns voxel CENTERS unrotated (the rotation
    // lives per-cell and is honored only in its physics), so we replicate Helios's
    // own visualizer: rotate each center about the grid center, AND orient the
    // cube by the same angle. With no pivot (or 0deg) the centers are unchanged.
    const theta = THREE.MathUtils.degToRad(rotationDeg);
    const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), theta);
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    const rotate = gridCenter != null && Math.abs(rotationDeg) > 1e-9;
    const pos = new THREE.Vector3();
    for (let i = 0; i < drawn.length; i++) {
      const v = drawn[i];
      pos.set(v.center[0], v.center[1], v.center[2]);
      if (rotate) {
        // Rotate the center about gridCenter (about +z), CCW — identical to
        // Helios's rotatePointAboutLine(center, anchor, +z, rotation).
        const dx = pos.x - gridCenter![0];
        const dy = pos.y - gridCenter![1];
        pos.x = gridCenter![0] + dx * cosT - dy * sinT;
        pos.y = gridCenter![1] + dx * sinT + dy * cosT;
      }
      m.compose(
        pos,
        quat,
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
  }, [drawn, rotationDeg, gridCenter, colormap, min, max]);

  // (1) Re-fill when render inputs change while the mesh identity is stable
  //     (colorbar drag, colormap switch, rotation tweak, hide-empty toggle that
  //     keeps the count). useLayoutEffect, not useEffect, so the buffers are
  //     populated before paint — no one-frame flash of an unfilled mesh.
  useLayoutEffect(() => {
    fillMesh(meshRef.current);
  }, [fillMesh]);

  // (2) Re-fill the instant R3F (re)assigns a new InstancedMesh — covers the
  //     initial mount AND every remount (key={drawn.length} change, or a
  //     reconciliation re-create during the addLad batch). This is the case the
  //     deps-driven effect alone missed.
  const setMeshRef = useCallback((mesh: THREE.InstancedMesh | null) => {
    meshRef.current = mesh;
    fillMesh(mesh);
  }, [fillMesh]);

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
      ref={setMeshRef}
      // Re-key so the instance buffers resize when the cell count changes.
      key={drawn.length}
      args={[geometry, undefined, drawn.length]}
      onPointerMove={onHoverVoxel ? handleMove : undefined}
      onPointerOut={onHoverVoxel ? handleOut : undefined}
      onClick={onClickVoxel ? handleClick : undefined}
    >
      {/* At full opacity the cells are genuinely opaque and MUST write depth,
          or the GPU draws instances in arbitrary order and the ground grid +
          other cells bleed through (the "some voxels look transparent" bug).
          Only enable alpha blending (and disable depth writes, which order-
          independent transparency needs) when the user actually dials opacity
          below 1. */}
      <meshStandardMaterial
        // Remount the material when transparency toggles — three.js needs a
        // shader recompile (needsUpdate) when `transparent` flips; re-keying is
        // the clean R3F way to force it.
        key={opacity < 1 ? 'translucent' : 'opaque'}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity >= 1}
        roughness={0.9}
        metalness={0}
      />
    </instancedMesh>
  );
}
