/**
 * Header row of a floating tool panel whose root is the scroll container
 * (`p-3 … overflow-y-auto`). Pins the title and the close button to the top of
 * the panel so a long panel scrolled to its bottom can still be closed.
 *
 * The negative margins pull the row over the root's `p-3` so nothing scrolls
 * past in the gap above or beside it, and the background is opaque (the panel
 * itself is translucent) so the content passing underneath does not show
 * through the title. Use in place of the header's `mb-3`.
 */
export const STICKY_PANEL_HEADER =
  'sticky top-0 z-10 -mx-3 -mt-3 mb-3 px-3 pt-3 pb-2 bg-neutral-800 rounded-t-lg border-b border-neutral-700/60';
