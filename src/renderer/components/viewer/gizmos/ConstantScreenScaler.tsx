import { useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { worldPerPixel } from '../../../lib/screenScale';

/**
 * Rescales a visual group so its glyph subtends a fixed number of screen pixels
 * regardless of camera distance/zoom.
 *
 * Why gizmos need this: sizing a gizmo off the object's bounds makes it useless
 * on the two cases that matter most — a kilometre-wide survey cloud you're
 * zoomed into (arrows the size of the county, no handle on screen) and a tiny
 * object (a gizmo too small to grab). The handles are UI, so they belong in
 * pixels, like the scene-origin marker.
 *
 * Drag handlers are deliberately NOT scaled: they work off the UNSCALED center
 * and derive world-per-pixel from their own screen projection, so their math is
 * unaffected by whatever scale the visual group carries.
 */
export function ConstantScreenScaler({
  target, pixels, size,
}: {
  /** The group to scale — must be positioned AT the gizmo center. */
  target: React.RefObject<THREE.Group | null>;
  /** Desired on-screen extent, in pixels, of one `size` world unit of glyph. */
  pixels: number;
  /** The glyph's nominal world extent, i.e. the `size`/`radius` its geometry was authored with. */
  size: number;
}) {
  const { camera, size: viewport } = useThree();
  const worldPos = useRef(new THREE.Vector3()).current;
  useFrame(() => {
    const grp = target.current;
    if (!grp) return;
    // World position, not local — a parent group may be cancelling displayOffset.
    grp.getWorldPosition(worldPos);
    // `size` is the gizmo's nominal world extent, so dividing it out makes the
    // scaled glyph exactly `pixels` px.
    const world = pixels * worldPerPixel(camera, camera.position, viewport.height, worldPos);
    if (world > 0 && size > 0) grp.scale.setScalar(world / size);
  });
  return null;
}

/**
 * On-screen sizes for the transform tool's gizmos, in pixels.
 *
 * The two glyphs are concentric, so the rings must sit OUTSIDE the arrowheads —
 * otherwise the rings cross the shafts and the arrows are both hard to see and
 * hard to pick. But not by much: at 1.5× the rings visually swamped the arrows,
 * which are the handle people reach for first. The arrow's cone tip reaches
 * ~1.05 × its nominal size, so a ring at 1.15× clears it with a small gap while
 * keeping the arrows the dominant glyph.
 *
 * The scene-origin gizmo uses the arrow size too, so the two tools agree.
 */
export const GIZMO_ARROW_PIXELS = 90;
export const GIZMO_RING_PIXELS = Math.round(GIZMO_ARROW_PIXELS * 1.15);
