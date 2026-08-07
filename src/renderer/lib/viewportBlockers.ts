// Which parts of the viewport a screen-space draw tool (crop lasso / crop rect)
// can actually reach.
//
// The crop overlays are SVGs at `absolute inset-0 z-10` inside the viewer pane.
// The floating panels — the right-hand stack (z-30), the Crop panel (z-20), the
// Display settings bubble (z-55) — paint ABOVE them, so hit-testing gives those
// panels every pointer event over their boxes. The user experience was: the
// rubber-band line froze the moment the cursor crossed onto a panel (the overlay
// stopped receiving mousemove), and clicks there silently did nothing. Nothing
// said why.
//
// These helpers turn that implicit dead zone into geometry the UI can clamp
// against (and mark the cursor with a ⊘ on). `readBlockedRects` measures the
// blockers at draw time rather than hardcoding panel geometry, so a panel that
// is added, collapsed, scrolled, or moved later is handled without touching this
// file — and, critically, measures only what is really there: see SHELL_ATTR.
export interface BlockedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

/** z-index of the crop overlays (`z-10`). Anything above this occludes them. */
export const CROP_OVERLAY_Z = 10;

/**
 * Elements that float over the viewport from OUTSIDE its DOM subtree (toasts).
 * Their wrapper is `pointer-events-none`, so it's the live cards inside it that
 * block; the wrapper carries the marker.
 */
const PORTAL_SELECTOR = '[data-blocks-viewport]';

/**
 * Marks a LAYOUT CONTAINER: an element that positions floating panels but whose
 * own box is larger than what it actually holds. The right-hand panel stack is
 * the case that matters — it is pinned `top-4 bottom-[4.5rem]`, so it spans the
 * viewport's full height whatever it contains. Measuring the container made the
 * entire right edge refuse clicks when a single ~200px panel was in the way.
 *
 * Marked explicitly rather than inferred (e.g. from "has no background"): a
 * panel's styling should never silently decide whether its clicks are blocked.
 */
const SHELL_ATTR = 'data-viewport-panel-stack';

/**
 * Measure the floating panels that sit above `overlayZ` and accept pointer
 * events — i.e. the regions where a crop overlay can never see a click.
 * Returned rects are in root-local pixels (the same space the overlays record
 * their vertices in), clipped to the pane.
 *
 * Scanning is shallow by design. A panel nested inside a blocker is already
 * covered by its ancestor's box (which is what actually swallows the event), and
 * an element whose `z-index` is `auto` paints *below* a `z-10` overlay no matter
 * its DOM order, so it can't block.
 *
 * Two kinds of element are stepped INTO rather than measured, because their own
 * box is bigger than anything that actually takes a click:
 *
 * - A `pointer-events: none` shell (toast stack, compass wrapper), whose raised
 *   stacking context lifts its children above the overlay even though the shell
 *   itself passes clicks through.
 * - An element marked `SHELL_ATTR` — a layout container. See that constant.
 *
 * Either way the shell never becomes a rect, and one with no children blocks
 * nothing at all.
 */
export function readBlockedRects(root: HTMLElement, overlayZ: number = CROP_OVERLAY_Z): BlockedRect[] {
  const rootRect = root.getBoundingClientRect();
  const out: BlockedRect[] = [];

  const visit = (el: Element, aboveOverlay: boolean, depth: number) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
    const z = parseInt(style.zIndex, 10);
    const above = aboveOverlay || (Number.isFinite(z) && z > overlayZ);
    if (!above) return; // paints under the overlay — and so does everything inside it
    if (style.pointerEvents === 'none' || el.hasAttribute(SHELL_ATTR)) {
      // A shell: it either passes clicks straight through, or is a layout
      // container whose own box is bigger than what it holds. Measuring it would
      // report empty space as blocked, so measure its children — and if it has
      // none, it blocks nothing at all.
      if (depth < 2) {
        for (const child of Array.from(el.children)) {
          if (child instanceof HTMLElement) visit(child, true, depth + 1);
        }
      }
      return;
    }
    const r = el.getBoundingClientRect();
    // Clip to the pane: a `fixed` toast stack spans the window, not the viewer.
    const x = Math.max(r.left, rootRect.left);
    const y = Math.max(r.top, rootRect.top);
    const width = Math.min(r.right, rootRect.right) - x;
    const height = Math.min(r.bottom, rootRect.bottom) - y;
    if (width < 1 || height < 1) return;
    out.push({ x: x - rootRect.left, y: y - rootRect.top, width, height });
  };

  for (const el of Array.from(root.children)) visit(el, false, 0);
  for (const portal of Array.from(root.ownerDocument.querySelectorAll(PORTAL_SELECTOR))) {
    if (root.contains(portal)) continue; // already visited above
    visit(portal, false, 0);
  }
  return out;
}

function inside(p: ScreenPoint, r: BlockedRect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** True when `p` lands on one of the blocking panels (so a click there is lost). */
export function isPointBlocked(p: ScreenPoint, rects: readonly BlockedRect[]): boolean {
  return rects.some(r => inside(p, r));
}

/**
 * Move `p` to the nearest point the draw tools can actually reach. Used for the
 * rubber-band preview: instead of freezing mid-air when the cursor slides under
 * a panel, the line tracks the boundary of the dead zone — the visible statement
 * that this is as far as the tool goes.
 *
 * Candidates are the four edges (plus `margin`) of every blocker, each tested
 * against ALL blockers before being accepted, so abutting panels (the crop panel
 * sits flush against the right-hand stack) resolve in one step instead of
 * bouncing between the two. Pass `bounds` (the pane's size) to prefer exits that
 * stay on screen: a panel flush with the pane edge would otherwise clamp to a
 * point just outside it, where the marker is invisible. If nothing is reachable,
 * `p` comes back unchanged — the caller already knows it's blocked via
 * `isPointBlocked`.
 */
export function clampOutOfBlockers(
  p: ScreenPoint,
  rects: readonly BlockedRect[],
  margin = 2,
  bounds?: { width: number; height: number },
): ScreenPoint {
  if (!isPointBlocked(p, rects)) return p;
  const inBounds = (c: ScreenPoint) =>
    !bounds || (c.x >= 0 && c.y >= 0 && c.x <= bounds.width && c.y <= bounds.height);
  let best: ScreenPoint | null = null;
  let bestDist = Infinity;
  let fallback: ScreenPoint | null = null;
  let fallbackDist = Infinity;
  for (const r of rects) {
    const candidates: ScreenPoint[] = [
      { x: r.x - margin, y: p.y },
      { x: r.x + r.width + margin, y: p.y },
      { x: p.x, y: r.y - margin },
      { x: p.x, y: r.y + r.height + margin },
    ];
    for (const c of candidates) {
      if (isPointBlocked(c, rects)) continue;
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (inBounds(c)) {
        if (d < bestDist) { bestDist = d; best = c; }
      } else if (d < fallbackDist) {
        fallbackDist = d;
        fallback = c;
      }
    }
  }
  return best ?? fallback ?? p;
}

/** Clamp to the viewer pane itself, so a pointer dragged off-window still reads back. */
export function clampToBounds(p: ScreenPoint, width: number, height: number): ScreenPoint {
  return {
    x: Math.max(0, Math.min(width, p.x)),
    y: Math.max(0, Math.min(height, p.y)),
  };
}
