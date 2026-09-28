import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { stubSaveDialog } from './helpers/stubSaveDialog';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubMessageBox, getMessageBoxCalls } from './helpers/stubMessageBox';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'forest-plot.xyz');

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

    // ---- Save ----
    await stubSaveDialog(app, projectPath);
    await menu(app, 'save-project');
    await expect(page.locator('[data-testid="toast-success"]').filter({ hasText: 'Project Saved' }))
      .toBeVisible({ timeout: 120_000 });
    expect(existsSync(projectPath)).toBe(true);
    // A ZIP (PK..), holding the cloud's columns: bigger than the scene JSON.
    expect(readFileSync(projectPath).subarray(0, 2).toString()).toBe('PK');
    expect(statSync(projectPath).size).toBeGreaterThan(24_000 * 3 * 8);

    // ---- Open (replaces the scene: the confirmation is asked, and answered) ----
    await stubMessageBox(app, 0);
    await stubOpenDialog(app, projectPath);
    await menu(app, 'open-project');
    await expect(page.locator('[data-testid="toast-success"]').filter({ hasText: 'Project Opened' }))
      .toBeVisible({ timeout: 120_000 });
    expect((await getMessageBoxCalls(app)).length).toBe(1);

    const reopened = page.locator('[data-testid="scan-row"][data-scan-name="forest-plot"]');
    await expect(reopened).toHaveCount(1, { timeout: 30_000 });
    await expect(reopened).toHaveAttribute('data-point-count', pointCount!);
    await expect(page.locator('[data-testid="mesh-row"]')).toHaveCount(1);
    await expect(page.locator(`[data-testid="mesh-row"][data-mesh-name="${meshName}"]`)).toHaveCount(1);
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
