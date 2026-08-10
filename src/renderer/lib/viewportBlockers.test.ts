import { describe, it, expect } from 'vitest';
import {
  readBlockedRects,
  isPointBlocked,
  clampOutOfBlockers,
  clampToBounds,
  CROP_OVERLAY_Z,
  type BlockedRect,
} from './viewportBlockers';

// happy-dom has no layout engine, so every getBoundingClientRect is 0×0. Stub
// the geometry per element to model the real viewer: a full-pane root with
// floating panels absolutely positioned inside it.
function stubRect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  (el as HTMLElement).getBoundingClientRect = () => ({
    left: r.left,
    top: r.top,
    right: r.left + r.width,
    bottom: r.top + r.height,
    width: r.width,
    height: r.height,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  }) as DOMRect;
}

// Root pane is offset inside the window (the app toolbar is above it) so the
// tests also cover the client→root-local conversion.
const ROOT = { left: 100, top: 50, width: 1000, height: 700 };

function makeRoot(): HTMLDivElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  stubRect(root, ROOT);
  return root;
}

function addChild(
  root: HTMLElement,
  css: Partial<CSSStyleDeclaration> & { zIndex?: string },
  rect: { left: number; top: number; width: number; height: number },
): HTMLDivElement {
  const el = document.createElement('div');
  Object.assign(el.style, css);
  root.appendChild(el);
  stubRect(el, rect);
  return el;
}

describe('readBlockedRects', () => {
  it('returns panels above the overlay z, in root-local coordinates', () => {
    const root = makeRoot();
    // The right-hand panel stack: z-30, 256px wide, inset 16px from the right.
    addChild(root, { position: 'absolute', zIndex: '30' }, {
      left: ROOT.left + 728, top: ROOT.top + 16, width: 256, height: 600,
    });

    const rects = readBlockedRects(root);
    expect(rects).toEqual([{ x: 728, y: 16, width: 256, height: 600 }]);
  });

  it('measures the panels inside a marked stack, not the stack itself', () => {
    const root = makeRoot();
    // The real regression: the right-hand stack is pinned `top-4 bottom-[4.5rem]`,
    // so it spans nearly the whole pane no matter how little it holds. With one
    // scan loaded it carries a single ~200px panel — but measuring the SHELL
    // refused clicks down the entire right edge, over empty space where nothing
    // could swallow them.
    const stack = addChild(root, { position: 'absolute', zIndex: '30' }, {
      left: ROOT.left + 728, top: ROOT.top + 16, width: 256, height: 612,
    });
    stack.setAttribute('data-viewport-panel-stack', '');
    const panel = document.createElement('div');
    stack.appendChild(panel);
    stubRect(panel, { left: ROOT.left + 728, top: ROOT.top + 16, width: 256, height: 200 });

    // Only the panel's own 200px — the ~400px of empty stack below it is free.
    expect(readBlockedRects(root)).toEqual([{ x: 728, y: 16, width: 256, height: 200 }]);
  });

  it('keeps an empty marked stack from blocking anything at all', () => {
    const root = makeRoot();
    // No scans loaded: the stack is still full-height, but holds nothing.
    const stack = addChild(root, { position: 'absolute', zIndex: '30' }, {
      left: ROOT.left + 728, top: ROOT.top + 16, width: 256, height: 612,
    });
    stack.setAttribute('data-viewport-panel-stack', '');

    expect(readBlockedRects(root)).toEqual([]);
  });

  it('ignores the overlays themselves and anything at or below their z', () => {
    const root = makeRoot();
    // The lasso overlay (z-10) must never count as its own blocker.
    addChild(root, { position: 'absolute', zIndex: String(CROP_OVERLAY_Z) }, {
      left: ROOT.left, top: ROOT.top, width: ROOT.width, height: ROOT.height,
    });
    // A z-index:auto element paints BELOW a z-10 overlay whatever the DOM
    // order, so it doesn't block either (e.g. the bottom-left legend).
    addChild(root, { position: 'absolute' }, {
      left: ROOT.left + 16, top: ROOT.top + 640, width: 200, height: 40,
    });

    expect(readBlockedRects(root)).toEqual([]);
  });

  it('ignores pointer-events:none decoration layers above the overlay', () => {
    const root = makeRoot();
    // The compass / view-hint pills sit above the overlay but pass clicks
    // through — they are not blockers, and neither is the hatch layer itself.
    addChild(root, { position: 'absolute', zIndex: '20', pointerEvents: 'none' }, {
      left: ROOT.left + 800, top: ROOT.top + 600, width: 120, height: 120,
    });

    expect(readBlockedRects(root)).toEqual([]);
  });

  it('descends one level into a click-through shell for its live children', () => {
    const root = makeRoot();
    // A raised pointer-events-none wrapper (toast stack, overlay column) still
    // lifts its children above the overlay, and those children DO take clicks.
    const shell = addChild(root, { position: 'absolute', zIndex: '110', pointerEvents: 'none' }, {
      left: ROOT.left + 700, top: ROOT.top + 20, width: 280, height: 660,
    });
    const card = document.createElement('div');
    Object.assign(card.style, { pointerEvents: 'auto' });
    shell.appendChild(card);
    stubRect(card, { left: ROOT.left + 760, top: ROOT.top + 600, width: 220, height: 60 });

    expect(readBlockedRects(root)).toEqual([{ x: 760, y: 600, width: 220, height: 60 }]);
  });

  it('includes marked out-of-tree overlays (toasts), clipped to the pane', () => {
    const root = makeRoot();
    // Toasts are `fixed` and live outside the viewer's subtree, so they're found
    // by marker, not by parentage — and their box can hang past the pane.
    const portal = document.createElement('div');
    portal.setAttribute('data-blocks-viewport', '');
    Object.assign(portal.style, { position: 'fixed', zIndex: '110', pointerEvents: 'none' });
    document.body.appendChild(portal);
    stubRect(portal, { left: ROOT.left + 800, top: 0, width: 200, height: 900 });
    const card = document.createElement('div');
    Object.assign(card.style, { pointerEvents: 'auto' });
    portal.appendChild(card);
    // Extends 40px above the pane's top edge.
    stubRect(card, { left: ROOT.left + 800, top: ROOT.top - 40, width: 200, height: 100 });

    try {
      expect(readBlockedRects(root)).toEqual([{ x: 800, y: 0, width: 200, height: 60 }]);
    } finally {
      portal.remove();
    }
  });

  it('ignores hidden and zero-size panels', () => {
    const root = makeRoot();
    addChild(root, { position: 'absolute', zIndex: '30', display: 'none' }, {
      left: ROOT.left + 700, top: ROOT.top, width: 256, height: 400,
    });
    addChild(root, { position: 'absolute', zIndex: '30', visibility: 'hidden' }, {
      left: ROOT.left + 700, top: ROOT.top, width: 256, height: 400,
    });
    // A collapsed panel measuring 0×0 would otherwise hatch a degenerate rect.
    addChild(root, { position: 'absolute', zIndex: '55' }, {
      left: ROOT.left + 700, top: ROOT.top, width: 0, height: 0,
    });

    expect(readBlockedRects(root)).toEqual([]);
  });

  it('collects every blocking panel (stack + crop panel + display bubble)', () => {
    const root = makeRoot();
    addChild(root, { position: 'absolute', zIndex: '30' }, {
      left: ROOT.left + 728, top: ROOT.top + 16, width: 256, height: 560,
    });
    addChild(root, { position: 'absolute', zIndex: '20' }, {
      left: ROOT.left + 496, top: ROOT.top + 16, width: 224, height: 380,
    });
    addChild(root, { position: 'absolute', zIndex: '55' }, {
      left: ROOT.left + 792, top: ROOT.top + 592, width: 192, height: 92,
    });

    expect(readBlockedRects(root).map(r => r.x)).toEqual([728, 496, 792]);
  });

  it('a tool panel with NO z-index blocks nothing — the regression', () => {
    // A floating panel that forgets its z-index is invisible to this scan AND
    // paints below the z-10 lasso overlay, so the overlay swallows every click
    // over it: the panel cannot be used or even closed, and each click just
    // drops another lasso vertex on top of it. This bit the labelling panel.
    const root = makeRoot();
    addChild(root, { position: 'absolute' }, {
      left: ROOT.left + 700, top: ROOT.top + 16, width: 256, height: 400,
    });
    expect(readBlockedRects(root)).toEqual([]);

    // With z-20 (what CropPanel and LabelPanel both carry) it is measured, so
    // the lasso refuses clicks there instead of eating them.
    const root2 = makeRoot();
    addChild(root2, { position: 'absolute', zIndex: '20' }, {
      left: ROOT.left + 700, top: ROOT.top + 16, width: 256, height: 400,
    });
    const rects = readBlockedRects(root2);
    expect(rects).toEqual([{ x: 700, y: 16, width: 256, height: 400 }]);
    // ...and a click in the middle of it is refused.
    expect(isPointBlocked({ x: 800, y: 200 }, rects)).toBe(true);
  });
});

describe('isPointBlocked', () => {
  const panel: BlockedRect = { x: 700, y: 10, width: 250, height: 600 };

  it('is true inside a panel and on its edge, false outside', () => {
    expect(isPointBlocked({ x: 800, y: 300 }, [panel])).toBe(true);
    expect(isPointBlocked({ x: 700, y: 10 }, [panel])).toBe(true);
    expect(isPointBlocked({ x: 699, y: 300 }, [panel])).toBe(false);
    expect(isPointBlocked({ x: 800, y: 700 }, [panel])).toBe(false);
  });

  it('is false when nothing floats over the viewport', () => {
    expect(isPointBlocked({ x: 800, y: 300 }, [])).toBe(false);
  });
});

describe('clampOutOfBlockers', () => {
  const panel: BlockedRect = { x: 700, y: 100, width: 200, height: 400 };

  it('leaves a reachable point untouched', () => {
    const p = { x: 400, y: 300 };
    expect(clampOutOfBlockers(p, [panel])).toEqual(p);
  });

  it('pushes to the nearest edge, keeping the other axis — the preview tracks the boundary', () => {
    // Deep inside on the left half → out through the left edge, same y. This is
    // the common case: the panels line the right edge of the viewport.
    expect(clampOutOfBlockers({ x: 750, y: 300 }, [panel], 2)).toEqual({ x: 698, y: 300 });
    // Nearer the right edge → out to the right.
    expect(clampOutOfBlockers({ x: 880, y: 300 }, [panel], 2)).toEqual({ x: 902, y: 300 });
    // Nearer the top → out through the top, same x.
    expect(clampOutOfBlockers({ x: 800, y: 120 }, [panel], 2)).toEqual({ x: 800, y: 98 });
    // Nearer the bottom → out through the bottom.
    expect(clampOutOfBlockers({ x: 800, y: 480 }, [panel], 2)).toEqual({ x: 800, y: 502 });
  });

  it('escapes abutting panels in one step (the crop panel is flush with the stack)', () => {
    // The real geometry: the crop panel's right edge touches the stack's left
    // edge, so "nearest edge of the panel I'm in" would bounce between the two
    // and leave the cursor blocked. Every candidate is validated against BOTH,
    // so the result is genuinely reachable — here the 16px gutter to the right
    // of the stack (182px away) beats the crop panel's left edge (222px).
    const stack: BlockedRect = { x: 700, y: 0, width: 200, height: 700 };
    const crop: BlockedRect = { x: 500, y: 0, width: 200, height: 400 };
    const out = clampOutOfBlockers({ x: 720, y: 200 }, [stack, crop], 2);
    expect(isPointBlocked(out, [stack, crop])).toBe(false);
    expect(out).toEqual({ x: 902, y: 200 });
  });

  it('never returns a point that is still blocked', () => {
    // Degenerate: a blocker covering the whole pane. The escape leaves the
    // blocker (past its nearest edge) rather than sitting inside it — the
    // caller still flags the cursor as refused via isPointBlocked.
    const everything: BlockedRect = { x: 0, y: 0, width: 4000, height: 4000 };
    const out = clampOutOfBlockers({ x: 100, y: 100 }, [everything], 2);
    expect(isPointBlocked(out, [everything])).toBe(false);
    expect(out).toEqual({ x: -2, y: 100 });
  });

  it('prefers an escape that stays inside the pane when bounds are given', () => {
    // A panel flush with the pane's right edge: exiting right is nearer but
    // lands off-screen, where the ⊘ marker and preview line would be invisible.
    const flush: BlockedRect = { x: 700, y: 0, width: 300, height: 700 };
    const bounds = { width: 1000, height: 700 };
    expect(clampOutOfBlockers({ x: 900, y: 350 }, [flush], 2, bounds)).toEqual({ x: 698, y: 350 });
    // Without bounds the nearest edge still wins, off-screen or not.
    expect(clampOutOfBlockers({ x: 900, y: 350 }, [flush], 2)).toEqual({ x: 1002, y: 350 });
  });

  it('falls back to an out-of-bounds escape when every in-pane exit is blocked', () => {
    // Panels tile the pane: nothing on screen is reachable, so an off-screen
    // exit beats returning a point that is still inside a blocker.
    const left: BlockedRect = { x: 0, y: 0, width: 500, height: 700 };
    const right: BlockedRect = { x: 500, y: 0, width: 500, height: 700 };
    const out = clampOutOfBlockers({ x: 600, y: 350 }, [left, right], 2, { width: 1000, height: 700 });
    expect(isPointBlocked(out, [left, right])).toBe(false);
    expect(out).toEqual({ x: 600, y: -2 }); // nearest of the off-screen exits

  });
});

describe('clampToBounds', () => {
  it('keeps a pointer dragged off-window inside the pane', () => {
    expect(clampToBounds({ x: -40, y: 900 }, 1000, 700)).toEqual({ x: 0, y: 700 });
    expect(clampToBounds({ x: 1200, y: -5 }, 1000, 700)).toEqual({ x: 1000, y: 0 });
    expect(clampToBounds({ x: 500, y: 300 }, 1000, 700)).toEqual({ x: 500, y: 300 });
  });
});
