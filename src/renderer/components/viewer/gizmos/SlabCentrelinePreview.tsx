import { useMemo } from 'react';
import * as THREE from 'three';
import { SCENE_OVERLAY } from '../../../lib/sceneOverlay';

// Feedback while placing a cross-section centreline.
//
// Without this the first click produces NOTHING on screen — the user cannot
// tell whether it registered, where it landed, or which direction the section
// will run. They click twice into a void and the view jumps somewhere
// unexpected.
//
// Shows a marker at the placed point and, once the cursor moves, a rubber-band
// line to it — the same "you clicked here, this is what you're making" cue the
// crop box's two-corner draw gives.
export function SlabCentrelinePreview({
  first,
  cursor,
  z,
  displayOffset,
}: {
  /** The first placed point, world XY. */
  first: { x: number; y: number };
  /** Live cursor position on the pick plane, world XY. Null before it moves. */
  cursor: { x: number; y: number } | null;
  /** Height of the pick plane, world Z. */
  z: number;
  displayOffset?: { x: number; y: number; z: number };
}) {
  const ox = displayOffset?.x ?? 0;
  const oy = displayOffset?.y ?? 0;
  const oz = displayOffset?.z ?? 0;

  const lineGeometry = useMemo(() => {
    if (!cursor) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      first.x - ox, first.y - oy, z - oz,
      cursor.x - ox, cursor.y - oy, z - oz,
    ], 3));
    return g;
  }, [first.x, first.y, cursor?.x, cursor?.y, z, ox, oy, oz]);

  return (
    <group {...SCENE_OVERLAY}>
      {/* Where the first click landed. */}
      <mesh position={[first.x - ox, first.y - oy, z - oz]} renderOrder={9999}>
        <sphereGeometry args={[0.12, 12, 12]} />
        <meshBasicMaterial color="#38bdf8" depthTest={false} />
      </mesh>
      {lineGeometry && (
        <lineSegments geometry={lineGeometry} renderOrder={9999}>
          <lineBasicMaterial color="#38bdf8" depthTest={false} />
        </lineSegments>
      )}
    </group>
  );
}
