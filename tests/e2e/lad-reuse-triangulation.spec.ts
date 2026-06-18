import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// The LAD tool can REUSE an existing Helios triangulation instead of running a
// fresh one. The backend always re-triangulates internally, so "reuse" means the
// inversion is locked to the exact scans + grid + lmax/aspect that produced the
// mesh, reproducing its G-function. This drives that path end-to-end against the
// live backend: triangulate the four sphere scans WITH an explicit voxel grid
// (so the mesh records its grid + source scan ids), then open LAD, pick
// "Reuse: <mesh>", and run with no scan/grid picker.
//
// The sphere is a hollow shell with no misses, so it can't actually run LAD now
// that misses are required — but that's fine for this test: the reuse contract is
// proven by the reuse summary ("4 scans") + the hidden scan/grid/lmax pickers
// (locked to the mesh), and the miss gate correctly disables Compute with an
// unrecoverable-misses banner. That is exactly what "reuse" must do under the gate.
test('LAD reuses an existing Helios triangulation (scans + grid locked to the mesh)', async () => {
  const { app, page, close } = await launchApp();

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
    await stubOpenDialog(app, xmlFixture);

    // Import the four sphere scans (each <scan> references a sibling .xyz).
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const scansPanel = page.getByTestId('scans-panel');
    const rows = scansPanel.locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(4, { timeout: 20_000 });

    // Build a voxel grid box enclosing the unit sphere (default 1×1×1 m box at
    // the origin spans [-0.5, 0.5] on each axis — the sphere fits). A reusable
    // LAD triangulation must carry an explicit grid, so we triangulate with one.
    await page.getByTestId('tool-create-voxel').click();
    await expect(page.getByTestId('mesh-pos-z')).toBeVisible();

    // Re-select all four scans (creating the box changed the selection).
    await rows.nth(0).getByTestId('scan-row-name').click();
    for (let i = 1; i < 4; i++) {
      await rows.nth(i).getByTestId('scan-row-name').click({ modifiers: ['ControlOrMeta'] });
    }

    // Triangulate with the voxel grid selected (not the auto-fit option). Scans
    // carry params, so the unified Triangulation modal defaults to Helios.
    await page.getByTestId('tool-triangulate').click();
    const triModal = page.getByTestId('triangulation-popup');
    await expect(triModal).toBeVisible();
    await expect(triModal.getByTestId('triangulation-method')).toHaveValue('helios');
    const heliosGrid = triModal.getByTestId('helios-grid-select');
    await heliosGrid.selectOption({ index: 1 }); // index 0 = auto; index 1 = our voxel box
    await expect(triModal.getByTestId('helios-grid-summary')).toBeVisible();
    await triModal.getByTestId('triangulation-run-button').click();

    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });

    // --- Open LAD and reuse that triangulation -----------------------------
    await page.getByTestId('tool-compute-lad').click();
    const ladPopup = page.getByTestId('lad-popup');
    await expect(ladPopup).toBeVisible();

    // The reuse selector is present because a Helios mesh with a grid + recorded
    // source scans exists. Pick the (only) reuse option.
    const triSelect = page.getByTestId('lad-triangulation-select');
    await expect(triSelect).toBeVisible();
    await triSelect.selectOption({ index: 1 }); // index 0 = "Run a new triangulation"

    // In reuse mode the scan picker, grid selector, and lmax/aspect inputs are
    // hidden (locked to the mesh); the reuse summary states what's reused.
    await expect(page.getByTestId('lad-reuse-summary')).toBeVisible();
    await expect(page.getByTestId('lad-reuse-summary')).toContainText('4 scans');
    await expect(page.getByTestId('lad-scan-row')).toHaveCount(0);
    await expect(page.getByTestId('lad-grid-select')).toHaveCount(0);
    await expect(page.getByTestId('lad-input-lmax')).toHaveCount(0);

    // LAD now HARD-REQUIRES misses (the Beer's-law transmission denominator), and
    // the reuse path is no exception — reusing a triangulation locks the grid +
    // scans but does not waive the miss requirement. The sphere scans have no
    // misses yet but DO carry a row/column scan grid, so they're recoverable: the
    // backfill banner offers a Backfill button and Compute stays disabled until
    // misses are recovered. This proves the gate applies in reuse mode; the
    // grid/scan locking itself is proven by the reuse summary + hidden pickers.
    await expect(page.getByTestId('lad-backfill-hint')).toBeVisible();
    await expect(page.getByTestId('lad-backfill-hint')).toContainText(/recover them first/i);
    await expect(page.getByTestId('lad-backfill-button')).toBeVisible();
    await expect(page.getByTestId('lad-compute-button')).toBeDisabled();
  } finally {
    await close();
  }
});
