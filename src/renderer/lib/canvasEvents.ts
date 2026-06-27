// Custom R3F event manager that drops wheel raycasting.
//
// React Three Fiber raycasts the scene on every DOM event it binds so it can
// dispatch synthetic events to whatever object sits under the cursor. `wheel` is
// in that list (see DOM_EVENTS in @react-three/fiber), so a scroll-to-zoom fires
// a full-scene raycast even though nothing in this app handles a wheel hit —
// OrbitControls reads the wheel straight off the canvas DOM element, not through
// R3F's synthetic events, and no 3D object carries an onWheel handler.
//
// On a multi-million-triangle mesh that per-wheel raycast was the dominant cost
// (the three-mesh-bvh BVH already cut each raycast from ~280 ms to ~0.1 ms, but
// 0.1 ms × every wheel tick is still pure waste). Dropping R3F's onWheel handler
// makes a zoom do zero scene raycasting. Pointer-down / click still raycast —
// that's what drives viewport mesh selection — so nothing user-facing changes.
//
// `createPointerEvents` is the default web event manager, re-exported from the
// package root as `events`.
import { events as createPointerEvents } from '@react-three/fiber';
import type { RootStore, EventManager } from '@react-three/fiber';

export function createNoWheelPointerEvents(store: RootStore): EventManager<HTMLElement> {
  const manager = createPointerEvents(store);
  // Replace onWheel with a no-op IN PLACE so R3F never raycasts on scroll. Every
  // other handler (pointerdown/up/move/click/…) stays intact. Mutating the
  // existing handlers object (rather than spreading into a new one) keeps the
  // exact `Events` type — all keys stay defined — and is what `connect` iterates.
  if (manager.handlers) manager.handlers.onWheel = () => {};
  return manager;
}
