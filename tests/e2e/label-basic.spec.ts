import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { stubSaveDialog } from './helpers/stubSaveDialog';
import { readLasClasses } from './helpers/lasClasses';
import { fixturePoints, pointsDrawnIn } from './helpers/pointColors';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
const TINY_OFFSET = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny-offset.xyz');

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

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
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
  // Wait for the lasso to be RE-ARMED and empty before clicking. After a stroke
  // the tool clears the polygon and re-arms on the next effect pass; clicking
  // into that gap drops the first vertex, and the stroke silently never closes.
  await expect(overlay.locator('circle')).toHaveCount(0, { timeout: 10_000 });
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

/**
 * Close the label panel (which bakes its labels into the display octree) and
 * wait for the rebuilt octree to take over, checking at every sample that the
 * painted points are still DRAWN in `colour`: between the close and the swap
 * the only thing drawing them is the overlay, and a gap there reads as the
 * work being lost. Returns the samples taken.
 */
async function closeAndAwaitBake(page: LaunchedApp['page'], colour: string) {
  const panel = page.getByTestId('label-panel');
  const pts = fixturePoints(TINY);
  // The rebuilt octree has a new cache id. Read per cloud, from its row: ids
  // are content-addressed, so a global "any new id" check is fooled by an
  // earlier test that built the same content.
  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  const before = await row.getAttribute('data-octree-cache-id');
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  const samples: Array<{ matched: number; landed: boolean; pill: boolean }> = [];
  const deadline = Date.now() + 90_000;
  for (;;) {
    const landed = (await row.getAttribute('data-octree-cache-id')) !== before;
    const drawn = await pointsDrawnIn(page, pts, colour, 40, '[data-testid="scalar-overlay"]');
    const pill = await page.getByTestId('octree-refresh-running').count() > 0;
    samples.push({ matched: drawn.matched, landed, pill });
    expect(drawn.matched, `labels vanished at sample ${samples.length}`).toBeGreaterThan(30);
    if (landed) break;
    if (Date.now() > deadline) throw new Error('the background bake never landed');
    await page.waitForTimeout(100);
  }
  return samples;
}

/** The colour the panel shows for class `value`. */
async function classColour(page: LaunchedApp['page'], value: number | string) {
  return (await page.getByTestId(`label-class-${value}`).getAttribute('data-color'))!;
}

test('a cloud with no classification of its own still opens on the hand-labelling column', async () => {
  // The no-regression guard for the column picker. `manual_class` does not
  // exist on a freshly imported cloud — the backend creates it on the first
  // stroke — so it has to be offered anyway. Dropping that made the picker
  // empty on every plain import, which every other label spec depends on.
  const { page, panel } = await openLabelTool();

  await expect(panel).toHaveAttribute('data-label-slug', 'manual_class');
  await expect(page.getByTestId('label-column-select')).toHaveValue('manual_class');
  // And it is seeded with a vocabulary to paint, not a bare "Unclassified".
  await expect(panel).toContainText('Wood');
  await expect(panel).toContainText('Leaf');
});

test('painting a lasso labels the enclosed points with the active class', async () => {
  const { page, panel } = await openLabelTool();

  // The wood/leaf preset seeds the tool; the active class starts on the first
  // real class (not Unclassified, which would be a silent no-op).
  const active = await panel.getAttribute('data-active-class');
  expect(Number(active)).toBeGreaterThan(0);

  // Every point starts Unclassified, so the panel must SAY so on open. Showing
  // 0 for every class reads as "no points here", and the total then jumps once
  // the first stroke lands.
  await expect.poll(async () => (await counts(panel))['0'] ?? 0, { timeout: 15_000 })
    .toBe(60);

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

test('the preview appears without waiting for the backend', async () => {
  // The stroke is appended to the local list BEFORE the request is awaited, so
  // the overlay repaints on the next frame rather than after a round trip plus
  // a full-resolution O(N) scan of the whole cloud. Originally the await came
  // first, which defeated the entire purpose of a client-side overlay.
  //
  // Asserted by ORDERING, not by a stopwatch. Verified against a sabotage that
  // restored the await-then-paint version: on this 60-point fixture the backend
  // replies in single-digit ms, so BOTH orderings look instant and a timing
  // bound cannot separate them. What this test does pin is that the overlay is
  // painted from the local stroke list and reaches a painted state at or before
  // the backend-derived counts — a real regression (e.g. driving the overlay
  // from the response) still fails it. The user-visible win is on large clouds,
  // where the reply also waits on a full-resolution O(N) scan.
  const { page, panel } = await openLabelTool();
  await paintWholeViewport(page);

  const t0 = Date.now();
  await expect.poll(
    async () => (await page.evaluate(() => (window as any).__labelOverlay))?.painted ?? 0,
    { timeout: 15_000, intervals: [16, 16, 16] },
  ).toBeGreaterThan(0);
  const previewMs = Date.now() - t0;

  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });
  const countsMs = Date.now() - t0;

  // The preview must never LAG the backend-derived counts.
  expect(previewMs).toBeLessThanOrEqual(countsMs);
  expect(previewMs).toBeLessThan(3_000);
});

test('labels display even when the cloud was coloured by RGB', async () => {
  // The gap the first preview test missed. `__labelOverlay.painted` counts the
  // CPU buffer, which is filled correctly in EVERY colour mode — but the shader
  // only SAMPLES that slot under scalar/INTENSITY_GRADIENT. On a cloud coloured
  // by RGB (any real scan) the labels were computed, uploaded, and then not
  // drawn: counts moved, viewport never changed. tiny.xyz has no colour, so the
  // original test sat in a mode that happened to work.
  const { page, panel } = await openLabelTool();

  // Force the cloud into a mode that does NOT read the intensity slot, the way
  // a real coloured scan arrives.
  await page.evaluate(() => (window as any).__setCloudColorMode?.('rgb'));

  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 15_000 });

  // Assert on what the MATERIAL was actually built with, published by the
  // renderer itself. A seam that echoed the parent's intent would be
  // self-confirming — verified: with the scalar override reverted, this fails
  // while every other test still passes.
  //
  // INTENSITY_GRADIENT (2) is the only pointColorType that samples the
  // intensity slot the overlay writes into; under RGB the labels are uploaded
  // and never drawn.
  // Key the lookup to THIS cloud's octree. Picking an arbitrary entry made the
  // assertion depend on which clouds an earlier test left mounted in the shared
  // session — green alone, flaky in a full run.
  await expect.poll(
    async () => page.evaluate(() => {
      const all = (window as any).__octreeRenderMode ?? {};
      const modes = Object.values(all) as Array<
        { colorMode?: string; scalarField?: string | null }
      >;
      // Exactly one cloud is labelled, so the labelled render mode is the one
      // reporting the manual_class field.
      // Report the LABEL-mode cloud if one exists, else the cloud that is
      // actually mounted — the fallback must show the wrong state rather than
      // hide it, or the sabotage check below would pass on a missing entry.
      const labelled = modes.find((m) => m.scalarField === 'manual_class');
      const entry = labelled ?? modes[modes.length - 1];
      return entry
        ? { colorMode: entry.colorMode ?? null, scalarField: entry.scalarField ?? null }
        : null;
    }),
    { timeout: 15_000 },
  ).toEqual({ colorMode: 'scalar', scalarField: 'manual_class' });

  // Poll rather than sample once: tiles stream in, so the overlay's replay can
  // still be catching up the frame after the render mode settles.
  await expect.poll(async () => {
    const s = await page.evaluate(() => (window as any).__labelOverlay);
    return s && s.total > 0 ? s.painted === s.total : false;
  }, { timeout: 15_000 }).toBe(true);
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

  // Wait for the COUNTS, not just the stroke. Since the preview is painted
  // optimistically, pending-strokes rises before the backend replies, so
  // reading the counts here raced the response.
  await expect.poll(async () => (await counts(panel))[String(second)] ?? 0,
    { timeout: 15_000 }).toBe(60);

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
  expect(before[String(first)]).toBe(60);

  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-pending-strokes', '2', { timeout: 15_000 });

  // Wait for the second stroke's RESPONSE before comparing. pending-strokes
  // rises optimistically, so reading counts here raced the reply — and this
  // test asserts counts did NOT change, which a not-yet-arrived reply would
  // satisfy for the wrong reason. Poll until the labelled total is stable at
  // the full cloud, then compare.
  await expect.poll(async () => (await counts(panel))[String(first)] ?? 0,
    { timeout: 15_000 }).toBe(60);

  // Same counts as before: the gate held. Without it the active class would
  // have swallowed the whole cloud again.
  expect(await counts(panel)).toEqual(before);
});

test('closing the panel bakes the labels, and they never leave the screen', async () => {
  // There is no Commit button: the labels are in the session from the stroke,
  // and closing the panel rebuilds the display octree in the background. The
  // paint must never disappear on the way: until the rebuild lands the only
  // thing drawing it is the overlay.
  const { page, panel } = await openLabelTool();
  const active = await panel.getAttribute('data-active-class');
  const colour = await classColour(page, active!);
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });

  const samples = await closeAndAwaitBake(page, colour);
  // Nothing on screen asked the user to wait: the rebuild is the app's business.
  expect(samples.filter((x) => x.pill).length, 'a progress pill appeared').toBe(0);

  // Reopening finds nothing pending (it is baked) and the labels as real data.
  await page.getByTestId('tool-label').click();
  await expect(panel).toHaveAttribute('data-pending-strokes', '0');
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });
  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(row).toHaveAttribute('data-point-count', '60');
});

test('you can reopen and keep painting while a bake is still running', async () => {
  // A bake runs in the background, so the tool must be free straight away:
  // new strokes are new work and get their own rebuild, and the NEWER one wins.
  const { page, panel } = await openLabelTool();
  const first = Number(await panel.getAttribute('data-active-class'));
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);

  // Straight back in: a different class over the same region.
  await page.getByTestId('tool-label').click();
  await expect(panel).toBeVisible();
  const second = await otherClass(page, first);
  await page.getByTestId(`label-class-${second}`).click();
  await paintWholeViewport(page);
  await expect.poll(async () => (await counts(panel))[String(second)] ?? 0,
    { timeout: 15_000 }).toBe(60);

  await closeAndAwaitBake(page, await classColour(page, second));

  // Both bakes landed, and the second one won.
  await page.getByTestId('tool-label').click();
  await expect.poll(async () => (await counts(panel))[String(second)] ?? 0,
    { timeout: 15_000 }).toBe(60);
  expect((await counts(panel))[String(first)] ?? 0).toBe(0);
});

test('the lasso can be disarmed to orbit, by button and by L', async () => {
  // Without this the tool is unusable on real data: every viewport click is a
  // lasso vertex, so there is no way to reframe between strokes.
  const { page, panel } = await openLabelTool();
  await expect(panel).toHaveAttribute('data-label-drawing', 'true');
  await expect(page.getByTestId('crop-polygon-overlay')).toBeVisible();

  // Button disarms: the lasso overlay goes away, so drags reach the camera.
  await page.getByTestId('label-mode-toggle').click();
  await expect(panel).toHaveAttribute('data-label-drawing', 'false');
  await expect(page.getByTestId('crop-polygon-overlay')).toHaveCount(0);
  // The panel stays open — the class selection is not lost.
  await expect(panel).toBeVisible();

  // 'L' re-arms it.
  await page.keyboard.press('l');
  await expect(panel).toHaveAttribute('data-label-drawing', 'true');
  await expect(page.getByTestId('crop-polygon-overlay')).toBeVisible();

  // ...and disarms again, so the shortcut is a true toggle.
  await page.keyboard.press('l');
  await expect(panel).toHaveAttribute('data-label-drawing', 'false');

  // Re-arm and confirm painting still works after the round trip.
  await page.getByTestId('label-mode-toggle').click();
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 15_000 });
});

test('closing the panel disarms the tool — the lasso stops accepting clicks', async () => {
  // The panel closing is not enough: if the tool stays armed, the toolbar button
  // still reads active and viewport clicks keep dropping polygon vertices on a
  // tool the user believes is shut.
  const { page, panel } = await openLabelTool();

  const toolBtn = page.getByTestId('tool-label');
  const overlay = page.getByTestId('crop-polygon-overlay');
  await expect(overlay).toBeVisible();

  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);

  // The lasso overlay is gone, so a viewport click cannot place a vertex...
  await expect(overlay).toHaveCount(0);
  // ...and the toolbar no longer shows the tool as active.
  await expect(toolBtn).not.toHaveAttribute('data-active', 'true');

  // A click in the middle of the viewport places nothing.
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('viewer canvas has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('crop-polygon-overlay')).toHaveCount(0);
});

/** Export the selected cloud to LAS through the real Export window. */
async function exportLas(name: string) {
  const { app, page } = session;
  const savePath = join(mkdtempSync(join(tmpdir(), 'phytograph-label-export-')), name);
  await stubSaveDialog(app, savePath);
  await page.evaluate(() => (window as any).__openExportPanel?.());
  await expect(page.getByTestId('export-modal')).toBeVisible();
  await page.getByTestId('export-format-las').click();
  await page.getByTestId('export-cloud-go').click();
  await expect(page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }).last())
    .toBeVisible({ timeout: 30_000 });
  return savePath;
}

/** Fire File > New the way the native menu does, and report its label line. */
async function fileNewLabelWarning() {
  const { page } = session;
  await session.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: 'new' });
  });
  await expect(page.getByTestId('new-confirm-dialog')).toBeVisible({ timeout: 10_000 });
  const warning = page.getByTestId('new-confirm-label-warning');
  const text = await warning.count() > 0 ? await warning.textContent() : null;
  // Cancel: this test must not destroy the scene for whatever runs next.
  await page.getByTestId('new-confirm-cancel').click();
  await expect(page.getByTestId('new-confirm-dialog')).toHaveCount(0);
  return text;
}

test('unexported labels are flagged in the panel and before File > New, until exported', async () => {
  // There is no project file, so hand-made labels are lost on quit or File >
  // New unless they have been exported. That is what the warnings are about:
  // not "uncommitted strokes", which the display catches up on by itself.
  const { page, panel } = await openLabelTool();
  await expect(page.getByTestId('label-unexported')).toHaveCount(0);
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });
  await expect(page.getByTestId('label-unexported')).toBeVisible();
  expect(await fileNewLabelWarning()).toContain('1 point cloud has hand labels');

  await exportLas('flagged.las');
  await expect(page.getByTestId('label-unexported')).toHaveCount(0);
  expect(await fileNewLabelWarning()).toBeNull();
});

/** The first real class that is not `exclude`, read from the panel's rows. */
async function otherClass(page: LaunchedApp['page'], exclude: number): Promise<number> {
  const rows = page.getByTestId('label-class-list').locator('[data-testid^="label-class-"]');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const v = Number((await rows.nth(i).getAttribute('data-testid'))!.replace('label-class-', ''));
    if (v > 0 && v !== exclude) return v;
  }
  throw new Error('no second class in the palette');
}

for (const how of ['panel button', 'Cmd+Z'] as const) {
  test(`undo after a bake keeps the baked labels (${how})`, async () => {
    // Commit cleared the renderer's strokes but the backend kept its history,
    // so the first undo after a commit resolved to "keep nothing" and reverse-
    // applied every delta: the committed labels vanished, from the display AND
    // from the session export reads. A commit is now an undo boundary.
    const { app } = session;
    const { page, panel } = await openLabelTool();
    const first = Number(await panel.getAttribute('data-active-class'));
    await paintWholeViewport(page);
    await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });

    // Closing the panel bakes, and a bake is an undo boundary.
    await closeAndAwaitBake(page, await classColour(page, first));
    await page.getByTestId('tool-label').click();
    await expect(panel).toBeVisible();

    const second = await otherClass(page, first);
    await page.getByTestId(`label-class-${second}`).click();
    await paintWholeViewport(page);
    await expect.poll(async () => (await counts(panel))[String(second)] ?? 0,
      { timeout: 15_000 }).toBe(60);

    if (how === 'panel button') await page.getByTestId('label-undo').click();
    else await page.keyboard.press('ControlOrMeta+z');

    // Back to the committed state — not to nothing.
    await expect.poll(async () => (await counts(panel))[String(first)] ?? 0,
      { timeout: 15_000 }).toBe(60);
    expect((await counts(panel))[String(second)] ?? 0).toBe(0);
    await expect(panel).toHaveAttribute('data-pending-strokes', '0');

    // Nothing left to undo: the next step in the history is no longer a label
    // stroke (a further Cmd+Z undoes the IMPORT, which is correct).
    await expect(page.getByTestId('label-undo')).toBeDisabled();

    // And the file says so too: export reads the session, not the display.
    const savePath = join(mkdtempSync(join(tmpdir(), 'phytograph-label-undo-')), 'undo.las');
    await stubSaveDialog(app, savePath);
    await page.evaluate(() => (window as any).__openExportPanel?.());
    await expect(page.getByTestId('export-modal')).toBeVisible();
    await page.getByTestId('export-format-las').click();
    await page.getByTestId('export-cloud-go').click();
    await expect(
      page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }),
    ).toBeVisible({ timeout: 30_000 });
    const { classes } = readLasClasses(savePath);
    expect(classes).toHaveLength(60);
    expect(classes.every((c) => c === first)).toBe(true);
  });
}

test('pending strokes belong to their cloud, not to the tool', async () => {
  // The tool held ONE stroke list, cleared only by Commit. Selecting another
  // cloud handed it cloud A's strokes: B's overlay replayed them over B's
  // points, and B's Undo sent A's stroke ids to B's session.
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);
  await importFiles(app, page, 'import-auto', TINY_OFFSET);
  await completeImportWizard(page);
  const rowA = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  const rowB = page.locator('[data-testid="scan-row"][data-scan-name="tiny-offset"]');
  await expect(rowA).toHaveAttribute('data-point-count', '60', { timeout: 20_000 });
  await expect(rowB).toHaveAttribute('data-point-count', '60', { timeout: 20_000 });
  const idA = (await rowA.getAttribute('data-scan-id'))!;
  const idB = (await rowB.getAttribute('data-scan-id'))!;

  await rowA.getByTestId('scan-row-name').click();
  await expect(rowA).toHaveAttribute('data-selected', 'true');
  await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
  await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));
  await page.getByTestId('tool-label').click();
  const panel = page.getByTestId('label-panel');
  await expect(panel).toBeVisible();

  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });
  await expect(panel).toHaveAttribute('data-pending-strokes', '1');
  const overlay = (id: string) => page.evaluate(
    (cid) => (window as any).__labelOverlayByCloud?.[cid]?.painted ?? 0, id);
  await expect.poll(() => overlay(idA), { timeout: 15_000 }).toBe(60);

  await rowB.getByTestId('scan-row-name').click();
  await expect(rowB).toHaveAttribute('data-selected', 'true');
  await expect(panel).toHaveAttribute('data-pending-strokes', '0', { timeout: 10_000 });
  await expect(page.getByTestId('label-undo')).toBeDisabled();
  await expect(panel).toHaveAttribute('data-labelled-count', '0', { timeout: 15_000 });
  // B paints nothing of A's; A's paint stays on screen (it is in A's session).
  await page.waitForTimeout(500);
  expect(await overlay(idB)).toBe(0);
  expect(await overlay(idA)).toBe(60);

  await rowA.getByTestId('scan-row-name').click();
  await expect(rowA).toHaveAttribute('data-selected', 'true');
  await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 10_000 });
  await expect(page.getByTestId('label-undo')).toBeEnabled();
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });
});

const painted = (page: LaunchedApp['page']) => page.evaluate(
  () => (window as any).__labelOverlay?.painted ?? 0);

test('the panel Undo undoes the LAST stroke even after a stroke that labelled nothing', async () => {
  // The panel Undo undid by COUNT (keep = strokes - 1), but the backend only
  // records strokes that changed something. After a From-gated stroke that
  // matched nothing, "keep 1" kept the real stroke and the Undo did nothing.
  const { page, panel } = await openLabelTool();
  const first = Number(await panel.getAttribute('data-active-class'));

  // Gate on the active class itself: nothing is that class yet, so this
  // stroke is recorded by the renderer but changes no point.
  await page.getByTestId(`label-from-${first}`).click();
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 15_000 });
  await expect.poll(async () => (await counts(panel))['0'] ?? 0, { timeout: 15_000 }).toBe(60);

  // Clear the gate and paint for real.
  await page.getByTestId(`label-from-${first}`).click();
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });
  await expect.poll(() => painted(page), { timeout: 15_000 }).toBe(60);

  await page.getByTestId('label-undo').click();
  await expect(panel).toHaveAttribute('data-labelled-count', '0', { timeout: 15_000 });
  await expect(panel).toHaveAttribute('data-pending-strokes', '1');
  // The overlay agrees with the backend.
  await expect.poll(() => painted(page), { timeout: 15_000 }).toBe(0);
});

test('Cmd+Z and Cmd+Shift+Z undo and redo a label stroke on the backend', async () => {
  // Cmd+Z read the store before the undo re-rendered, so it told the session
  // to keep the stroke it was undoing: the viewport reverted and the counts
  // (and any export) did not. There was no redo at all.
  const { page, panel } = await openLabelTool();
  const first = Number(await panel.getAttribute('data-active-class'));
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-labelled-count', '60', { timeout: 15_000 });
  const second = await otherClass(page, first);
  await page.getByTestId(`label-class-${second}`).click();
  await paintWholeViewport(page);
  await expect.poll(async () => (await counts(panel))[String(second)] ?? 0,
    { timeout: 15_000 }).toBe(60);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await counts(panel))[String(first)] ?? 0,
    { timeout: 15_000 }).toBe(60);
  await expect(panel).toHaveAttribute('data-pending-strokes', '1');

  await page.keyboard.press('ControlOrMeta+z');
  await expect(panel).toHaveAttribute('data-labelled-count', '0', { timeout: 15_000 });
  await expect(panel).toHaveAttribute('data-pending-strokes', '0');
  await expect.poll(() => painted(page), { timeout: 15_000 }).toBe(0);

  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await counts(panel))[String(first)] ?? 0,
    { timeout: 15_000 }).toBe(60);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await counts(panel))[String(second)] ?? 0,
    { timeout: 15_000 }).toBe(60);
  await expect(panel).toHaveAttribute('data-pending-strokes', '2');
  await expect.poll(() => painted(page), { timeout: 15_000 }).toBe(60);

  // The redone strokes kept their ids, so undo still finds them.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await counts(panel))[String(first)] ?? 0,
    { timeout: 15_000 }).toBe(60);
});

test('the quit confirmation knows which clouds have unexported labels', async () => {
  // Read what MAIN holds. It is a count of clouds with labels changed since
  // their last export, so rebuilding the display (closing the panel) must not
  // clear it: the labels are still only in this session.
  const mainCount = () => session.app.evaluate(() =>
    ((globalThis as any).__sceneDirty as { unexportedLabelClouds: number } | undefined)
      ?.unexportedLabelClouds ?? -1);
  const { page, panel } = await openLabelTool();
  await expect.poll(mainCount, { timeout: 10_000 }).toBe(0);

  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 15_000 });
  await expect.poll(mainCount, { timeout: 10_000 }).toBe(1);

  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(await mainCount()).toBe(1);

  await exportLas('quit.las');
  await expect.poll(mainCount, { timeout: 10_000 }).toBe(0);
});

test('with two clouds selected the Label button says why it will not open', async () => {
  // Label Points paints ONE cloud, but the button only required "a cloud": with
  // two selected it stayed live, and the click opened a panel that rendered
  // nothing, with no word about why.
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);
  await importFiles(app, page, 'import-auto', TINY_OFFSET);
  await completeImportWizard(page);
  const rowA = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  const rowB = page.locator('[data-testid="scan-row"][data-scan-name="tiny-offset"]');
  await expect(rowB).toHaveAttribute('data-selected', 'true', { timeout: 20_000 });
  await rowA.getByTestId('scan-row-name').click({ modifiers: ['ControlOrMeta'] });
  await expect(rowA).toHaveAttribute('data-selected', 'true');
  await expect(rowB).toHaveAttribute('data-selected', 'true');

  const button = page.getByTestId('tool-label');
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', /one point cloud at a time/);

  // One cloud selected again: the button works.
  await rowA.getByTestId('scan-row-name').click();
  await expect(rowB).toHaveAttribute('data-selected', 'false');
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId('label-panel')).toBeVisible();
});


test('a pause in painting bakes the column on its own', async () => {
  // With the panel left open, the display still catches up: after a pause the
  // column is rebuilt, the strokes stop being pending, and (a bake being an
  // undo boundary) they can no longer be undone. The pause is shortened here.
  const { page, panel } = await openLabelTool();
  await page.evaluate(() => { (window as any).__labelIdleBakeMs = 1500; });
  try {
    await paintWholeViewport(page);
    await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 15_000 });
    await expect(panel).toHaveAttribute('data-pending-strokes', '0', { timeout: 30_000 });
    await expect(page.getByTestId('label-undo')).toBeDisabled();
    await expect(panel).toHaveAttribute('data-labelled-count', '60');
  } finally {
    await page.evaluate(() => { delete (window as any).__labelIdleBakeMs; });
  }
});
