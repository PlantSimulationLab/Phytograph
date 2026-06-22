import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// The LAD tool can REUSE an existing Helios triangulation instead of running a
// fresh one. "Reuse" now means the backend INJECTS the already-computed mesh
// (via setExternalTriangulation) rather than re-running the Delaunay pass —
// saving a recompute on heavy scans — while still locking the inversion to the
// exact scans + grid + lmax/aspect that produced the mesh.
//
// This drives the full path end-to-end against the live backend on the LAI=2
// leaf-cube fixture (which carries misses, so the inversion can actually run):
//   1. import the scan, build the required voxel grid,
//   2. run a Helios triangulation WITH that grid (so the mesh records its grid +
//      source scan ids and becomes reusable),
//   3. open LAD, pick "Reuse: <mesh>" (scan/grid/lmax pickers hidden, locked),
//   4. Compute — and assert the per-voxel LAD reads near the true 2.0 m²/m³.
// Step 4 is the proof the injected mesh drives G(theta) correctly: a broken
// injection would mis-bin or drop triangles and the LAD would not land near 2.0.
test('LAD reuses a Helios triangulation by injecting the mesh (per-voxel LAD ≈ 2.0)', async () => {
  const { app, page, close } = await launchApp();

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'lad-leafcube', 'leafcube.xml');
    await stubOpenDialog(app, xmlFixture);

    // Import the single leaf-cube scan from XML (attaches data + per-scan params).
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const scansPanel = page.getByTestId('scans-panel');
    const scanRows = scansPanel.locator('[data-testid="scan-row"]');
    await expect(scanRows).toHaveCount(1, { timeout: 20_000 });
    await expect(scanRows.nth(0)).toHaveAttribute('data-has-data', 'true');

    // --- Build the required voxel grid (1×1×1 m box raised to z=0.5) ----------
    await page.getByTestId('tool-create-voxel').click();
    const posZ = page.getByTestId('mesh-pos-z');
    await expect(posZ).toBeVisible();
    await posZ.fill('0.5');
    await posZ.press('Enter');

    // Refocus the scan (creating the box left a mixed selection).
    await scanRows.nth(0).getByTestId('scan-row-name').click();
    await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');

    // --- Triangulate WITH the voxel grid so the mesh is reusable -------------
    await page.getByTestId('tool-triangulate').click();
    const triModal = page.getByTestId('triangulation-popup');
    await expect(triModal).toBeVisible();
    await expect(triModal.getByTestId('triangulation-method')).toHaveValue('helios');
    // Helios triangulation runs UNFILTERED; the Lmax/aspect filter is applied
    // afterward in the Meshes panel (auto-estimated). The reuse path injects the
    // currently-filtered mesh, so the auto-estimated filter is what feeds G(theta).
    const heliosGrid = triModal.getByTestId('helios-grid-select');
    await heliosGrid.selectOption({ index: 1 }); // index 0 = auto; index 1 = our voxel box
    await expect(triModal.getByTestId('helios-grid-summary')).toBeVisible();
    await triModal.getByTestId('triangulation-run-button').click();

    // Two mesh rows now exist: the voxel box (a 12-triangle cube) and the Helios
    // triangulation. Target the triangulation row specifically (the box has no
    // filter), not .first() which is the box.
    const meshRow = page.getByTestId('mesh-row')
      .filter({ hasText: 'Helios triangulation' });
    await expect(meshRow).toBeVisible({ timeout: 120_000 });

    // --- Tighten the mesh filter to the C++ self-test values ----------------
    // The reuse path injects the CURRENTLY-filtered mesh. The auto-estimated
    // filter leaves long "bridge" triangles spanning the hollow cube, which
    // inflate G(theta); dial in the same lmax=0.04 / aspect=10 the fresh-path
    // lad.spec.ts uses so the injected mesh is well-formed. Select + expand the
    // mesh row to reveal the filter inputs.
    await meshRow.click();
    await meshRow.getByTestId('mesh-color-expand').click();
    await expect(page.getByTestId('mesh-tri-lmax')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('mesh-tri-lmax').fill('0.04');
    await page.getByTestId('mesh-tri-lmax').blur();
    await page.getByTestId('mesh-tri-aspect').fill('10');
    await page.getByTestId('mesh-tri-aspect').blur();

    // --- Open LAD and reuse that triangulation ------------------------------
    await scanRows.nth(0).getByTestId('scan-row-name').click();
    await page.getByTestId('tool-compute-lad').click();
    const ladPopup = page.getByTestId('lad-popup');
    await expect(ladPopup).toBeVisible();

    const triSelect = page.getByTestId('lad-triangulation-select');
    await expect(triSelect).toBeVisible();
    await triSelect.selectOption({ index: 1 }); // index 0 = "Run a new triangulation"

    // Reuse locks the scans/grid/lmax: the pickers are hidden and the summary
    // states what's reused.
    await expect(page.getByTestId('lad-reuse-summary')).toBeVisible();
    await expect(page.getByTestId('lad-reuse-summary')).toContainText('1 scan');
    await expect(page.getByTestId('lad-scan-row')).toHaveCount(0);
    await expect(page.getByTestId('lad-grid-select')).toHaveCount(0);
    await expect(page.getByTestId('lad-input-lmax')).toHaveCount(0);

    // The leaf cube carries misses, so Compute is enabled in reuse mode.
    await expect(page.getByTestId('lad-compute-button')).toBeEnabled();
    await page.getByTestId('lad-compute-button').click();

    // The reuse path sends the mesh as a binary frame; the backend injects it
    // (no re-triangulation) and inverts. The result row appears once the live
    // backend returns.
    const ladRow = page.getByTestId('lad-row').first();
    await expect(ladRow).toBeVisible({ timeout: 120_000 });

    const voxelCount = parseInt((await ladRow.getAttribute('data-voxel-count'))!, 10);
    expect(voxelCount).toBeGreaterThanOrEqual(1);

    // The injected-mesh inversion must recover the true LAD ≈ 2.0 m²/m³ — the
    // same band the fresh-triangulation lad.spec.ts asserts. This is the
    // end-to-end proof the reused mesh drives G(theta) correctly.
    const ladMax = parseFloat((await ladRow.getAttribute('data-lad-max'))!);
    expect(ladMax).toBeGreaterThan(1.5);
    expect(ladMax).toBeLessThan(2.7);

    const colorbar = page.getByTestId('lad-colorbar');
    await expect(colorbar).toBeVisible();
    await expect(colorbar).toHaveAttribute('data-colorbar-label', /LAD/);
  } finally {
    await close();
  }
});
