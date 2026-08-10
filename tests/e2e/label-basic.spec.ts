import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Manual point labelling, end to end against the live backend.
//
// Fixture: tiny.xyz — cylinder at origin, r=0.3 h=1.5, 60 points.
//
// Phase 1 reuses the polygon lasso as its selection primitive, so a "stroke" is
// draw-vertices → Enter. What this spec proves, beyond "didn't throw":
//
//   1. Painting a full-viewport lasso labels EXACTLY the 60 points, and the
//      per-class counts the backend reports reach the panel.
//   2. The active class is what gets painted (switch class → repaint → counts
//      move between classes, they do not merely grow).
//   3. Undo restores the previous counts — the delta rollback is exact.
//   4. Commit rebuilds the octree and clears the dirty flag, and the labels
//      survive as a colourable scalar attribute.
//   5. The From-class gate makes a non-matching repaint a genuine no-op.
//
// Shared session: one app + backend for the file; File → New between tests.

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

/** Import the fixture and open the Label tool on it. */
async function openLabelTool() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-point-count', '60');
  await expect(row).toHaveAttribute('data-selected', 'true');

  // Frame deterministically — never rely on the launch-default camera.
  await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
  await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));

  await page.getByTestId('tool-label').click();
  const panel = page.getByTestId('label-panel');
  await expect(panel).toBeVisible();
  return { page, row, panel };
}

/** Draw a lasso covering the whole viewport and close it — one paint stroke. */
async function paintWholeViewport(page: LaunchedApp['page']) {
  const overlay = page.getByTestId('crop-polygon-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveCSS('pointer-events', 'auto');
  const box = await overlay.boundingBox();
  if (!box) throw new Error('crop-polygon-overlay has no bounding box');

  const inset = 8;
  const corners = [
    { x: box.x + inset, y: box.y + inset },
    { x: box.x + box.width - inset, y: box.y + inset },
    { x: box.x + box.width - inset, y: box.y + box.height - inset },
    { x: box.x + inset, y: box.y + box.height - inset },
  ];
  for (let i = 0; i < corners.length; i++) {
    await page.mouse.click(corners[i].x, corners[i].y);
    await expect(overlay.locator('circle')).toHaveCount(i + 1);
  }
  await page.keyboard.press('Enter');
}

/** Parse the panel's serialised per-class counts. */
async function counts(panel: ReturnType<LaunchedApp['page']['getByTestId']>) {
  const raw = await panel.getAttribute('data-label-counts');
  return JSON.parse(raw ?? '{}') as Record<string, number>;
}

test('painting a lasso labels the enclosed points with the active class', async () => {
  const { page, panel } = await openLabelTool();

  // The wood/leaf preset seeds the tool; the active class starts on the first
  // real class (not Unclassified, which would be a silent no-op).
  const active = await panel.getAttribute('data-active-class');
  expect(Number(active)).toBeGreaterThan(0);

  await expect(panel).toHaveAttribute('data-pending-strokes', '0');
  await paintWholeViewport(page);

  // One stroke recorded, and the cloud is now dirty (octree behind the column).
  await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 15_000 });
  await expect(panel).toHaveAttribute('data-label-dirty', 'true');

  // Every one of the 60 points is inside a full-viewport lasso, so the active
  // class must hold all of them — not "some", and not zero.
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 10_000 });
  const c = await counts(panel);
  expect(c[String(active)]).toBe(60);
});

test('painted points recolour IMMEDIATELY, without waiting for a commit', async () => {
  // The property the whole client-side overlay exists for. Asserting the panel
  // counts is NOT enough: those come straight from the backend response and are
  // fully green even when the overlay is never wired to the renderer at all —
  // which is exactly the bug this test was added for. Read the overlay's own
  // published fact instead.
  const { page, panel } = await openLabelTool();

  const before = await page.evaluate(() => (window as any).__labelOverlay);
  expect(before?.painted ?? 0).toBe(0);

  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 15_000 });

  // Every loaded tile point carries the painted class in the GPU-bound label
  // column — with NO commit and no octree rebuild.
  await expect.poll(
    async () => (await page.evaluate(() => (window as any).__labelOverlay))?.painted ?? 0,
    { timeout: 15_000 },
  ).toBeGreaterThan(0);

  const stats = await page.evaluate(() => (window as any).__labelOverlay);
  expect(stats.tiles).toBeGreaterThan(0);
  expect(stats.painted).toBe(stats.total);   // full-viewport lasso covers all of them
  await expect(panel).toHaveAttribute('data-label-dirty', 'true');
});

test('undo removes the preview immediately too', async () => {
  const { page, panel } = await openLabelTool();
  await paintWholeViewport(page);
  await expect.poll(
    async () => (await page.evaluate(() => (window as any).__labelOverlay))?.painted ?? 0,
    { timeout: 15_000 },
  ).toBeGreaterThan(0);

  await page.getByTestId('label-undo').click();
  await expect(panel).toHaveAttribute('data-pending-strokes', '0', { timeout: 15_000 });

  // The overlay replays the (now empty) stroke list from scratch, so the paint
  // disappears without a rebuild.
  await expect.poll(
    async () => (await page.evaluate(() => (window as any).__labelOverlay))?.painted ?? 0,
    { timeout: 15_000 },
  ).toBe(0);
});

test('switching the active class repaints — counts move rather than accumulate', async () => {
  const { page, panel } = await openLabelTool();
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });
  const first = Number(await panel.getAttribute('data-active-class'));

  // Pick a different class from the list and repaint the same region.
  const rows = page.getByTestId('label-class-list').locator('[data-testid^="label-class-"]');
  const n = await rows.count();
  let second = -1;
  for (let i = 0; i < n; i++) {
    const v = Number(await rows.nth(i).getAttribute('data-count') !== null
      ? (await rows.nth(i).getAttribute('data-testid'))!.replace('label-class-', '')
      : -1);
    if (v > 0 && v !== first) { second = v; break; }
  }
  expect(second).toBeGreaterThan(0);

  await page.getByTestId(`label-class-${second}`).click();
  await expect(panel).toHaveAttribute('data-active-class', String(second));

  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-pending-strokes', '2', { timeout: 15_000 });

  // The points MOVED class: the second class holds all 60 and the first is
  // empty. A bug that appended instead of repainting would leave 60 in both.
  const c = await counts(panel);
  expect(c[String(second)]).toBe(60);
  expect(c[String(first)] ?? 0).toBe(0);
  await expect(panel).toHaveAttribute('data-labelled-count', '60');
});

test('undo rolls the labels back exactly', async () => {
  const { page, panel } = await openLabelTool();
  const first = Number(await panel.getAttribute('data-active-class'));

  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });

  await page.getByTestId('label-undo').click();
  await expect(panel).toHaveAttribute('data-pending-strokes', '0', { timeout: 15_000 });

  // Back to nothing labelled — the reverse-applied delta restored every prior
  // value, not merely "some".
  await expect(panel).toHaveAttribute('data-labelled-count', '0');
  const c = await counts(panel);
  expect(c[String(first)] ?? 0).toBe(0);
});

test('the From-class gate makes a non-matching repaint a no-op', async () => {
  const { page, panel } = await openLabelTool();
  const first = Number(await panel.getAttribute('data-active-class'));
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });

  // Gate on Unclassified (0): after the first stroke nothing is class 0 any
  // more, so repainting must change nothing.
  await page.getByTestId('label-from-0').click();
  await expect(page.getByTestId('label-class-0')).toHaveAttribute('data-in-from', 'true');

  const before = await counts(panel);
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-pending-strokes', '2', { timeout: 15_000 });

  // Same counts as before: the gate held. Without it the active class would
  // have swallowed the whole cloud again.
  expect(await counts(panel)).toEqual(before);
  expect(before[String(first)]).toBe(60);
});

test('commit bakes the labels into the cloud and clears the dirty flag', async () => {
  const { page, panel } = await openLabelTool();
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });
  await expect(panel).toHaveAttribute('data-label-dirty', 'true');

  await page.getByTestId('label-commit').click();

  // Commit runs PotreeConverter, so allow real time.
  await expect(panel).toHaveAttribute('data-label-dirty', 'false', { timeout: 90_000 });
  await expect(panel).toHaveAttribute('data-pending-strokes', '0');

  // The labels survived the rebuild as real data, and the cloud kept its points.
  await expect(panel).toHaveAttribute('data-labelled-count', '60');
  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
  await expect(row).toHaveAttribute('data-point-count', '60');
});

test('uncommitted strokes are flagged in the panel and before File > New', async () => {
  // There is no project save/load, so hand-made labels are irreplaceable —
  // the guard is the difference between "lost an hour" and "didn't".
  const { page, panel } = await openLabelTool();
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 15_000 });

  // The panel says so where the user is already looking.
  await expect(page.getByTestId('label-pending-hint')).toBeVisible();

  // ...and File > New calls it out specifically, rather than relying on its
  // generic "this clears everything" line. Fire the same menu:command IPC the
  // native menu sends (see helpers/resetApp.ts).
  await session.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: 'new' });
  });
  const warning = page.getByTestId('new-confirm-label-warning');
  await expect(warning).toBeVisible({ timeout: 10_000 });
  await expect(warning).toContainText('1');

  // Cancel rather than confirming — this test must not destroy the scene for
  // whatever runs next in the shared session.
  await page.getByTestId('new-confirm-cancel').click();
  await expect(page.getByTestId('new-confirm-dialog')).toHaveCount(0);
  // The strokes survived the near-miss.
  await expect(panel).toHaveAttribute('data-pending-strokes', '1');
});
