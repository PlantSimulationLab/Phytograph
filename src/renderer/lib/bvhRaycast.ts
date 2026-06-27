// Accelerated mesh raycasting via three-mesh-bvh.
//
// Why this exists: React Three Fiber's event system raycasts the scene on every
// pointerdown / pointerup / click AND on every wheel tick (see DOM_EVENTS in
// @react-three/fiber — `onWheel` runs the same intersection pipeline as the
// pointer handlers). Any mesh group that carries an event handler — the viewport
// mesh-selection `onClick` in PointCloudViewer — makes its mesh interactive, so
// R3F walks it triangle-by-triangle on the CPU for each of those events.
//
// On a multi-million-triangle triangulated surface that un-accelerated raycast
// is O(triangles) on the main thread, which manifested as:
//   • scroll-to-zoom lagging continuously (many wheel events → many raycasts),
//   • rotate / pan hanging for ~1-2 s at the START of a drag (the pointerdown
//     raycast), then running smooth (OrbitControls drives the move natively and
//     R3F doesn't re-raycast without hover handlers).
//
// Patching THREE.Mesh.prototype.raycast with three-mesh-bvh's acceleratedRaycast
// makes every one of those raycasts O(log n) against a prebuilt bounds tree.
// Meshes that have a boundsTree use it automatically; meshes without one fall
// back to the stock raycast, so this is safe to install globally and harmless
// for the small meshes (planes, plant leaves) we never build a tree for.
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// computeBoundsTree / disposeBoundsTree are patched onto BufferGeometry.prototype
// below; declared here for the type so callers don't reach for `any`.
type WithBoundsTree = THREE.BufferGeometry & {
  computeBoundsTree?: () => void;
  disposeBoundsTree?: () => void;
};

let installed = false;

// Install once, before any mesh renders (called from main.tsx). Idempotent.
export function installBvhRaycast(): void {
  if (installed) return;
  installed = true;
  (THREE.BufferGeometry.prototype as WithBoundsTree).computeBoundsTree = computeBoundsTree;
  (THREE.BufferGeometry.prototype as WithBoundsTree).disposeBoundsTree = disposeBoundsTree;
  // TEMP DIAGNOSTIC: log raycasts on large meshes so we can confirm a scroll-zoom
  // produces ZERO of them (only click/pointer-down should). Remove after verify.
  const accel = acceleratedRaycast as typeof THREE.Mesh.prototype.raycast;
  THREE.Mesh.prototype.raycast = function (this: THREE.Mesh, raycaster, intersects) {
    const tris = this.geometry.index
      ? this.geometry.index.count / 3
      : (this.geometry.getAttribute('position')?.count ?? 0) / 3;
    if (tris > 50000) console.warn(`[raycast] tris=${tris.toLocaleString()}`);
    accel.call(this, raycaster, intersects);
  };
}

// Build a BVH bounds tree on a mesh geometry so R3F's per-event scene raycasts
// (pointerdown/up/click, and every wheel tick) are O(log n) instead of
// O(triangles). One-time, runs on geometry (re)build — not per interaction.
// Guarded in case installBvhRaycast hasn't run (e.g. unit tests) so the mesh
// still renders. Pair with disposeBoundsTree() when the geometry is disposed.
export function buildBoundsTree(geo: THREE.BufferGeometry): void {
  const g = geo as WithBoundsTree;
  if (typeof g.computeBoundsTree === 'function') g.computeBoundsTree();
}

// Free the BVH (a large typed-array index) before disposing the geometry buffers.
export function freeBoundsTree(geo: THREE.BufferGeometry): void {
  const g = geo as WithBoundsTree;
  if (typeof g.disposeBoundsTree === 'function') g.disposeBoundsTree();
}
