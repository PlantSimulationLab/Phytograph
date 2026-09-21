import { createLucideIcon } from 'lucide-react';

// Custom Segment-Wood/Leaf icon.
//
// Why a custom icon: the tool borrowed lucide's `GitBranch`, which is a
// VERSION-CONTROL graph (two circles joined by a curve — see the glyph's own
// `__iconNode`: `line` + two `circle`s + an arc). Nothing about it is botanical;
// it was presumably picked for the word "branch". The tool classifies every
// point of a plant cloud as WOOD or LEAF, so the mark should say that.
//
// The mark: the two classes side by side, split by a dashed boundary — a bare
// forked WOODY limb on the left, a filled LEAF blade on the right. That mirrors
// `GroundSegmentIcon`'s language (a classifier draws BOTH classes, separated by
// the thing that discriminates them), so the two segmentation tools read as a
// family without reading as each other: ground-segment is points about a plane,
// wood/leaf is two plant organs about a dashed cut.
//
// The leaf is FILLED, and that is load-bearing rather than decorative. An
// outlined blade needs its interior to stay open, but at the 12-16 px the
// toolbar actually renders, a 2-unit stroke on both flanks closes any blade
// narrow enough to still look like a leaf — checked at 12/14/16/20/24 px, every
// outlined version turned into a solid lozenge or an "eye" below 20 px. Filling
// it makes the silhouette exactly the curve at every size, and the solid mass
// also distinguishes it in a toolbar row that is otherwise all outlines.
//
// Rejected, each judged by rendering at 12/14/16/20/24 px next to the real
// neighbouring toolbar icons rather than by eye:
//   - a leaf with a petiole/stalk: reads unmistakably as a PAINTBRUSH, and
//     collides with `Brush` (Label Points) two slots away
//   - leaf left + branch right: the pair reads as the letters "q Y"
//   - a leaf with a long woody midrib extending past the base: reads as a FISH
//   - a leafy twig (leaves along one stem): one object, so it shows foliage but
//     not the SEPARATION that is the whole point of the tool
//   - a whole small tree / sprout shape: collides with `Sprout` (Generate
//     Plant), `Trees` (Segment Trees) and `TreeDeciduous` (Fit Crown)
//   - a midrib line inside the blade: invisible once the blade is filled, and
//     ink in the one place that has to stay clear when it is not
//
// Built with lucide's own `createLucideIcon`, so it's a drop-in for `GitBranch`
// — same props, 24x24 viewBox, `currentColor`, width 2, round caps/joins. The
// blade overrides `fill`/`stroke` on its own path only.
//
// Geometry (24-unit lucide grid, y pointing down):
//   - woody limb:  stem (5.5,21.5) -> (5.5,8.5), lower fork to (2,10.5),
//                  upper fork to (9,8) — asymmetric, so it reads as a branch
//                  rather than a tuning fork or the letter Y
//   - dashed cut:  x=12, three 3-unit dashes at y=3, 10.5, 18
//   - leaf blade:  a filled cubic almond, tip (21.4,5) -> base (15,19), half
//                  width 3.4 at 22%/70% along the axis (asymmetric, so it is
//                  widest below centre like a real blade, not an oval)
//
// Ink spans x in [2,21.86], y in [5,21.5] (the blade's true curve extrema, not
// its control points, which reach x=23.08) — inside lucide's 2-unit safe
// margin. If the blade endpoints ever move, recompute those extrema rather than
// trusting the control points, or the mark will silently overflow the grid.
export const WoodLeafIcon = createLucideIcon('WoodLeaf', [
  ['path', { d: 'M5.5 21.5V8.5', key: 'stem' }],
  ['path', { d: 'M5.5 14 2 10.5', key: 'fork-lower' }],
  ['path', { d: 'M5.5 11.5 9 8', key: 'fork-upper' }],
  ['path', { d: 'M12 3v3', key: 'cut-top' }],
  ['path', { d: 'M12 10.5v3', key: 'cut-mid' }],
  ['path', { d: 'M12 18v3', key: 'cut-bottom' }],
  [
    'path',
    {
      d: 'M21.4 5C16.9 6.67 13.83 13.39 15 19C20.01 16.21 23.08 9.49 21.4 5z',
      fill: 'currentColor',
      stroke: 'none',
      key: 'leaf-blade',
    },
  ],
]);

export default WoodLeafIcon;
