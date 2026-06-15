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
// The sphere is a hollow shell (no canopy LAD voxels resolve from it — it's a
// triangulation fixture), so rather than assert a voxel result we OBSERVE (not
// stub) the outgoing /api/lad/compute request and prove its grid + scan set were
// taken straight from the reused mesh. That is exactly what "reuse" must do.
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

    // Triangulate with the voxel grid selected (not the auto-fit option).
    await page.getByTestId('tool-triangulate').click();
    await page.getByTestId('triangulation-setup-button').click();
    await expect(page.getByTestId('helios-triangulation-popup')).toBeVisible();
    const heliosGrid = page.getByTestId('helios-grid-select');
    await heliosGrid.selectOption({ index: 1 }); // index 0 = auto; index 1 = our voxel box
    await expect(page.getByTestId('helios-grid-summary')).toBeVisible();
    await page.getByTestId('helios-triangulate-button').click();

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

    // Compute must be enabled without picking a separate voxel grid — the grid
    // came from the reused mesh.
    const computeBtn = page.getByTestId('lad-compute-button');
    await expect(computeBtn).toBeEnabled();

    // Observe (don't stub) the outgoing LAD request to prove reuse actually locks
    // the inversion to the mesh's grid + the four source scans. This is the crux
    // of "reuse an existing triangulation": same grid, same scans, no fresh pick.
    const ladRequest = page.waitForRequest(req =>
      req.url().includes('/api/lad/compute') && req.method() === 'POST');
    await computeBtn.click();
    const req = await ladRequest;
    const body = req.postDataJSON();

    // Four scans were fused into the mesh → four scans in the reused request.
    expect(Array.isArray(body.scans)).toBe(true);
    expect(body.scans.length).toBe(4);
    // The grid is the voxel box we triangulated with (a 1×1×1-cell box), carried
    // straight from the mesh — not a separately-picked grid.
    expect(body.grid).toBeTruthy();
    expect(body.grid.nx).toBe(1);
    expect(body.grid.ny).toBe(1);
    expect(body.grid.nz).toBe(1);

    // The dialog closes once the (live-backend) computation is dispatched.
    await expect(ladPopup).not.toBeVisible({ timeout: 60_000 });

    // (The reused grid box is auto-hidden after a SUCCESSFUL inversion to avoid
    // z-fighting — that hide-on-success path is asserted in lad-multireturn.spec,
    // which has an LAD-solvable fixture. The sphere is a hollow shell that yields
    // no LAD voxels, so we don't assert the hide here.)
  } finally {
    await close();
  }
});
