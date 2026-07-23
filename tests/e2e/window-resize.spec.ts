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
  await launched.app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.w, size.h);
  }, { w, h });
  // Let the ResizeObserver → R3F setSize round-trip settle.
  await launched.page.waitForTimeout(500);
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
    expect(shrunk.canvas.w).toBe(950);

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
