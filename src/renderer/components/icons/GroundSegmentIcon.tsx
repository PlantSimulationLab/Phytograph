import { createLucideIcon } from 'lucide-react';

// Custom Segment-Ground icon.
//
// Why a custom icon: Segment Ground used lucide's `Layers`, and Cross-section
// used `Layers3` — but in current lucide `Layers3` is a deprecated *alias* of
// `Layers` (see `Layers as Layers3` in lucide-react's type exports), so the two
// tools drew the byte-identical stacked-sheets glyph. Cross-section keeps the
// stack (a slab cut out of a cloud reads well as layers); ground segmentation
// gets a mark for what it actually does.
//
// The mark: a point cloud cut by a ground plane. Segment Ground (CSF) doesn't
// build a surface — it *classifies every point* as ground or non-ground — so
// both classes are drawn as points, split by the fitted plane: three scattered
// points above (plant/canopy) and two below (ground). That keeps it clearly
// apart from `Mountain` (Generate DEM, a jagged solid ridge — a surface, not
// points) and from `Layers`/`Layers3` (Cross-section).
//
// Curved terrain profiles were tried first and rejected: at the 12–16 px the
// toolbar and panel headers actually render, dots above a concave curve read as
// a smiley face. A straight plane is legible down to 12 px and doesn't.
//
// Built with lucide's own `createLucideIcon`, so it's a drop-in for `Layers` —
// same props, 24×24 viewBox, `currentColor` stroke, width 2, round caps/joins.
//
// Geometry (24-unit lucide grid, y pointing down):
//   - ground plane:      full-width rule at y=15
//   - non-ground points: (7,10) (13,6) (18,10.5) — scattered, deliberately not
//                        an even arc, so they read as a cloud rather than a row
//   - ground points:     (8,20) (16,19.5)
export const GroundSegmentIcon = createLucideIcon('GroundSegment', [
  ['path', { d: 'M2 15h20', key: 'plane' }],
  ['circle', { cx: '7', cy: '10', r: '1', key: 'above-left' }],
  ['circle', { cx: '13', cy: '6', r: '1', key: 'above-top' }],
  ['circle', { cx: '18', cy: '10.5', r: '1', key: 'above-right' }],
  ['circle', { cx: '8', cy: '20', r: '1', key: 'below-left' }],
  ['circle', { cx: '16', cy: '19.5', r: '1', key: 'below-right' }],
]);

export default GroundSegmentIcon;
