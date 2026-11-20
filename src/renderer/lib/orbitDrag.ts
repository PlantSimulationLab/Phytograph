/**
 * The camera's left-drag orbit, as a pure step over pointer events, so the
 * rule that decides whether a pointermove rotates is testable on its own.
 *
 * A drag starts on a left press on the canvas and ends on pointerup. If that
 * pointerup never arrives (released outside the window, a dialog grabbed it,
 * a platform that dropped it), the drag used to stay live, and the next plain
 * hover rotated the camera. A pointermove always says which buttons are held,
 * so a move with the left button up ends the drag instead of rotating.
 *
 * Issue #8: on Linux CI the camera's drag-rotate fired during a click in the
 * point-picker spec, swinging the camera from above the cloud to below it,
 * although the test never moves with a button held. A stuck drag is one way
 * that happens; this guard closes it. Whether it was THE cause is not proven
 * (the click trace in point-pick.spec.ts will say).
 */

export interface OrbitDragState {
  dragging: boolean;
  last: { x: number; y: number };
}

export interface OrbitPointer {
  clientX: number;
  clientY: number;
  /** PointerEvent.buttons: bit 0 is the primary (left) button. */
  buttons: number;
}

/** The state after a left press that may start a drag. */
export function orbitDragStart(p: Pick<OrbitPointer, 'clientX' | 'clientY'>): OrbitDragState {
  return { dragging: true, last: { x: p.clientX, y: p.clientY } };
}

/**
 * One pointermove. Returns the next state and the rotation to apply, or null
 * for none: not dragging, the left button no longer held (the drag ends), or
 * no movement.
 */
export function orbitDragMove(
  state: OrbitDragState,
  p: OrbitPointer,
): { state: OrbitDragState; rotate: { dx: number; dy: number } | null } {
  if (!state.dragging) return { state, rotate: null };
  if ((p.buttons & 1) === 0) return { state: { ...state, dragging: false }, rotate: null };
  const dx = p.clientX - state.last.x;
  const dy = p.clientY - state.last.y;
  if (dx === 0 && dy === 0) return { state, rotate: null };
  return { state: { dragging: true, last: { x: p.clientX, y: p.clientY } }, rotate: { dx, dy } };
}
