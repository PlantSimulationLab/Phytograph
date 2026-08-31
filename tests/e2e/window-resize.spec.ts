import { test, expect } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers/launchApp';

// Window-resize layout regressions, driven against the real BrowserWindow:
//
// 1. Canvas ratchet: the viewer's flex chain (App renderViewer wrappers →
//    PointCloudViewer root) lacked min-h-0, so the R3F canvas's intrinsic
//    pixel height propped up every ancestor's min-content height. The canvas
//    grew with the window but never shrank back, pushing the bottom-anchored
//    overlays (axes gizmo, toolbar column, status bar) below the window where
//    they were clipped.
//
// 2. Minimum height: the window's minHeight (800, capped to the display work
//    area) must be tall enough that the left toolbar column renders all its
//    cards without scroll-cropping.
//
// 3. Gizmo placement: at heights where the under-column lane doesn't exist,
//    the axes gizmo must sit clear of the toolbar column's footprint (it used
//    to hide behind the translucent Tools card, which also ate its clicks).

async function setWindowSize(launched: LaunchedApp, w: number, h: number) {
  // setContentSize, NOT setSize. setSize sets the OUTER frame, and every
  // assertion here — the innerWidth poll below, the canvas rect, the
  // `canvas.w === 950` check — is about the CONTENT area. On macOS and Linux
  // the left/right frame is 0px so the two happen to coincide and setSize
  // passed; Windows draws an ~8px resize border per side, so `setSize(1600)`
  // yields innerWidth 1584 and a poll for |innerWidth - 1600| <= 2 can never
  // succeed. That is not a resize that was too slow, it is one whose target
  // the platform cannot express — it failed identically on every attempt.
  // Setting the content size states what the test actually means and makes the
  // three platforms agree.
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.w, size.h);
  }, { w, h });
  // Wait for the resize to actually land in the renderer instead of sleeping a
  // fixed interval. The chain is X11/WM → Electron → window.innerWidth →
  // ResizeObserver → react-use-measure → R3F gl.setSize → canvas rect, and on
  // the headless CI runner (Xvfb + a synthetic WM, two Playwright workers) that
  // takes longer than the 500 ms this used to allow. The old sleep returned
  // mid-flight, so `layout()` read the PREVIOUS size: after growing to 1600 and
  // shrinking to 950 the canvas still measured 1600, which reads exactly like
  // the historical "canvas ratchet" bug this spec guards against. Locally the
  // round-trip is ~50 ms, which is why only CI ever saw it.
  //
  // Settle on window.innerWidth first (the DOM viewport), then require the
  // canvas rect to MATCH it and hold still for two consecutive reads. Both
  // halves matter: "held still" alone is satisfied by a canvas that has not
  // started resizing yet, which is what let this return mid-flight.
  // A bare timeout here is undiagnosable: it says the width never arrived, not
  // WHY. The usual why is that the display cannot grant it — the OS clamps a
  // window to the work area, so on a 1280-wide runner `setSize(1600, …)`
  // silently yields ~1280 and this poll can never succeed. ci.yml already hit
  // exactly that on Linux and fixed it by giving Xvfb `-screen 0 1920x1080x24`.
  // Report the work area and the bounds the OS actually granted, so the next
  // reader gets the diagnosis instead of a stack trace.
  try {
    await launched.page.waitForFunction(
      (expected) => Math.abs(window.innerWidth - expected) <= 2,
      w,
      { timeout: 20_000 },
    );
  } catch (err) {
    const diag = await launched.app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const d = screen.getPrimaryDisplay();
      return {
        bounds: win?.getBounds(),
        workArea: d.workAreaSize,
        screen: d.size,
        scaleFactor: d.scaleFactor,
      };
    });
    const innerWidth = await launched.page.evaluate(() => window.innerWidth);
    throw new Error(
      `window never reached ${w}x${h}. innerWidth=${innerWidth}, ` +
        `granted bounds=${JSON.stringify(diag.bounds)}, ` +
        `workArea=${JSON.stringify(diag.workArea)}, ` +
        `screen=${JSON.stringify(diag.screen)}@${diag.scaleFactor}x. ` +
        `If the work area is narrower than ${w}, the display cannot grant this ` +
        `size and the runner needs a larger screen (see ci.yml's xvfb ` +
        `-screen 0 1920x1080x24).\n${(err as Error).message}`,
    );
  }
  // Clear the probe before every poll. It used to persist across calls, so the
  // "held still for two reads" test could be satisfied by a value left behind
  // by the PREVIOUS resize rather than by two reads of the current one.
  await launched.page.evaluate(() => { delete (window as any).__lastCanvasProbe; });
  try {
    await launched.page.waitForFunction(() => {
      const c = document.querySelector('canvas');
      if (!c) return false;
      const r = c.getBoundingClientRect();
      // The canvas must AGREE with the viewport, not merely hold still. The old
      // guard was `r.width <= window.innerWidth + 1`, which constrains only the
      // SHRINK direction — and the grow phase is where this poll is load-bearing.
      // Growing to 1600 leaves a not-yet-resized canvas at its launch 1200, where
      // `1200 <= 1601` is trivially true; two 100ms polls of a canvas sitting
      // still at the OLD size then read as "settled", and layout() measured 1200.
      // That is exactly how this returned mid-flight on a slow macOS runner
      // (run 33375915377) while reporting no diagnostic at all. The canvas is
      // full-bleed — the spec's own `canvas.w === 950` at a 950 viewport says so
      // — so equality with innerWidth is the correct invariant, not an upper bound.
      if (Math.abs(r.width - window.innerWidth) > 2) return false;
      const probe = `${Math.round(r.width)}x${Math.round(r.height)}`;
      const prev = (window as any).__lastCanvasProbe;
      (window as any).__lastCanvasProbe = probe;
      return prev === probe;
    }, undefined, { timeout: 20_000, polling: 100 });
  } catch (err) {
    // The viewport poll above already succeeded, so the window DID reach the
    // requested size and the display is not the problem. Say that outright and
    // report the gap the canvas failed to close — a bare timeout here would
    // otherwise be read as the display clamp diagnosed above it.
    const seen = await launched.page.evaluate(() => {
      const c = document.querySelector('canvas');
      const r = c?.getBoundingClientRect();
      return { canvasW: r?.width ?? null, canvasH: r?.height ?? null, innerWidth: window.innerWidth };
    });
    throw new Error(
      `the window reached ${w}x${h} but the canvas never followed: ` +
        `canvas=${seen.canvasW}x${seen.canvasH}, innerWidth=${seen.innerWidth}. ` +
        `The viewport resized, so this is the ResizeObserver → react-use-measure → ` +
        `R3F gl.setSize chain failing to track it (the canvas-ratchet bug this ` +
        `spec guards), not a display too small to grant the size.\n${(err as Error).message}`,
    );
  }
}

async function layout(launched: LaunchedApp) {
  return launched.page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error('viewer canvas not found');
    const r = canvas.getBoundingClientRect();
    const col = document.querySelector('[data-testid="left-toolbar-column"]');
    if (!col) throw new Error('left toolbar column not found');
    const colRect = col.getBoundingClientRect();
    // Screen-pixel positions of the gizmo's vertical axis heads (top + bottom
    // extent of the gizmo cluster) via the E2E hook GizmoPicker installs.
    const headPos = (dir: [number, number, number]) =>
      (window as unknown as {
        __gizmoHeadScreenPos?: (d: [number, number, number]) => { x: number; y: number } | null;
      }).__gizmoHeadScreenPos?.(dir) ?? null;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      canvas: { w: r.width, h: r.height, bottom: r.bottom, right: r.right },
      column: {
        rect: { top: colRect.top, right: colRect.right, bottom: colRect.bottom },
        clientHeight: col.clientHeight,
        scrollHeight: col.scrollHeight,
      },
      gizmoHeads: { up: headPos([0, 0, 1]), down: headPos([0, 0, -1]) },
    };
  });
}

test('window resize: canvas shrinks with the window, min height fits the toolbar, gizmo stays visible', async () => {
  const launched = await launchApp();
  const { app, page, close } = launched;

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // --- Ratchet regression: grow well past launch size, then shrink. ---
    await setWindowSize(launched, 1600, 1000);
    const grown = await layout(launched);
    expect(grown.canvas.w).toBeGreaterThan(1500);
    expect(grown.canvas.h).toBeGreaterThan(850);
    // Tall window: the under-column lane exists, so the gizmo sits below the
    // column's cards in the palette lane (left-aligned, x ≈ 90).
    expect(grown.gizmoHeads.up).not.toBeNull();
    expect(grown.gizmoHeads.up!.x).toBeLessThan(grown.column.rect.right);

    // Ask for far below the minimum — the window must clamp to minHeight.
    await setWindowSize(launched, 950, 620);
    const bounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds());
    const [, minHeight] = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getMinimumSize());
    expect(minHeight).toBeGreaterThanOrEqual(720); // 800 unless a tiny display capped it
    expect(bounds.height).toBe(Math.max(620, minHeight));

    const shrunk = await layout(launched);
    // The canvas must track the shrunken viewport again — with the ratchet
    // bug its height stayed at the grown ~920px, cropping the bottom-anchored
    // overlays.
    expect(shrunk.canvas.bottom).toBeLessThanOrEqual(shrunk.viewport.h + 1);
    expect(shrunk.canvas.right).toBeLessThanOrEqual(shrunk.viewport.w + 1);
    // Carry the surrounding state into the failure message: if this ever fires
    // again on a runner we can't reproduce locally, we need to know whether the
    // WINDOW failed to shrink (bounds/viewport still ~1600 — an X11/WM clamp) or
    // only the CANVAS lagged (viewport 950 but canvas wider — the ratchet). The
    // bare "Expected 950, Received 1600" could not distinguish those.
    expect(
      shrunk.canvas.w,
      `canvas=${shrunk.canvas.w}x${shrunk.canvas.h} viewport=${shrunk.viewport.w}x${shrunk.viewport.h} ` +
      `bounds=${bounds.width}x${bounds.height} minHeight=${minHeight}`,
    ).toBe(950);

    // --- Min height fits the full toolbar column: no scroll-cropping. ---
    expect(shrunk.column.scrollHeight).toBeLessThanOrEqual(shrunk.column.clientHeight + 1);
    expect(shrunk.column.rect.bottom).toBeLessThanOrEqual(shrunk.viewport.h);

    // --- Gizmo placement: at min height the lane is too short, so the gizmo
    // must sit to the RIGHT of the column, fully clear of its footprint and
    // inside the viewport. ---
    expect(shrunk.gizmoHeads.up).not.toBeNull();
    expect(shrunk.gizmoHeads.down).not.toBeNull();
    for (const head of [shrunk.gizmoHeads.up!, shrunk.gizmoHeads.down!]) {
      expect(head.x).toBeGreaterThan(shrunk.column.rect.right);
      expect(head.y).toBeGreaterThan(0);
      expect(head.y).toBeLessThan(shrunk.viewport.h);
    }

    // Bottom-anchored status readout is back inside the window too.
    const statusBar = page.locator('text=Scroll:').first();
    await expect(statusBar).toBeVisible();
    const statusBox = await statusBar.boundingBox();
    expect(statusBox).not.toBeNull();
    expect(statusBox!.y + statusBox!.height).toBeLessThanOrEqual(shrunk.viewport.h + 1);
  } finally {
    await close();
  }
});
