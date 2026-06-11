import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// End-to-end Phase-2 leaf-angle adjustment through the live backend (no mocks):
// import a leaf-on scan, build a voxel grid, Helios-triangulate it (yielding a
// mesh with per-cell leaf-angle data), build a QSM on the same points, add
// leaves, then ADJUST the leaf angles to match the triangulation's measured
// per-cell distribution — asserting the leaves' mean inclination actually
// changes (concrete output, not "didn't throw") while the leaf count is
// preserved. Uses the committed LAI=2 leaf-cube fixture (the same one the LAD
// e2e drives), whose voxel carries a real measured leaf-angle distribution.
test('adjusts QSM leaf angles to a measured distribution via the UI', async () => {
  const { app, page, close } = await launchApp();

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'lad-leafcube', 'leafcube.xml');
    await stubOpenDialog(app, xmlFixture);

    // --- Import the leaf-on scan TWICE (data + per-scan params) ------------
    // Helios triangulation requires >= 2 selected scans with parameters, so we
    // import the same leaf-cube scan twice (the two coincident copies give a
    // real leaf-on triangulation whose voxel carries a measured leaf-angle
    // distribution).
    const scansPanel = page.getByTestId('scans-panel');
    const scanRows = scansPanel.locator('[data-testid="scan-row"]');
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('tool-add-scan').click();
      const scanPopup = page.getByTestId('scan-parameters-popup');
      await expect(scanPopup).toBeVisible();
      await page.getByTestId('scan-import-xml').click();
      await expect(scanPopup).not.toBeVisible({ timeout: 20_000 });
      await completeImportWizard(page);
      await expect(scanRows).toHaveCount(i + 1, { timeout: 20_000 });
    }
    for (let i = 0; i < 2; i++) {
      await expect(scanRows.nth(i)).toHaveAttribute('data-has-params', 'true');
    }

    // --- Select both scans ------------------------------------------------
    // Click the row's NAME element (clicking the row container can hit a child
    // that stops propagation). Plain-click the first to focus it, ctrl-click the
    // second to add it.
    await scanRows.nth(0).getByTestId('scan-row-name').click();
    await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');
    await scanRows.nth(1).getByTestId('scan-row-name').click({ modifiers: ['ControlOrMeta'] });
    await expect(scanRows.nth(1)).toHaveAttribute('data-selected', 'true');
    await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');

    // --- Build the voxel grid (1x1x1 cube raised to cover the leaf cube) ----
    // Creating the box adds it to the selection but keeps the two scans, so the
    // Helios tool (which counts only selected data scans) stays enabled.
    await page.getByTestId('tool-create-voxel').click();
    const posZ = page.getByTestId('mesh-pos-z');
    await expect(posZ).toBeVisible();
    await posZ.fill('0.5');
    await posZ.press('Enter');

    // --- Helios-triangulate the two scans WITHIN the grid ------------------
    // Creating the voxel box selected the box (switching the toolbar away from
    // the scan tools). Refocus both scans so the Helios tool is shown + enabled.
    await scanRows.nth(0).getByTestId('scan-row-name').click();
    await scanRows.nth(1).getByTestId('scan-row-name').click({ modifiers: ['ControlOrMeta'] });
    await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');
    await expect(scanRows.nth(1)).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('tool-triangulate-helios').click();
    const heliosPopup = page.getByTestId('helios-triangulation-popup');
    await expect(heliosPopup).toBeVisible();
    // A grid box exists, so a real grid (not the all-points auto grid) is used.
    await page.getByTestId('helios-input-lmax').fill('0.04');
    await page.getByTestId('helios-input-aspect').fill('10');
    await page.getByTestId('helios-triangulate-button').click();

    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 120_000 });
    expect(parseInt((await meshRow.getAttribute('data-triangle-count'))!, 10)).toBeGreaterThan(0);

    // --- Import the same scan as a point cloud and build a QSM -------------
    await page.getByTestId('import-menu-button').click();
    const cloudXyz = join(repoRoot, 'tests', 'e2e', 'fixtures', 'lad-leafcube', 'leafcube.xyz');
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-pointcloud').click(),
    ]);
    await chooser.setFiles(cloudXyz);
    await completeImportWizard(page);

    // The freshly imported cloud is auto-selected and is the last row; make sure
    // it is the only selection so the QSM builds from it.
    const cloudRow = page.locator('[data-testid="scan-row"]').last();
    if ((await cloudRow.getAttribute('data-selected')) !== 'true') {
      await cloudRow.getByTestId('scan-row-name').click();
    }
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('tool-qsm').click();
    await expect(page.getByTestId('qsm-panel')).toBeVisible();
    await page.getByTestId('qsm-build-button').click();
    const qsmRow = page.getByTestId('qsm-row').first();
    await expect(qsmRow).toBeVisible({ timeout: 60_000 });

    // --- Add leaves -------------------------------------------------------
    await page.getByTestId(/^qsm-add-leaves-/).first().click();
    const addPopup = page.getByTestId('add-leaves-popup');
    await expect(addPopup).toBeVisible();
    await expect(addPopup.getByTestId('add-leaves-phyllo-hint')).not.toContainText('Auto-detecting', { timeout: 15_000 });
    await addPopup.getByTestId('add-leaves-texture-select').selectOption('AlmondLeaf');
    await addPopup.getByTestId('add-leaves-spacing').fill('0.05');
    await addPopup.getByTestId('add-leaves-submit').click();
    await expect(addPopup).toBeHidden();

    const leafSpan = page.getByTestId(/^qsm-leaf-count-/).first();
    await expect(leafSpan).toBeVisible({ timeout: 60_000 });
    const leafCountBefore = parseInt((await leafSpan.getAttribute('data-leaf-count'))!, 10);
    const inclBefore = parseFloat((await leafSpan.getAttribute('data-leaf-incl-mean'))!);
    expect(leafCountBefore).toBeGreaterThan(0);
    expect(Number.isFinite(inclBefore)).toBe(true);

    // --- Adjust leaf angles to the triangulation's measured distribution ---
    // The Adjust action only appears once an eligible Helios grid mesh exists.
    const adjustBtn = page.getByTestId(/^qsm-adjust-leaves-/).first();
    await expect(adjustBtn).toBeVisible();
    await adjustBtn.click();

    const adjPopup = page.getByTestId('adjust-leaf-angles-popup');
    await expect(adjPopup).toBeVisible();
    // The Helios triangulation is offered as the source.
    await expect(adjPopup.getByTestId('adjust-leaves-mesh-select')).toBeVisible();
    await adjPopup.getByTestId('adjust-leaves-submit').click();
    await expect(adjPopup).toBeHidden();

    // The leaf mesh is replaced: count preserved, mean inclination CHANGED.
    await expect(async () => {
      const incAfter = parseFloat((await leafSpan.getAttribute('data-leaf-incl-mean'))!);
      expect(Number.isFinite(incAfter)).toBe(true);
      expect(Math.abs(incAfter - inclBefore)).toBeGreaterThan(1.0);
    }).toPass({ timeout: 60_000 });

    expect(parseInt((await leafSpan.getAttribute('data-leaf-count'))!, 10)).toBe(leafCountBefore);
    // Leaves remain visible after adjustment.
    await expect(page.getByTestId(/^qsm-leaves-toggle-/).first()).toBeVisible();
  } finally {
    await close();
  }
});
