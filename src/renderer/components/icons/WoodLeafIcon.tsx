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
// Sized to fill the grid. The first version drew both organs small and hung a
// full-height three-dash cut between them; at the 14-16 px the toolbar actually
// renders, neither organ was identifiable. Both were enlarged toward lucide's
// 2-unit safe margin and the cut was cut to TWO dashes — the divider does not
// need to span the grid to read as a divider, and the height it gives back is
// what lets the blade grow (blade axis 15.4 -> 18.3 units, half width 3.4 ->
// 3.8, limb height 13 -> 14.2).
//
// Geometry (24-unit lucide grid, y pointing down):
//   - woody limb:  stem (5.6,21) -> (5.6,6.8), lower fork to (2.8,11.2),
//                  upper fork to (9,7) — asymmetric, so it reads as a branch
//                  rather than a tuning fork or the letter Y
//   - dashed cut:  x=12, two 4-unit dashes at y=5.5 and 14.5
//   - leaf blade:  a filled cubic almond, tip (21.2,3.4) -> base (14.4,20.4),
//                  half width 3.8 at 22%/70% along the axis (asymmetric, so it
//                  is widest below centre like a real blade, not an oval)
//
// Two clearances are load-bearing and must be re-measured if any endpoint
// moves, because both fail silently — the mark just looks wrong at small sizes:
//   - Ink spans x in [1.8,21.81], y in [3.4,22] once the 2-unit stroke's round
//     CAPS are included (they extend a full unit past each endpoint, which is
//     what decides the bound here — the stem ends at y=21, not 22). The blade's
//     extrema are its true CURVE extrema, x in [14.04,21.81]; its control
//     points reach x=23.23 and must never be used for this.
//   - The blade's widest flank clears the cut's stroke (which occupies x in
//     [11,13]) by 1.04 units. An earlier candidate left 0.40, which is a third
//     of a pixel at 14 px — the blade and the dash merged into one blob.
export const WoodLeafIcon = createLucideIcon('WoodLeaf', [
  ['path', { d: 'M5.6 21V6.8', key: 'stem' }],
  ['path', { d: 'M5.6 14 2.8 11.2', key: 'fork-lower' }],
  ['path', { d: 'M5.6 10.4 9 7', key: 'fork-upper' }],
  ['path', { d: 'M12 5.5v4', key: 'cut-top' }],
  ['path', { d: 'M12 14.5v4', key: 'cut-bottom' }],
  [
    'path',
    {
      d: 'M21.2 3.4C16.18 5.73 12.91 13.89 14.4 20.4C19.97 16.71 23.23 8.55 21.2 3.4z',
      fill: 'currentColor',
      stroke: 'none',
      key: 'leaf-blade',
    },
  ],
]);

export default WoodLeafIcon;
