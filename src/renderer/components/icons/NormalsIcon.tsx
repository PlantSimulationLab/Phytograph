import { createLucideIcon } from 'lucide-react';

// Custom Compute-Normals icon.
//
// Why a custom icon: the tool first borrowed lucide's `Axis3d`, which is three
// axis lines meeting at a corner — visually almost the same mark as
// `ChartScatter`, the Resample icon sitting beside it in the same Pre-processing
// toolbar group (scattered dots against an L-shaped axis). At the 12–16 px the
// toolbar actually renders, both collapse to "sparse marks on a corner".
//
// The mark: a TILTED surface with one prominent ARROW standing perpendicular off
// it, flanked by two short plain ticks. That is literally what the tool computes
// — the direction a surface faces at each point.
//
// The arrowhead is load-bearing. An earlier version used three plain ticks and
// no head; checked against the real toolbar it read as "a flat angled patch with
// points on it", i.e. the same surface-plus-dots language as the segmentation
// icons, because nothing in it pointed anywhere. One unmistakable arrow fixes
// that, and the two flanking ticks keep the plural "normals of a surface"
// reading rather than a generic upload glyph (which a lone centred arrow on a
// horizontal baseline becomes).
//
// Rejected, each judged by rendering at 12/16/20/24 px rather than by eye:
//   - three small arrows, or two: the ~2 px heads mush into blobs when small
//   - a lone arrow with no ticks: loses the "many normals" idea
//   - a flat baseline instead of a tilted one: bar chart (ticks) / upload (arrow)
//   - a convex surface: reads as a sunrise, or as eyelashes when small
//
// Built with lucide's own `createLucideIcon`, so it is a drop-in for any lucide
// icon — same props, 24×24 viewBox, `currentColor` stroke, width 2, round caps.
//
// Geometry (24-unit lucide grid, y pointing down). The surface runs (3,18) →
// (21,11), slope −7/18. The unit perpendicular is (7,−18)/|(7,−18)| ≈
// (−0.3624,−0.9320); every stem is that direction scaled, rooted on the surface
// at 16% / 50% / 84% of its length. The centre stem is 9 units with a 3-unit
// head whose barbs are the reversed normal rotated ±32°; the flanking ticks are
// 3.6 units. Ink spans x∈[3,21], y∈[6.1,18] — centred on (12.0,12.1) and inside
// lucide's 2-unit safe margin.
//
// The perpendicularity is the point of the mark (it is an icon OF
// perpendicularity), so if the surface endpoints ever move, recompute the stems
// from the normal above rather than nudging the numbers by eye — a hand-placed
// earlier draft sat at 89.48°, which is invisible here but makes the comment a
// lie and the next edit guesswork.
export const NormalsIcon = createLucideIcon('Normals', [
  ['path', { d: 'M3 18 21 11', key: 'surface' }],
  ['path', { d: 'M5.88 16.88 4.58 13.52', key: 'normal-left' }],
  ['path', { d: 'M18.12 12.12 16.82 8.76', key: 'normal-right' }],
  ['path', { d: 'M12 14.5 8.74 6.11', key: 'normal-stem' }],
  ['path', { d: 'M8.74 6.11 8.18 9.06', key: 'head-barb-a' }],
  ['path', { d: 'M8.74 6.11 11.14 7.91', key: 'head-barb-b' }],
]);

export default NormalsIcon;
