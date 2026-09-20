// When a column-adding tool (Compute Normals, a scalar-field compute, a
// scalar-field rename/delete) finishes on a large cloud, the octree rebuild that
// re-colours the view costs far more than the column itself. Above this size the
// tool returns as soon as the COLUMN has landed — export, further formulas and
// every other tool can read it immediately — and the recolouring catches up on
// the background refresh queue.
//
// This threshold was the literal `5_000_000` written out at three separate call
// sites in PointCloudViewer with no shared name. Three copies of one policy is a
// policy that drifts: changing the trade meant finding all three, and nothing
// would have failed if one had been missed. It also read as though it were
// related to `triangulateMaxPoints` (whose default is coincidentally the same
// number) when the two are unconnected.
//
// Not a user setting, deliberately: deferring is invisible when it works (the
// column is there; the colours arrive a moment later) and the cost of getting it
// wrong is a slower tool, not a wrong answer. It is sized against the octree
// REBUILD cost, which is a property of PotreeConverter rather than of the
// machine's RAM, so it does not belong on the memory budget either.

export const DEFER_OCTREE_REBUILD_ABOVE_POINTS = 5_000_000;

/**
 * Whether a session tool should return before its octree rebuild (`defer_octree`).
 *
 * `pointCount` is the cloud's size; an unknown count (null/undefined on a cloud
 * whose metadata has not arrived) must NOT defer — deferring hides the recolour
 * behind a queue, and doing that to a cloud that might be small trades a visible
 * wait for an invisible one.
 */
export function shouldDeferOctreeRebuild(pointCount: number | null | undefined): boolean {
  if (pointCount == null || !Number.isFinite(pointCount)) return false;
  return pointCount > DEFER_OCTREE_REBUILD_ABOVE_POINTS;
}
