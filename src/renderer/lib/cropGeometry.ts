import * as THREE from 'three';

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

// World-space axis-aligned crop box. Used uniformly across all selected
// clouds — each cloud's translated points are tested against the same
// world-space min/max.
export interface CropBoxRegion {
  mode: 'box';
  min: Vec3;
  max: Vec3;
  invert: boolean;
}

// Screen-space polygon ("lasso") crop. Points are projected through the
// frozen camera matrices (captured when the polygon was closed) so the
// in/out test is stable even if the user orbits afterwards.
export interface CropPolygonRegion {
  mode: 'polygon';
  // Polygon vertices in canvas-pixel space (origin top-left).
  points: Vec2[];
  // Snapshot of camera.projectionMatrix and camera.matrixWorldInverse at
  // the moment the polygon was closed. Stored as 16-element row-major
  // arrays so the region is serializable / state-stable.
  projection: number[];
  view: number[];
  canvasSize: CanvasSize;
  invert: boolean;
}

export type CropRegion = CropBoxRegion | CropPolygonRegion;

// Standard ray-casting point-in-polygon test. Treats the polygon as a
// closed loop (last vertex connects back to first). Edge points return
// implementation-defined but consistent results, which is fine for
// pixel-snapping a crop lasso.
export function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  const { x, y } = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Project a world-space point through `projection * view`, perform the
// perspective divide, and convert from NDC to canvas pixel coordinates
// (origin top-left, y-down). Returns null when the point is behind the
// camera (w <= 0) — callers should treat that as "outside the polygon".
export function projectWorldToCanvasPixel(
  world: Vec3,
  projection: number[],
  view: number[],
  canvasSize: CanvasSize,
): Vec2 | null {
  // Compose projection * view * [x, y, z, 1] manually so this helper has
  // no dependency on THREE.Vector3 instances (keeps it cheap to call in
  // tight inner loops over millions of points).
  const vx =
    view[0] * world.x + view[4] * world.y + view[8] * world.z + view[12];
  const vy =
    view[1] * world.x + view[5] * world.y + view[9] * world.z + view[13];
  const vz =
    view[2] * world.x + view[6] * world.y + view[10] * world.z + view[14];
  const vw =
    view[3] * world.x + view[7] * world.y + view[11] * world.z + view[15];

  const cx =
    projection[0] * vx + projection[4] * vy + projection[8] * vz + projection[12] * vw;
  const cy =
    projection[1] * vx + projection[5] * vy + projection[9] * vz + projection[13] * vw;
  const cw =
    projection[3] * vx + projection[7] * vy + projection[11] * vz + projection[15] * vw;

  if (cw <= 0) return null;

  const ndcX = cx / cw;
  const ndcY = cy / cw;

  return {
    x: ((ndcX + 1) / 2) * canvasSize.width,
    y: ((1 - ndcY) / 2) * canvasSize.height,
  };
}

// Compute the world-space AABB enclosing every cloud's translated bounds.
// Used to initialize the crop box when entering crop mode and to clamp
// the auto-Z extent of the two-click ground-plane draw gesture.
export function worldBoundsUnion(
  clouds: { bounds: { min: Vec3; max: Vec3 }; translation: Vec3 }[],
): { min: Vec3; max: Vec3 } | null {
  if (clouds.length === 0) return null;
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const c of clouds) {
    min.x = Math.min(min.x, c.bounds.min.x + c.translation.x);
    min.y = Math.min(min.y, c.bounds.min.y + c.translation.y);
    min.z = Math.min(min.z, c.bounds.min.z + c.translation.z);
    max.x = Math.max(max.x, c.bounds.max.x + c.translation.x);
    max.y = Math.max(max.y, c.bounds.max.y + c.translation.y);
    max.z = Math.max(max.z, c.bounds.max.z + c.translation.z);
  }
  return { min, max };
}

// Convenience: build a polygon region from a live three.js camera. The
// camera's matrices are snapshotted into plain arrays so the region
// stays valid after the camera moves.
//
// `displayOffset` (Layer 2 precision safety net): the live camera renders in
// DISPLAY space (world − offset), but the backend reprojects TRUE WORLD
// positions through the frozen `view` matrix. So we convert the display view
// V_disp into the world view V_world = V_disp · T(−offset) before freezing it.
// The projection matrix is unaffected by the uniform translation (it consumes
// only eye space) and is frozen as-is. Pass {0,0,0} (the default) for
// small-coord scenes — then V_world === V_disp and nothing changes.
export function polygonRegionFromCamera(
  points: Vec2[],
  camera: THREE.Camera,
  canvasSize: CanvasSize,
  invert: boolean,
  displayOffset: Vec3 = { x: 0, y: 0, z: 0 },
): CropPolygonRegion {
  camera.updateMatrixWorld();
  const view =
    displayOffset.x === 0 && displayOffset.y === 0 && displayOffset.z === 0
      ? camera.matrixWorldInverse.toArray()
      : camera.matrixWorldInverse
          .clone()
          .multiply(
            new THREE.Matrix4().makeTranslation(
              -displayOffset.x,
              -displayOffset.y,
              -displayOffset.z,
            ),
          )
          .toArray();
  return {
    mode: 'polygon',
    points: points.map((p) => ({ x: p.x, y: p.y })),
    projection: camera.projectionMatrix.toArray(),
    view,
    canvasSize: { width: canvasSize.width, height: canvasSize.height },
    invert,
  };
}
