import { useMemo } from 'react';
import * as THREE from 'three';
import { SCENE_OVERLAY } from '../../../lib/sceneOverlay';
import { slabToBox, type SlabRegion } from '../../../lib/crossSection';

// Outline of the cross-section slab, so the user can see where the section sits
// relative to the rest of the cloud — especially while stepping, where the only
// other feedback is the points appearing and disappearing.
//
// Carries SCENE_OVERLAY: DepthProbe skips overlays via `isSceneOverlay`, and
// without it zoom-to-cursor would anchor on the slab's invisible faces instead
// of the geometry behind them.
export function SlabWireframe({
  slab,
  displayOffset,
  dimmed = false,
}: {
  slab: SlabRegion;
  /** Render-only shift the scene draws under (world − offset). */
  displayOffset?: { x: number; y: number; z: number };
  /**
   * True when the camera is looking down the slab normal, where the box
   * degenerates to a rectangle around the viewport — still useful as a framing
   * cue, but it should not compete with the points for attention.
   */
  dimmed?: boolean;
}) {
  const matrix = useMemo(() => {
    const m = slabToBox(slab).matrix.clone();
    // The slab is world-space; the scene renders at world − displayOffset.
    if (displayOffset) {
      m.premultiply(new THREE.Matrix4().makeTranslation(
        -displayOffset.x, -displayOffset.y, -displayOffset.z,
      ));
    }
    return m;
  }, [slab, displayOffset?.x, displayOffset?.y, displayOffset?.z]);

  const geometry = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    [],
  );

  return (
    <lineSegments
      {...SCENE_OVERLAY}
      geometry={geometry}
      matrix={matrix}
      matrixAutoUpdate={false}
      renderOrder={9998}
    >
      <lineBasicMaterial
        color="#38bdf8"
        transparent
        opacity={dimmed ? 0.25 : 0.9}
        depthTest={false}
      />
    </lineSegments>
  );
}
