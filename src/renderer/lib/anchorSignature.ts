// Anchor invalidation — deciding what happens to a picked label or a
// measurement when the cloud underneath it changes.
//
// An anchor is a FIXED position attached to a cloud. Two very different things
// can happen to that cloud, and conflating them is the bug this module exists
// to fix:
//
//   * a RIGID POSE change — the user translates or rotates the cloud. Every
//     point is still there; the whole thing just moved. An anchor should MOVE
//     WITH IT, and a measurement's distance/angle is invariant under it by
//     construction.
//
//   * a GEOMETRY change — crop applied, points erased, a filter, a re-bake, a
//     split. The point an anchor was placed on may no longer exist, and the
//     anchor cannot be meaningfully carried anywhere. It is DROPPED.
//
// The original implementation hashed both into one signature and dropped
// anchors on any change, so nudging a cloud one metre silently deleted every
// label the user had placed. Splitting the key in two is the whole fix; the
// movement itself reuses `transformPoint`, which already exists and is already
// tested against the real octree pose path.
//
// Pure — no three.js, no React. Keyed on the smallest structural shapes rather
// than the full CloudEditState so the tests can construct inputs directly.

export interface RigidPoseInput {
  translation?: { x: number; y: number; z: number } | null;
  rotation?: { x: number; y: number; z: number } | null;
  /**
   * The point the rotation turns about. Part of WHERE THE CLOUD IS DRAWN, not
   * just how it got there: moving the scene origin re-pivots a rotated cloud
   * and visibly swings it, with translation and rotation unchanged. Omitting it
   * left anchors behind on exactly that edit.
   */
  pivot?: { x: number; y: number; z: number } | null;
  /**
   * A committed-but-unrefreshed pose. Only needed when keying off RAW edit
   * state; callers that key off the resolved pose (`composeCloudPose`) already
   * have it folded into translation/rotation/pivot and should omit it.
   */
  storedPose?: {
    translation: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    pivot: { x: number; y: number; z: number };
    cacheId: string;
  } | null;
}

export interface GeometryInput {
  pointCount: number;
  cacheId?: string | null;
  pendingDeletedCount?: number | null;
  erasedCount?: number | null;
}

const ZERO = { x: 0, y: 0, z: 0 } as const;

function xyz(v: { x: number; y: number; z: number } | null | undefined): string {
  const p = v ?? ZERO;
  return `${p.x},${p.y},${p.z}`;
}

/**
 * The pose a cloud is currently DRAWN at.
 *
 * Covers the live draft (`translation`/`rotation` from the Transformation tool)
 * and any committed-but-unrefreshed `storedPose`. A change here means the cloud
 * moved and its anchors should be carried along.
 *
 * `storedPose.cacheId` is deliberately part of this key: a stored pose applies
 * only while it matches the cloud's current octree (see `composeCloudPose`), so
 * when the id stops matching the pose stops being applied — which is a change
 * in where the cloud is drawn, and must register as one.
 */
export function rigidPoseKey(edit: RigidPoseInput | undefined | null): string {
  const sp = edit?.storedPose;
  return [
    xyz(edit?.translation),
    xyz(edit?.rotation),
    xyz(edit?.pivot),
    sp ? `${xyz(sp.translation)}|${xyz(sp.rotation)}|${xyz(sp.pivot)}|${sp.cacheId}` : '',
  ].join('#');
}

/**
 * What the cloud's POINTS are.
 *
 * A change here means geometry was added, removed or rebuilt, so an anchor's
 * underlying point may be gone and the anchor is dropped.
 *
 * `cacheId` belongs here, not in the pose key: every rebuild path (filter,
 * split, segment, crop-apply, bake, refresh) produces a new octree id from
 * arrays that already contain the transform. So a new id means the geometry
 * itself changed — including the case where a committed pose was baked into it.
 */
export function geometryKey(g: GeometryInput): string {
  return [
    g.pointCount,
    g.cacheId ?? '',
    g.pendingDeletedCount ?? 0,
    g.erasedCount ?? 0,
  ].join('#');
}

/** Both keys for one cloud, as stored between renders. */
export interface AnchorKeys {
  pose: string;
  geometry: string;
}

export type AnchorFate =
  /** The cloud is gone, or its points changed — drop this anchor. */
  | { kind: 'drop' }
  /** Nothing relevant changed — leave the anchor exactly as it is. */
  | { kind: 'keep' }
  /** The cloud moved rigidly — re-derive the anchor's position from the new pose. */
  | { kind: 'move' };

/**
 * What should happen to anchors on `cloudId`, given the keys from the previous
 * render and the current ones.
 *
 * Geometry is checked FIRST and wins: an edit that both moves and rebuilds a
 * cloud (a crop-apply on a translated cloud, say) must drop, not move. Carrying
 * an anchor onto rebuilt geometry would place it confidently in the wrong spot,
 * which is worse than losing it — the number would still look plausible.
 */
export function anchorFate(
  prev: AnchorKeys | undefined,
  next: AnchorKeys | undefined,
): AnchorFate {
  // The cloud disappeared (removed, or never registered).
  if (!next) return { kind: 'drop' };
  // First sighting — nothing to compare against, so leave it alone.
  if (!prev) return { kind: 'keep' };
  if (prev.geometry !== next.geometry) return { kind: 'drop' };
  if (prev.pose !== next.pose) return { kind: 'move' };
  return { kind: 'keep' };
}
