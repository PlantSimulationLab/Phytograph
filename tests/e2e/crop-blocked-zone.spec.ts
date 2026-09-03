import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// The screen-space crop tools can't reach the parts of the viewport covered by
// the floating panels: the overlays are z-10 and every panel paints above them,
// so those panels win hit-testing. Reported symptom: near the right edge the
// rubber-band line "sometimes" follows the cursor and clicks never place a
// vertex, with nothing on screen saying why.
//
// The fix doesn't remove the occlusion (panels stay clickable during a draw) —
// it makes it explicit:
//   1. The blocked rects cover the REAL panels and nothing more. The right-hand
//      stack is pinned top-and-bottom, so it is full-height however few panels
//      it holds; measuring that container refused clicks down the whole right
//      edge over empty space. Only the panels inside it are measured.
//   2. The preview line CLAMPS to the zone edge instead of freezing, and the
//      cursor is marked refused (data-cursor-blocked) while it's over a panel.
//   3. Clicking in the zone still adds no vertex — now visibly, not silently.
//
// There is deliberately NO standing highlight over the panels: that a panel takes
// its own clicks is self-evident, so the only feedback is the ⊘ at the cursor at
// the moment a click would be refused.
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).

/**
 * The measured blocker rects, in viewer-local px, read from `data-zone-rects`.
 * Nothing paints them, so this attribute is the only view onto the geometry the
 * clamping actually uses.
 */
async function readZoneRects(zone: ReturnType<Page['getByTestId']>) {
  const raw = await zone.getAttribute('data-zone-rects');
  if (!raw) throw new Error('blocked zone exposed no data-zone-rects');
  return (JSON.parse(raw) as [number, number, number, number][])
    .map(([x, y, w, h]) => ({ x, y, w, h }));
}

let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});
test.beforeEach(async () => {
  await resetToFreshScene(session.app, session.page);
});

async function startPolygonDraw(session: LaunchedApp) {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-crop').click();
  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('crop-shape-polygon').click();
  await expect(panel).toHaveAttribute('data-crop-mode', 'polygon');
  return { row, panel };
}

test('blocked zone tracks the real panels, not the full-height stack', async () => {
  const { page } = session;
  const { panel } = await startPolygonDraw(session);

  // The zone layer only exists while a screen-space draw is live.
  const zone = page.getByTestId('crop-blocked-zone');
  await expect(zone).toBeVisible();
  // The panel copy explains the refusal in words.
  await expect(page.getByTestId('crop-blocked-hint')).toBeVisible();

  // It must not steal input itself — that would just move the problem.
  await expect(zone).toHaveCSS('pointer-events', 'none');

  // No standing highlight: the panels are not painted over while drawing.
  await expect(zone.locator('rect')).toHaveCount(0);

  // The geometric claim, read from the live hit-test rather than from painted
  // SVG. With ONE scan loaded the right-hand stack holds a single short panel,
  // so a point just below that panel — still inside the full-height stack — must
  // be reachable. Measuring the stack itself made this whole strip dead.
  const scansBox = await page.getByTestId('scans-panel').boundingBox();
  // The zone layer is `absolute inset-0` on the viewer root, so its box IS the pane.
  const viewer = await zone.boundingBox();
  if (!scansBox || !viewer) throw new Error('missing bounding boxes');

  // What actually receives a click at a point — the ground truth for "can the
  // tool reach here?", independent of what was measured or painted.
  const probe = async (clientX: number, clientY: number) =>
    zone.evaluate((_el, p) => {
      const hit = document.elementFromPoint(p.x, p.y);
      return {
        tag: hit?.tagName ?? null,
        testId: hit?.getAttribute('data-testid') ?? null,
      };
    }, { x: clientX, y: clientY });

  // Inside the scans panel: genuinely occluded, so the panel takes the click.
  const onPanel = await probe(scansBox.x + scansBox.width / 2, scansBox.y + scansBox.height / 2);
  expect(onPanel.testId).not.toBe('crop-polygon-overlay');

  // 80px below the panel's bottom, same column — empty stack space. The DRAW
  // OVERLAY must be what's under the cursor: the stack is full-height, so before
  // the fix its container swallowed this click and the whole strip was dead.
  const belowY = scansBox.y + scansBox.height + 80;
  expect(belowY).toBeLessThan(viewer.y + viewer.height - 20); // stay in the pane
  const belowPanel = await probe(scansBox.x + scansBox.width / 2, belowY);
  expect(belowPanel.testId).toBe('crop-polygon-overlay');

  // And it is not reported as blocked geometry either.
  const rects = await readZoneRects(zone);
  const localBelow = { x: scansBox.x + scansBox.width / 2 - viewer.x, y: belowY - viewer.y };
  expect(rects.some(r =>
    localBelow.x >= r.x && localBelow.x <= r.x + r.w &&
    localBelow.y >= r.y && localBelow.y <= r.y + r.h)).toBe(false);

  // And the tool agrees: moving there is not refused.
  await page.mouse.move(scansBox.x + scansBox.width / 2, belowY);
  await expect(zone).toHaveAttribute('data-cursor-blocked', 'false');

  // Cancel the draw: the zone is transient, not permanent viewport furniture.
  await page.keyboard.press('Escape');
  await expect(zone).toHaveCount(0);
  await expect(panel).toBeVisible();
});

test('cursor over a panel is marked refused, clamps the preview, and places no vertex', async () => {
  const { page } = session;
  await startPolygonDraw(session);

  const overlay = page.getByTestId('crop-polygon-overlay');
  const zone = page.getByTestId('crop-blocked-zone');
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  if (!box) throw new Error('crop-polygon-overlay has no bounding box');

  // Two vertices in reachable space (left half) so a preview segment exists.
  await page.mouse.click(box.x + 40, box.y + 40);
  await page.mouse.click(box.x + 40, box.y + box.height - 40);
  await expect(overlay.locator('circle')).toHaveCount(2);
  await expect(zone).toHaveAttribute('data-cursor-blocked', 'false');

  // Move deep into the scans panel — the case the user hit.
  const scansBox = await page.getByTestId('scans-panel').boundingBox();
  if (!scansBox) throw new Error('scans-panel has no bounding box');
  const inPanel = {
    x: scansBox.x + scansBox.width / 2,
    y: scansBox.y + scansBox.height / 2,
  };
  await page.mouse.move(inPanel.x, inPanel.y);

  // The overlay never sees this pointer, but the window tracker does: the
  // cursor reads as refused rather than the preview silently freezing.
  await expect(zone).toHaveAttribute('data-cursor-blocked', 'true');

  // The pending segment ends at the CLAMPED point: pushed out through whichever
  // edge of the blocker is nearest (here the panel's bottom edge, since the
  // scans panel sits high in the column), so it lands OUTSIDE every blocked rect
  // and away from the raw cursor. Before this it stayed frozen at the last
  // position the overlay happened to see.
  const preview = overlay.locator('line').first();
  const end = await preview.evaluate(el => ({
    x: Number(el.getAttribute('x2')), y: Number(el.getAttribute('y2')),
  }));
  const zoneRects = await readZoneRects(zone);
  const insideAZone = (p: { x: number; y: number }) => zoneRects.some(
    r => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);

  const rawLocal = { x: inPanel.x - box.x, y: inPanel.y - box.y };
  expect(insideAZone(rawLocal)).toBe(true);   // the pointer really is in the dead zone
  expect(insideAZone(end)).toBe(false);       // the preview is not
  expect(Math.hypot(end.x - rawLocal.x, end.y - rawLocal.y)).toBeGreaterThan(1);

  // And it's drawn as refused (amber), not as a normal pending segment (green).
  await expect(preview).toHaveAttribute('stroke', '#f59e0b');

  // Clicking there adds no vertex — the panel takes the click. Unchanged
  // behavior; the point is that it's now explained rather than mysterious.
  await page.mouse.click(inPanel.x, inPanel.y);
  await expect(overlay.locator('circle')).toHaveCount(2);

  // Back over reachable viewport: normal green preview resumes.
  await page.mouse.move(box.x + 200, box.y + 200);
  await expect(zone).toHaveAttribute('data-cursor-blocked', 'false');
  await expect(overlay.locator('line').first()).toHaveAttribute('stroke', '#22c55e');
});

test('rect drag released over a panel still commits (clamped) instead of hanging', async () => {
  const { page } = session;
  const { app } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);
  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-crop').click();
  const panel = page.getByTestId('crop-panel');
  await page.getByTestId('crop-shape-rect').click();
  await expect(panel).toHaveAttribute('data-crop-mode', 'rect');

  const overlay = page.getByTestId('crop-rect-overlay');
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  if (!box) throw new Error('crop-rect-overlay has no bounding box');

  // The rect tool arms on selection, so the zone is already measurable.
  const zone = page.getByTestId('crop-blocked-zone');
  await expect(zone).toBeVisible();
  const zoneRects = await readZoneRects(zone);
  // Release in the middle of the biggest blocker. Which panel that is, and which
  // of its edges is the nearest way out, is layout-dependent — so the assertions
  // below check the clamp's PROPERTIES (unblocked, on an edge, tracking the
  // pointer) rather than pinning it to one particular side.
  const stack = zoneRects.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  const release = { x: stack.x + stack.w / 2, y: stack.y + stack.h / 2 };

  // Drag from reachable viewport INTO the panel stack and release there. The
  // overlay never receives that mouseup (the panel does), so before the window
  // -level tracking the drag stayed stuck rubber-banding forever.
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 300, { steps: 8 });
  await page.mouse.move(box.x + release.x, box.y + release.y, { steps: 8 });

  // Mid-drag, over the panel: the cursor reads as refused.
  await expect(zone).toHaveAttribute('data-cursor-blocked', 'true');

  await page.mouse.up();

  // Committed: the panel reports a ready rectangle and Apply is enabled.
  await expect(panel.getByText('Rectangle ready')).toBeVisible();
  const applyBtn = page.getByTestId('crop-apply');
  await expect(applyBtn).toBeEnabled();

  // The far corner is the CLAMPED release point — a reachable spot outside every
  // blocked rect — not the raw pointer position buried in the panel. (The
  // rectangle's interior may still span under a panel; that's intended. It's the
  // pointer that can't go there, not the crop region.)
  const corners = await page.getByTestId('crop-rect-overlay').locator('polygon').evaluate(
    el => (el.getAttribute('points') ?? '').split(' ')
      .map(p => ({ x: Number(p.split(',')[0]), y: Number(p.split(',')[1]) })));
  expect(corners).toHaveLength(4);
  // The far corner is the clamped release point: the stack's left edge at the
  // pointer's height (the rect is spanned start → release, so that's maxX/maxY).
  const far = { x: Math.max(...corners.map(c => c.x)), y: Math.max(...corners.map(c => c.y)) };
  const blockedAt = (p: { x: number; y: number }) => zoneRects.some(
    r => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
  expect(blockedAt(far)).toBe(false);
  // It followed the pointer OUT of the blocker rather than being dropped back to
  // where the pointer last was on the canvas: the clamp sits just outside one of
  // that blocker's four edges, and keeps the pointer's other coordinate.
  // ±3px: the pointer lands on an integer pixel, the panel rect can be
  // fractional, and clampOutOfBlockers adds a 2px margin.
  const onLeft = Math.abs(far.x - (stack.x - 2)) <= 3 && Math.abs(far.y - release.y) <= 3;
  const onRight = Math.abs(far.x - (stack.x + stack.w + 2)) <= 3 && Math.abs(far.y - release.y) <= 3;
  const onTop = Math.abs(far.y - (stack.y - 2)) <= 3 && Math.abs(far.x - release.x) <= 3;
  const onBottom = Math.abs(far.y - (stack.y + stack.h + 2)) <= 3 && Math.abs(far.x - release.x) <= 3;
  expect(
    onLeft || onRight || onTop || onBottom,
    `clamped corner ${JSON.stringify(far)} is not on an edge of ${JSON.stringify(stack)} ` +
    `(release was ${JSON.stringify(release)})`,
  ).toBe(true);
  // The drag still grew from its start corner — it didn't collapse or invert.
  expect(corners.every(c => c.x >= 40 - 1 && c.y >= 40 - 1)).toBe(true);
  expect(far.x).toBeGreaterThan(40);
  expect(far.y).toBeGreaterThan(40);

  // And it's a real crop: applying keeps a strict subset of the 60 points.
  await applyBtn.click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });
  await expect
    .poll(async () => Number(await row.getAttribute('data-point-count')), { timeout: 8_000 })
    .toBeGreaterThan(0);
  const kept = Number(await row.getAttribute('data-point-count'));
  expect(kept).toBeLessThan(60);
});
