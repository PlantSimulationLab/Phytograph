// Coordinate-frame mismatch detection for newly added scans/trajectories.
//
// A LiDAR trajectory (or scan) imported in a projected CRS carries huge absolute
// coordinates — e.g. UTM easting/northing in the 10^5–10^6 range. When the scene
// already holds origin-based geometry (a ground plane at 0,0,0), the two are
// millions of metres apart: the viewport auto-fits to the union bounding box and
// everything collapses to sub-pixel size ("auto-fits to nothing"). This module
// holds the pure math that (a) decides whether the new entity is in a
// disagreeing frame and (b) computes the shift that would move it onto the
// existing content, so the renderer can warn the user and offer a one-click fix.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// Center + diagonal of an axis-aligned box, the compact "where is the content
// and how big is it" summary the mismatch rule needs.
export function boundsCenterDiagonal(
  min: Vec3,
  max: Vec3,
): { center: Vec3; diagonal: number } {
  const center = {
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  };
  const dx = max.x - min.x;
  const dy = max.y - min.y;
  const dz = max.z - min.z;
  return { center, diagonal: Math.hypot(dx, dy, dz) };
}

export interface ExistingContent {
  center: Vec3;
  diagonal: number;
}

// Absolute distance (metres) past which a new entity is "far" regardless of the
// existing content's own size. Mirrors computeDisplayOffset's threshold in
// pointCloudHelpers.ts (the point at which the renderer already treats coords as
// far from the origin): a projected/UTM cloud is well past this.
export const FRAME_MISMATCH_ABS_THRESHOLD = 1e4;

// Relative guard: a new entity more than K diagonals away from existing content
// is in a different frame. K=10 clears any intentional same-frame layout (two
// scans side-by-side in a plot span a few diagonals at most) without
// false-positiving on a legitimately large scene, while the abs threshold above
// still catches a small scene (a 25×25 m plane, diag≈35 → K·diag≈350) against a
// millions-of-metres offset.
export const FRAME_MISMATCH_K = 10;

// Decide whether `newAnchor` sits in a coordinate frame that disagrees with the
// existing scene content. An empty scene (existing == null) is never a mismatch
// — the new entity simply becomes the frame anchor. `distance` is returned for
// messaging ("~5.4 million m away").
export function detectFrameMismatch(params: {
  newAnchor: Vec3;
  existing: ExistingContent | null;
  absThreshold?: number;
  k?: number;
}): { mismatch: boolean; distance: number } {
  const {
    newAnchor,
    existing,
    absThreshold = FRAME_MISMATCH_ABS_THRESHOLD,
    k = FRAME_MISMATCH_K,
  } = params;
  if (!existing) return { mismatch: false, distance: 0 };
  const distance = Math.hypot(
    newAnchor.x - existing.center.x,
    newAnchor.y - existing.center.y,
    newAnchor.z - existing.center.z,
  );
  const limit = Math.max(absThreshold, k * existing.diagonal);
  return { mismatch: distance > limit, distance };
}

// The shift that, subtracted from every position of the new entity, lands its
// anchor on the existing content center. Returned as a [dx,dy,dz] tuple so it
// feeds straight into shiftPoseStream (which subtracts the shift).
export function recenterShiftFor(
  newAnchor: Vec3,
  existingCenter: Vec3,
): [number, number, number] {
  return [
    newAnchor.x - existingCenter.x,
    newAnchor.y - existingCenter.y,
    newAnchor.z - existingCenter.z,
  ];
}
