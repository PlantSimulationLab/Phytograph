import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// Drives the Ball Pivot "Crop to grid" option end-to-end against the LIVE
// backend. ground_plants.xyz is a dense ground-cover surface of 2200 points
// spanning x,y ∈ [-1, 1]; a default voxel box is a 1×1×1 m cube at the origin,
// so cropping to it keeps the central 729 points (which ball-pivoting reliably
// meshes). We assert the cropped mesh's provenance reports fewer points used
// than the full cloud — proof the backend numpy mask subset the points before
// meshing.
//
// Per CLAUDE.md E2E rules: live backend, real UI (create the voxel box, toggle
// the option, pick the grid, run), concrete output assertion (points-used count
// strictly below the full cloud), not "didn't throw".
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'ground_plants.xyz');
const FULL_COUNT = 2200;

test('Ball Pivot crop-to-grid meshes only the points inside the voxel box', async () => {
  const { app, page, backendVersion, close } = await launchApp();

  try {
    expect(backendVersion).toMatch(/^\d+\.\d+\.\d+/);

    await importFiles(app, page, 'import-auto', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="ground_plants.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-point-count', String(FULL_COUNT));

    // --- Create a 1×1×1 voxel box at the origin (z ∈ [-0.5, 0.5]) -----------
    await page.getByTestId('tool-create-voxel').click();
    // Creating the box opens its Transform panel and selects it; leave it at the
    // origin so it covers only the lower slice of the tree.
    await expect(page.getByTestId('mesh-pos-z')).toBeVisible();

    // Refocus the scan (creating the box left a mixed selection) so the
    // triangulate tool targets the cloud.
    await cloudRow.getByTestId('scan-row-name').click();
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // --- Triangulate: Ball Pivot + Crop to grid ----------------------------
    await page.getByTestId('tool-triangulate').click();
    const modal = page.getByTestId('triangulation-popup');
    await expect(modal).toBeVisible();
    await modal.getByTestId('triangulation-method').selectOption('ball_pivoting');

    // The crop toggle is Ball-Pivot-only; turn it on and pick the voxel box.
    const cropToggle = modal.getByTestId('triangulation-crop-toggle');
    await expect(cropToggle).toBeVisible();
    await cropToggle.check();
    const cropSelect = modal.getByTestId('triangulation-crop-grid-select');
    await expect(cropSelect).toBeVisible();
    // The only option besides "Auto" is the voxel box we just created.
    await cropSelect.selectOption({ index: 1 });
    await expect(modal.getByTestId('triangulation-crop-grid-summary')).toBeVisible();

    await modal.getByTestId('triangulation-run-button').click();

    // The mesh row appears; its provenance must show points-used below the full
    // cloud (the box keeps only the central ~729 of 2200 points). Note the scene
    // also holds the voxel BOX as its own mesh row, so target the triangulation
    // row by its name, not .first().
    const meshRow = page.getByTestId('mesh-row')
      .filter({ has: page.getByTestId('mesh-row-name') })
      .filter({ hasText: 'Ball-pivoting triangulation' });
    await expect(meshRow).toBeVisible({ timeout: 60_000 });
    await meshRow.click();
    await meshRow.getByTestId('mesh-color-expand').click();

    const info = page.getByTestId('mesh-triangulation-info');
    await expect(info).toBeVisible();
    await expect(info).toContainText('Ball');
    // Read the "Points used: N" line and assert the crop actually subset.
    await expect(info).toContainText('Points used:');
    const text = await info.textContent();
    const m = text?.match(/Points used:\s*([\d,]+)/);
    expect(m).not.toBeNull();
    const pointsUsed = parseInt(m![1].replace(/,/g, ''), 10);
    // Strictly fewer than the full cloud, and more than the 3-point floor.
    expect(pointsUsed).toBeGreaterThan(2);
    expect(pointsUsed).toBeLessThan(FULL_COUNT);
  } finally {
    await close();
  }
});
