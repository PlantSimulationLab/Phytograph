import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { SCENE_OVERLAY } from '../../../lib/sceneOverlay';
import { screenRegionOutline } from '../../../lib/cropGeometry';

// The committed polygon lasso, drawn as the volume it selects.
//
// The lasso used to be redrawn as a 2-D ring at its draw-time pixels, which is
// only true from the draw pose — so the camera had to be locked for as long as
// a region was set. This draws the region's real 3-D outline (the cone swept by
// the lasso from the draw-time eye, see `screenRegionOutline`) inside the
// scene, so it tracks the camera like any other geometry and the view can stay
// free. From the pose it was drawn at it looks exactly like the traced ring.
//
// SCENE_OVERLAY keeps it out of the zoom depth probe, as with the other
// wireframes.
export function ScreenRegionOutline({
  region,
  bounds,
  displayOffset,
  color,
}: {
  region: {
    points: { x: number; y: number }[];
    projection: number[];
    view: number[];
    canvasSize: { width: number; height: number };
  };
  /** World AABB of what is being cropped; sets the outline's depth extent. */
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  /** Render-only shift the scene draws under (world − offset). */
  displayOffset: { x: number; y: number; z: number };
  color: string;
}) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(screenRegionOutline(region, bounds, displayOffset), 3),
    );
    return g;
  }, [region, bounds, displayOffset.x, displayOffset.y, displayOffset.z]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments {...SCENE_OVERLAY} geometry={geometry} frustumCulled={false} renderOrder={9998}>
      <lineBasicMaterial color={color} transparent opacity={0.9} depthTest={false} />
    </lineSegments>
  );
}
