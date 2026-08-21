import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  readBlockedRects,
  isPointBlocked,
  clampOutOfBlockers,
  clampToBounds,
  type BlockedRect,
  type ScreenPoint,
} from '../lib/viewportBlockers';

export interface ViewportBlockZone {
  /** Panel rects (viewer-local px) the tool's clicks can never reach. */
  rects: BlockedRect[];
  /** Pointer position, clamped out of those rects. Null until the first move. */
  cursor: ScreenPoint | null;
  /** True while the REAL pointer is on a blocker — a click now would be lost. */
  blocked: boolean;
}

interface Options {
  /** Called on every (rAF-throttled) move with the clamped point. */
  onMove?: (p: ScreenPoint, blocked: boolean) => void;
  /** Called on left-button release with the clamped point. */
  onRelease?: (p: ScreenPoint, e: MouseEvent) => void;
}

/**
 * Pointer tracking for the viewport's screen-space draw tools (crop lasso, crop
 * rect, trunk seeding), plus the geometry of what's in their way.
 *
 * Those tools live on SVG overlays at `z-10` inside the viewer pane, and the
 * floating panels paint above them — so the panels win hit-testing and the
 * overlay stops receiving events the moment the pointer crosses one. Handled on
 * the overlay alone that reads as a broken tool: the cursor preview freezes
 * mid-air and clicks quietly do nothing.
 *
 * Listening on the window instead keeps the preview alive everywhere, clamped
 * to the edge of whatever is in the way, and reports whether the true pointer is
 * in a spot the tool can't have. Callers pair it with `ViewportBlockedZone` to
 * draw the dead area rather than leave the user to discover it.
 *
 * The blockers are re-measured as the pointer moves (panels stay interactive
 * during a draw, so they can scroll, collapse or appear) and on resize.
 */
export function useViewportBlockZone(
  active: boolean,
  rootRef: RefObject<HTMLElement | null>,
  opts: Options = {},
): ViewportBlockZone {
  const rectsRef = useRef<BlockedRect[]>([]);
  const cursorRef = useRef<ScreenPoint | null>(null);
  const blockedRef = useRef(false);
  const [, setTick] = useState(0);

  // Latest callbacks without re-attaching listeners on every render.
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const root = rootRef.current;
    if (!active || !root) {
      rectsRef.current = [];
      blockedRef.current = false;
      return;
    }
    // Measure once up front so the zone is visible before the first move.
    rectsRef.current = readBlockedRects(root);
    setTick(t => t + 1);

    const resolve = (e: MouseEvent): ScreenPoint => {
      const bounds = root.getBoundingClientRect();
      const blockers = readBlockedRects(root);
      rectsRef.current = blockers;
      const raw = clampToBounds(
        { x: e.clientX - bounds.left, y: e.clientY - bounds.top },
        bounds.width,
        bounds.height,
      );
      const blocked = isPointBlocked(raw, blockers);
      blockedRef.current = blocked;
      // Pass the pane size so the escape stays on screen (a panel flush with the
      // pane edge would otherwise clamp to an invisible point just outside it).
      const p = blocked
        ? clampOutOfBlockers(raw, blockers, 2, { width: bounds.width, height: bounds.height })
        : raw;
      cursorRef.current = p;
      return p;
    };

    let pending: MouseEvent | null = null;
    let frame = 0;
    const onMove = (e: MouseEvent) => {
      pending = e;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!pending) return;
        const p = resolve(pending);
        optsRef.current.onMove?.(p, blockedRef.current);
        setTick(t => t + 1);
      });
    };
    const onUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const p = resolve(e);
      optsRef.current.onRelease?.(p, e);
      setTick(t => t + 1);
    };
    const onResize = () => {
      rectsRef.current = readBlockedRects(root);
      setTick(t => t + 1);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('resize', onResize);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', onResize);
    };
  }, [active, rootRef]);

  return {
    rects: active ? rectsRef.current : [],
    cursor: active ? cursorRef.current : null,
    blocked: active && blockedRef.current,
  };
}
