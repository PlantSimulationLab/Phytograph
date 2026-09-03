// Panel rows are `select-none` — dragging in the object list must not smear a
// text selection across the UI — but the detail blocks a row expands into are
// the one place there whose text users need to copy out: origin coordinates,
// extents, source file names, triangulation parameters, crown metrics. Those
// blocks opt back in with `select-text`, and this handler is the other half of
// that opt-in.
//
// The row's own onClick fires on the mouse-up that ENDS a selection drag, so
// without it, highlighting text inside an expanded block re-toggles the row's
// selection — for a solo-selected object that deselects it out from under the
// text just highlighted, and collapses the very block being read. Swallowing
// the click only when a non-empty selection actually exists keeps a plain click
// on the detail text selecting the row, the way it always has.

export const hasLiveTextSelection = (
  sel: { isCollapsed: boolean; toString(): string } | null,
): boolean => sel != null && !sel.isCollapsed && sel.toString().length > 0;

export function stopClickAfterTextSelection(e: {
  stopPropagation(): void;
}): void {
  if (hasLiveTextSelection(window.getSelection())) e.stopPropagation();
}
