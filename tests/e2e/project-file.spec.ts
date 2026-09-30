import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { stubSaveDialog } from './helpers/stubSaveDialog';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubMessageBox, getMessageBoxCalls } from './helpers/stubMessageBox';
import { resetToFreshScene } from './helpers/resetApp';
import { fixturePoints, pointsDrawnIn } from './helpers/pointColors';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'forest-plot.xyz');
const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Save a scene as a .phyto project, open it back, and prove the reopened
// scene is the same scene - and still live, not a picture of one:
//
//   import -> Segment Ground (a computed column + a rebuilt octree)
//          -> a voxel-grid mesh -> File > Save Project
//          -> File > Open Project (replaces the scene; confirmation asked)
//          -> the cloud is back with its point count and ground coloring, the
//             mesh is back, and a DEM runs on the reopened cloud using the
//             SAVED ground labels (proof its backend session came back whole).
//
// One test, one app: the steps are one workflow.
let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});

/** What MAIN believes about unsaved work (its quit/close prompt reads this). */
async function expectMainDirty(app: LaunchedApp['app'], dirty: boolean, why: string) {
  await expect.poll(
    () => app.evaluate(() => ((globalThis as Record<string, unknown>).__sceneDirty as
      { dirty: boolean } | undefined)?.dirty ?? null),
    { message: `main should think the scene is ${dirty ? 'dirty' : 'clean'}: ${why}`, timeout: 20_000 },
  ).toBe(dirty);
}

async function menu(app: LaunchedApp['app'], kind: string) {
  await app.evaluate(({ BrowserWindow }, k) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: k });
  }, kind);
}

test('save a project, open it back, and keep working on it', async () => {
  test.setTimeout(6 * 60_000);
  const { app, page } = session;
  const projectPath = join(tmpdir(), `phytograph_project_e2e_${Date.now()}.phyto`);
  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);
    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="forest-plot"]');
    await expect(cloudRow).toBeVisible({ timeout: 30_000 });
    const pointCount = await cloudRow.getAttribute('data-point-count');
    expect(parseInt(pointCount ?? '0', 10)).toBeGreaterThan(20_000);

    await page.getByTestId('tool-ground-segment').click();
    await page.getByTestId('ground-segment-run-button').click();
    await expect(page.getByTestId('class-legend')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('scalar-overlay')).toHaveAttribute('data-active-scalar', 'ground_class');

    await page.getByTestId('tool-create-voxel').click();
    const meshRows = page.locator('[data-testid="mesh-row"]');
    await expect(meshRows).toHaveCount(1, { timeout: 20_000 });
    const meshName = await meshRows.first().getAttribute('data-mesh-name');
    // Display state set by hand must come back too (it used to reset).
    await meshRows.first().getByTestId('mesh-color-expand').click();
    await page.getByTestId('mesh-opacity').fill('0.8');
    await expect(page.getByTestId('mesh-opacity')).toHaveValue('0.8');

    // ---- Save ----
    await stubSaveDialog(app, projectPath);
    await menu(app, 'save-project');
    await expect(page.locator('[data-testid="toast-success"]').filter({ hasText: 'Project Saved' }))
      .toBeVisible({ timeout: 120_000 });
    expect(existsSync(projectPath)).toBe(true);
    await expectMainDirty(app, false, 'just saved');

    // Viewer-only state is saved too, so changing it must count as unsaved
    // work. Scene-store identity alone missed it: quitting after e.g. a tree
    // inventory, measurements or this point-size change asked nothing.
    await page.getByRole('button', { name: 'Display', exact: true }).click();
    await page.getByTitle('Increase Point Size').click();
    await expectMainDirty(app, true, 'point size changed after the save');
    // A ZIP (PK..) holding the cloud's columns as compressed `.pz` members
    // (member names are plain text in the ZIP headers). The display octree
    // matches its session after Segment Ground's rebuild, so it is NOT
    // embedded (the session rebuilds it on open), and the whole file is
    // smaller than the raw float64 positions alone.
    const bytes = readFileSync(projectPath);
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.includes('/positions.pz')).toBe(true);
    expect(bytes.includes('octrees/')).toBe(false);
    expect(statSync(projectPath).size).toBeLessThan(parseInt(pointCount ?? '0', 10) * 3 * 8);

    // ---- Open on a machine that has never shown this cloud ----
    // Empty the octree cache, so the open has to rebuild the display from the
    // saved session (and the renderer has to follow any renamed ids). The
    // `.sessions` spill dir holds live session stores, not octrees; keep it.
    const octreeDirs = () => readdirSync(session.octreeCacheRoot).filter((n) => /^[0-9a-f]{40}$/.test(n));
    expect(octreeDirs().length).toBeGreaterThan(0);
    for (const d of octreeDirs()) rmSync(join(session.octreeCacheRoot, d), { recursive: true, force: true });
    expect(octreeDirs()).toEqual([]);

    // ---- Open (replaces the scene: the confirmation is asked, and answered) ----
    await stubMessageBox(app, 0);
    await stubOpenDialog(app, projectPath);
    await menu(app, 'open-project');
    await expect(page.locator('[data-testid="toast-success"]').filter({ hasText: 'Project Opened' }))
      .toBeVisible({ timeout: 120_000 });
    expect((await getMessageBoxCalls(app)).length).toBe(1);
    await expectMainDirty(app, false, 'just opened');
    // Rebuilt by the open, not by a later missing-octree recovery.
    expect(octreeDirs().length).toBeGreaterThan(0);

    const reopened = page.locator('[data-testid="scan-row"][data-scan-name="forest-plot"]');
    await expect(reopened).toHaveCount(1, { timeout: 30_000 });
    await expect(reopened).toHaveAttribute('data-point-count', pointCount!);
    await expect(page.locator('[data-testid="mesh-row"]')).toHaveCount(1);
    await expect(page.locator(`[data-testid="mesh-row"][data-mesh-name="${meshName}"]`)).toHaveCount(1);
    await page.locator('[data-testid="mesh-row"]').first().getByTestId('mesh-color-expand').click();
    await expect(page.getByTestId('mesh-opacity')).toHaveValue('0.8');
    await expect(page.getByTestId('scalar-overlay'))
      .toHaveAttribute('data-active-scalar', 'ground_class', { timeout: 30_000 });

    // ---- Keep working: a DEM on the reopened cloud uses its saved ground labels ----
    if ((await reopened.getAttribute('data-selected')) !== 'true') {
      await reopened.click({ position: { x: 40, y: 8 } });
    }
    await expect(reopened).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('tool-dem').click();
    await expect(page.getByTestId('dem-panel')).toBeVisible();
    // Ground labels came back: no "no ground classification" warning.
    await expect(page.getByTestId('dem-no-ground-warning')).toHaveCount(0);
    await page.getByTestId('dem-cell-size').fill('0.5');
    await page.getByTestId('dem-run-button').click();
    await expect(page.locator('[data-testid="mesh-row"][data-mesh-name="forest-plot DEM"]'))
      .toBeVisible({ timeout: 120_000 });
  } finally {
    if (existsSync(projectPath)) rmSync(projectPath);
  }
});

// Uncommitted label strokes. A stroke writes the backend's label column but
// not the display octree (a bake does that later); until then the overlay is
// the only thing drawing it. The project saved the column but not the
// overlay, and reopened with the cached PRE-label octree: the hand labels
// looked erased, and nothing offered to bake them.
test('labels painted but not yet baked are still drawn after save and open', async () => {
  test.setTimeout(4 * 60_000);
  const { app, page } = session;
  await resetToFreshScene(app, page);
  const projectPath = join(tmpdir(), `phytograph_project_labels_${Date.now()}.phyto`);
  try {
    await importFiles(app, page, 'import-auto', TINY);
    await completeImportWizard(page);
    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
    await expect(row).toHaveAttribute('data-point-count', '60', { timeout: 20_000 });
    await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
    await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));

    await page.getByTestId('tool-label').click();
    const panel = page.getByTestId('label-panel');
    await expect(panel).toBeVisible();
    const active = await panel.getAttribute('data-active-class');
    const color = (await page.getByTestId(`label-class-${active}`).getAttribute('data-color'))!;
    const overlay = page.getByTestId('crop-polygon-overlay');
    await expect(overlay.locator('circle')).toHaveCount(0, { timeout: 10_000 });
    const box = (await overlay.boundingBox())!;
    const corners = [[8, 8], [box.width - 8, 8], [box.width - 8, box.height - 8], [8, box.height - 8]];
    for (let i = 0; i < corners.length; i++) {
      await page.mouse.click(box.x + corners[i][0], box.y + corners[i][1]);
      await expect(overlay.locator('circle')).toHaveCount(i + 1);
    }
    await page.keyboard.press('Enter');
    await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 15_000 });
    await expect(panel).toHaveAttribute('data-label-dirty', 'true');

    // Saved with the stroke still pending (the panel open, no bake yet).
    await stubSaveDialog(app, projectPath);
    await menu(app, 'save-project');
    await expect(page.locator('[data-testid="toast-success"]').filter({ hasText: 'Project Saved' }))
      .toBeVisible({ timeout: 60_000 });
    await expect(panel).toHaveAttribute('data-pending-strokes', '1');

    await stubMessageBox(app, 0);
    await stubOpenDialog(app, projectPath);
    await menu(app, 'open-project');
    await expect(page.locator('[data-testid="toast-success"]').filter({ hasText: 'Project Opened' }))
      .toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid="scan-row"][data-scan-name="tiny"]')).toHaveCount(1);

    const pts = fixturePoints(TINY);
    await expect.poll(async () => (await pointsDrawnIn(page, pts, color, 40)).matched, {
      message: `the painted points should still be drawn in the label color ${color} after reopening`,
      timeout: 30_000,
    }).toBeGreaterThan(30);
  } finally {
    if (existsSync(projectPath)) rmSync(projectPath);
  }
});
