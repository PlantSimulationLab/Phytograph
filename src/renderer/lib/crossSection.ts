// Cross-section slab geometry — the professional LiDAR classification workflow.
//
// Every mature package centres editing on a thin vertical slab rather than
// free 3-D orbiting (TerraScan's Draw Vertical Section + Move Section, ArcGIS
// Pro's profile view, QGIS, lasview, CloudCompare). It wins for reasons that
// apply doubly to plant data:
//
//   * Occlusion stops being a problem BY CONSTRUCTION. A slab thin enough to
//     read has nothing meaningful hiding behind anything, so a 2-D lasso inside
//     it selects what the user actually sees — no depth reasoning required.
//   * Viewed edge-on and orthographic, the vertical structure of a tree (trunk
//     → branch → leaf) is obvious. Top-down it is invisible.
//   * Stepping the slab gives PROVABLE coverage. A free orbit has no way to
//     know you have looked at everything.
//
// The slab is WORLD-SPACE and carries no camera. That is the deep difference
// from the erase brush's screen-space stamps: the region means the same thing
// however the user is looking at it, so the camera never has to be frozen and
// the backend replays the identical closed-form test with no projection
// matrices involved (see `_region_mask`'s "slab" kind).
//
// Pure geometry — no React, no DOM. THREE is used only for its math types,
// following cropGeometry.ts's precedent, so this is unit-testable headlessly.
import * as THREE from 'three';

/** A point in the XY ground plane. */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * A vertical cross-section slab.
 *
 * The centerline `a`→`b` is a horizontal segment; the slab is the vertical
 * prism of thickness `depth` centred on it, spanning `[zMin, zMax]`.
 *
 * `offset` is how far the slab has been STEPPED from where it was drawn,
 * measured along the slab normal. Stepping moves this and never `a`/`b`, so
 * "reset to origin" is free and the centreline keeps expressing the azimuth the
 * user chose.
 */
export interface SlabRegion {
  kind: 'slab';
  a: Vec2;
  b: Vec2;
  /** Thickness in world units (TerraScan calls this Depth). */
  depth: number;
  zMin: number;
  zMax: number;
  offset: number;
}

/** Unit direction along the centreline — the on-screen horizontal axis. */
export function slabTangent(s: SlabRegion): Vec2 {
  const dx = s.b.x - s.a.x;
  const dy = s.b.y - s.a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return { x: 1, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** Unit normal (left of the tangent) — the axis the slab is thin along. */
export function slabNormal(s: SlabRegion): Vec2 {
  const t = slabTangent(s);
  return { x: -t.y, y: t.x };
}

/** Centreline length. Zero for a degenerate slab. */
export function slabLength(s: SlabRegion): number {
  return Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
}

/** World-space centre of the slab, accounting for the current step offset. */
export function slabCenter(s: SlabRegion): THREE.Vector3 {
  const n = slabNormal(s);
  const midX = (s.a.x + s.b.x) / 2 + n.x * s.offset;
  const midY = (s.a.y + s.b.y) / 2 + n.y * s.offset;
  return new THREE.Vector3(midX, midY, (s.zMin + s.zMax) / 2);
}

/**
 * World-space membership test — the exact predicate the backend mirrors.
 *
 * A point is inside when it lies within `depth/2` of the (offset) centreline
 * plane, between the centreline's endpoints along the tangent, and inside the
 * vertical extent. Closed form, no camera, so the renderer's preview and the
 * server's apply cannot disagree.
 */
export function slabPredicate(
  s: SlabRegion,
): (wx: number, wy: number, wz: number) => boolean {
  const t = slabTangent(s);
  const n = slabNormal(s);
  const len = slabLength(s);
  const half = s.depth / 2;
  const { a, offset, zMin, zMax } = s;
  return (wx, wy, wz) => {
    if (wz < zMin || wz > zMax) return false;
    const dx = wx - a.x;
    const dy = wy - a.y;
    const across = dx * n.x + dy * n.y - offset;
    if (across < -half || across > half) return false;
    const along = dx * t.x + dy * t.y;
    return along >= 0 && along <= len;
  };
}

/**
 * The slab as four half-space planes, for `material.clippingPlanes`.
 *
 * potree's shader keeps a point only when it is on the POSITIVE side of every
 * plane (`dot(normal, worldPos) + constant >= 0`), and planes AND-intersect —
 * which is exactly a slab. Note this bounds the two thin faces AND the two
 * centreline ends; the vertical extent is left to the cloud's own bounds
 * because clipping it too would need two more planes and the shader's
 * `max_clip_planes` budget is better spent elsewhere.
 *
 * three.js `Plane` stores `normal` + `constant` with the same sign convention,
 * so these can be assigned straight onto the material.
 */
export function slabToPlanes(s: SlabRegion): THREE.Plane[] {
  const t = slabTangent(s);
  const n = slabNormal(s);
  const len = slabLength(s);
  const half = s.depth / 2;
  // A point on the offset centreline.
  const cx = s.a.x + n.x * s.offset;
  const cy = s.a.y + n.y * s.offset;

  const N = new THREE.Vector3(n.x, n.y, 0);
  const T = new THREE.Vector3(t.x, t.y, 0);
  return [
    // across >= -half  →  N·p - (N·c - half) >= 0
    new THREE.Plane(N.clone(), -(N.x * cx + N.y * cy) + half),
    // across <= +half  →  -N·p + (N·c + half) >= 0
    new THREE.Plane(N.clone().negate(), (N.x * cx + N.y * cy) + half),
    // along >= 0
    new THREE.Plane(T.clone(), -(T.x * s.a.x + T.y * s.a.y)),
    // along <= len
    new THREE.Plane(T.clone().negate(), (T.x * s.a.x + T.y * s.a.y) + len),
  ];
}

/**
 * The slab as an oriented box: centre + world→box matrix + half-extents.
 * Drives the wireframe gizmo. The box is a unit cube scaled by
 * (length, depth, height) and rotated so +X runs along the centreline.
 */
export function slabToBox(s: SlabRegion): {
  center: THREE.Vector3;
  matrix: THREE.Matrix4;
  halfExtents: THREE.Vector3;
} {
  const t = slabTangent(s);
  const n = slabNormal(s);
  const len = slabLength(s);
  const height = Math.max(s.zMax - s.zMin, 1e-6);
  const center = slabCenter(s);

  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(t.x, t.y, 0),
    new THREE.Vector3(n.x, n.y, 0),
    new THREE.Vector3(0, 0, 1),
  );
  const matrix = new THREE.Matrix4()
    .makeTranslation(center.x, center.y, center.z)
    .multiply(basis)
    .multiply(new THREE.Matrix4().makeScale(Math.max(len, 1e-6), Math.max(s.depth, 1e-6), height));

  return {
    center,
    matrix,
    halfExtents: new THREE.Vector3(len / 2, s.depth / 2, height / 2),
  };
}

/**
 * Camera pose that views the slab face-on: eye offset from the slab centre
 * along the normal, looking back at it, +Z up. `side` flips which face.
 *
 * Returns WORLD coordinates; the caller subtracts any display offset.
 */
export function slabViewPose(
  s: SlabRegion, distance: number, side: 1 | -1 = 1,
): { eye: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } {
  const n = slabNormal(s);
  const target = slabCenter(s);
  const eye = new THREE.Vector3(
    target.x + n.x * distance * side,
    target.y + n.y * distance * side,
    target.z,
  );
  return { eye, target, up: new THREE.Vector3(0, 0, 1) };
}

/**
 * Orthographic half-extents that frame the slab face, with `margin` as a
 * fraction (0.05 = 5% padding).
 *
 * Derived from the SLAB, not from the camera's orbit distance — that is the
 * whole reason this exists rather than reusing OrthoProjectionOverride, whose
 * frustum tracks the orbit target and would make a long section session's zoom
 * drift with the depth probe.
 */
export function slabOrthoFrustum(
  s: SlabRegion, aspect: number, margin = 0.05,
): { halfW: number; halfH: number } {
  const len = Math.max(slabLength(s), 1e-6);
  const height = Math.max(s.zMax - s.zMin, 1e-6);
  const m = 1 + Math.max(0, margin);
  let halfW = (len / 2) * m;
  let halfH = (height / 2) * m;
  // Grow the smaller axis so the whole face fits the viewport's aspect.
  if (aspect > 0) {
    if (halfW / halfH < aspect) halfW = halfH * aspect;
    else halfH = halfW / aspect;
  }
  return { halfW, halfH };
}

export type SlabStepMode = 'half' | 'almost' | 'full' | 'fixed';

/**
 * How far one step moves the slab.
 *
 * `half` is the DEFAULT and TerraScan's recommendation: consecutive sections
 * overlap by 50%, so no point can fall between two steps unseen. `almost`
 * (90%) trades a sliver of overlap for fewer steps; `full` tiles exactly and
 * risks a boundary point being visually clipped in both neighbours.
 */
export function slabStepDistance(
  s: SlabRegion, mode: SlabStepMode, fixed = 0,
): number {
  switch (mode) {
    case 'half': return s.depth / 2;
    case 'almost': return s.depth * 0.9;
    case 'full': return s.depth;
    case 'fixed': return fixed > 0 ? fixed : s.depth / 2;
  }
}

/** Step the slab forward (+1) or back (-1). Returns a NEW region. */
export function stepSlab(
  s: SlabRegion, dir: 1 | -1, mode: SlabStepMode, fixed = 0,
): SlabRegion {
  return { ...s, offset: s.offset + dir * slabStepDistance(s, mode, fixed) };
}

/**
 * Where the slab sits in the traverse, and how many steps span `bounds`.
 *
 * This is what makes coverage PROVABLE — "Section 7 of 42" tells the user
 * they have or have not looked at everything, which a free orbit never can.
 * `index` is 1-based and clamped into `[1, total]`.
 */
export function slabCoverage(
  s: SlabRegion,
  bounds: { min: THREE.Vector3; max: THREE.Vector3 },
  mode: SlabStepMode,
  fixed = 0,
): { index: number; total: number } {
  const n = slabNormal(s);
  // Project the bounds' 4 horizontal corners onto the normal to get the span
  // the slab must traverse.
  const corners: Vec2[] = [
    { x: bounds.min.x, y: bounds.min.y },
    { x: bounds.max.x, y: bounds.min.y },
    { x: bounds.min.x, y: bounds.max.y },
    { x: bounds.max.x, y: bounds.max.y },
  ];
  const mid = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of corners) {
    const d = (c.x - mid.x) * n.x + (c.y - mid.y) * n.y;
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  const step = Math.max(slabStepDistance(s, mode, fixed), 1e-9);
  const span = Math.max(hi - lo, 0);
  const total = Math.max(1, Math.ceil(span / step) + 1);
  const index = Math.min(total, Math.max(1, Math.round((s.offset - lo) / step) + 1));
  return { index, total };
}

/**
 * A slab seeded from a cloud's bounds: centred, running along +X, thin enough
 * to read. Used when the user asks for a section without drawing one.
 */
export function defaultSlabForBounds(
  bounds: { min: THREE.Vector3; max: THREE.Vector3 },
): SlabRegion {
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cy = (bounds.min.y + bounds.max.y) / 2;
  const spanX = Math.max(bounds.max.x - bounds.min.x, 1e-6);
  const spanY = Math.max(bounds.max.y - bounds.min.y, 1e-6);
  // A 50th of the cross-axis extent reads well on a tree without being so thin
  // that the section is mostly empty.
  const depth = Math.max(spanY / 50, 1e-3);
  const pad = Math.max((bounds.max.z - bounds.min.z) * 0.02, 1e-3);
  return {
    kind: 'slab',
    a: { x: cx - spanX / 2, y: cy },
    b: { x: cx + spanX / 2, y: cy },
    depth,
    zMin: bounds.min.z - pad,
    zMax: bounds.max.z + pad,
    offset: 0,
  };
}

/** Wire shape for the backend `slab` region kind. Mirrors main.py. */
export interface SlabRegionPayload {
  kind: 'slab';
  a: [number, number];
  b: [number, number];
  depth: number;
  zMin: number;
  zMax: number;
  offset: number;
}

export function slabToPayload(s: SlabRegion): SlabRegionPayload {
  return {
    kind: 'slab',
    a: [s.a.x, s.a.y],
    b: [s.b.x, s.b.y],
    depth: s.depth,
    zMin: s.zMin,
    zMax: s.zMax,
    offset: s.offset,
  };
}
