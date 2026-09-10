// Where to draw the ground grid on the up axis.
//
// Two competing intents:
//
//  1. Content authored around the ORIGIN (a synthetic plant, a Helios scene, a
//     mesh modelled at 0) should get its grid at exactly 0. Anything else looks
//     broken: the grid floats a few centimetres off a plant that is visibly
//     standing on zero, because a handful of noise points dipped below it.
//  2. Content that lives somewhere else entirely — a georeferenced survey in
//     UTM with ellipsoidal height — must get its grid at the GROUND, because
//     zero is not a place. On the WGS84 ellipsoid, Z=0 is a datum surface that
//     can sit tens of metres from the terrain.
//
// The rule that shipped resolved this by asking whether the scene's vertical
// span STRADDLES zero, and then whether zero is within half the scene's 3D
// DIAGONAL. Both halves are far too permissive for (2). A real drone survey of a
// poplar block measured: ground at Z = -13.75 m (ellipsoidal), scene diagonal
// 217 m. The span straddles zero, and half the diagonal is 108 m, so the grid
// snapped to 0 — 13.7 m above the ground and 3.6 m ABOVE THE CANOPY TOP, which
// reads to the user as the ground being drawn through the treetops.
//
// The fix is to measure the ground's distance from zero against the scene's
// VERTICAL extent rather than its diagonal, and to require the ground to be
// genuinely NEAR zero rather than merely on the same side of it. A scene whose
// floor sits within a few percent of its own height of zero was authored at the
// origin; one whose floor is 42% of its height away (the survey above) was not.
export const GRID_ZERO_SNAP_FRACTION = 0.05;

// An absolute tolerance for tiny scenes, so a 20 cm seedling whose floor is at
// -1 mm still snaps to 0 rather than failing the relative test on a hair.
export const GRID_ZERO_SNAP_ABSOLUTE = 0.01;

// `floor` is the scene's ground level on the up axis (an outlier-resistant low
// percentile for z-up, the raw extent minimum otherwise) and `ceil` its maximum.
// Returns the up-axis height to draw the grid at.
export function computeGridFloor(floor: number, ceil: number): number {
  if (!isFinite(floor)) return 0;
  if (!isFinite(ceil)) return floor;
  // Vertical extent, not the 3D diagonal: a wide, flat survey has an enormous
  // diagonal and a small height, and it is the HEIGHT that decides whether zero
  // is plausibly this scene's ground.
  const verticalExtent = Math.max(ceil - floor, 0);
  const tolerance = Math.max(verticalExtent * GRID_ZERO_SNAP_FRACTION, GRID_ZERO_SNAP_ABSOLUTE);
  // Snap to 0 only when the GROUND is near zero. Note this deliberately does NOT
  // ask whether the span straddles zero: a survey whose terrain is far below the
  // ellipsoid but whose canopy pokes above it straddles zero while having no
  // business drawing its ground there.
  return Math.abs(floor) <= tolerance ? 0 : floor;
}
