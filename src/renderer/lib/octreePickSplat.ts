// Shared tuning for potree-core's GPU pick pass.
//
// Extracted from PointPicker so every octree pick in the app aims the same way.
// It is not in lib/pointPick.ts because that module is deliberately free of
// three.js/potree imports; this one needs potree's PointSizeType.
import { PointSizeType } from 'potree-core';

// Side of the readback window, in CSS pixels, that `Potree.pick` scans for a
// written pixel. Aim tolerance, in effect.
export const OCTREE_PICK_WINDOW_PX = 13;

// Pixel diameter each point is rasterised at DURING THE PICK PASS ONLY.
//
// This is the whole reason sparse clouds used to be nearly unclickable.
// `Potree.pick` re-renders the visible nodes into an index buffer and then
// scans the readback window for a pixel that was actually written
// (`findHit`) — so a point is only pickable where its splat covered a pixel.
// potree's `updatePickMaterial` copies the DISPLAY material's sizing verbatim
// (`size`/`minSize`/`maxSize`/`pointSizeType`), and the viewer renders
// PointSizeType.FIXED at `pointSize`, which defaults to 1. That meant the pick
// pass drew 1-pixel splats: in a solid-looking region every pixel is covered
// so any click lands, but in a region with visible background you had to hit
// an individual dot dead-on. Density, not aim, decided whether a click worked.
//
// Inflating the splat here decouples the CLICK TARGET from the DISPLAY size —
// the cloud still draws crisp at `pointSize`, but for the one off-screen pick
// render each point covers a ~9 px disc, which is what CloudCompare
// effectively does. Kept below OCTREE_PICK_WINDOW_PX so a splat cannot fill
// the entire readback window: `findHit` breaks ties by distance-to-centre in
// 2D with no depth test, so an over-large splat would let a point far from the
// cursor blanket the window and win.
//
// In CSS pixels. Both this and OCTREE_PICK_WINDOW_PX are scaled by the device
// pixel ratio before use — potree multiplies `pickWindowSize` by the ratio
// itself, but `size` lands in the shader as a raw `gl_PointSize` in DEVICE
// pixels, so on a Retina canvas (R3F defaults `dpr` to the device ratio; the
// viewer's <Canvas> does not override it) an unscaled value would cover half
// the intended area relative to the window.
export const OCTREE_PICK_POINT_SIZE_PX = 9;

// Grow every point to a fat fixed-size splat for the pick render pass.
//
// potree hands us its internal pick material AFTER it has copied the display
// material's sizing onto it, and re-copies on every pick, so mutating it here
// is safe and self-resetting — the material is private to the picker and never
// reaches the visible scene.
//
// The shader does `pointSize = clamp(pointSize, minSize, maxSize)`, so setting
// `size` alone is not enough: the display material's `maxSize` would clamp the
// inflation straight back down. All three move together, and `pointSizeType`
// is pinned to FIXED so `size` is read as a literal pixel count rather than
// being scaled by node spacing / camera distance.
export function makeInflatePickSplat(pixelRatio: number) {
  const px = OCTREE_PICK_POINT_SIZE_PX * Math.max(pixelRatio, 1);
  return (material: {
    size: number;
    minSize: number;
    maxSize: number;
    pointSizeType: PointSizeType;
  }): void => {
    material.pointSizeType = PointSizeType.FIXED;
    material.size = px;
    material.minSize = px;
    material.maxSize = Math.max(material.maxSize, px);
  };
}
