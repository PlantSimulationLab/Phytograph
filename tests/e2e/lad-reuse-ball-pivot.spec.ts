import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// A BALL-PIVOT triangulation can now feed the leaf-area (LAD) inversion, the same
// way a Helios one can — provided it is built PER-SCAN and PINNED to a voxel grid.
// "Pinned" means the mesh records the grid + its per-triangle cell ids, so the
// LAD reuse path injects that exact mesh (setExternalTriangulation) and keeps only
// the in-grid triangles. The backend NEVER re-triangulates in the reuse branch, so
// this proves the user's ball-pivot mesh — not a silent Helios recompute — drives
// the result (the third gotcha: "be sure the ball-pivot triangulation is actually
// used"). It also pins the eligibility UX: a merged ball-pivot mesh is rejected
// with a visible reason.
//
// Driven end-to-end against the live backend on the LAI=2 leaf-cube fixture (which
// carries misses, so the inversion can run):
//   1. import the scan, build the required voxel grid,
//   2. run a BALL PIVOT triangulation PINNED to that grid (per-scan),
//   3. confirm the mesh shows the "re-usable for leaf-area inversion" note,
//   4. open LAD, pick "Reuse: <ball-pivot mesh>", Compute,
//   5. assert a real per-voxel LAD result came back (positive, finite, ≥1 voxel).
test('LAD reuses a per-scan ball-pivot triangulation pinned to a grid', async () => {
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

    // --- Ball-pivot triangulation PINNED to the voxel grid (per-scan) ---------
    await page.getByTestId('tool-triangulate').click();
    const triModal = page.getByTestId('triangulation-popup');
    await expect(triModal).toBeVisible();
    // The scan carries params so the modal defaults to Helios — switch to Ball Pivoting.
    await triModal.getByTestId('triangulation-method').selectOption('ball_pivoting');
    // Pin to the voxel box via the ball-pivot Grid selector (index 0 = "Auto").
    const gridSelect = triModal.getByTestId('triangulation-grid-select');
    await expect(gridSelect).toBeVisible();
    await gridSelect.selectOption({ index: 1 });
    // Per-scan output (the default) → the summary confirms LAD-reusability.
    await expect(triModal.getByTestId('triangulation-grid-summary')).toBeVisible();
    await triModal.getByTestId('triangulation-run-button').click();

    // The ball-pivot mesh row appears (distinct from the voxel-box row).
    const meshRow = page.getByTestId('mesh-row')
      .filter({ hasText: 'Ball-pivoting triangulation' });
    await expect(meshRow).toBeVisible({ timeout: 120_000 });

    // --- The mesh advertises itself as LAD-re-usable -------------------------
    await meshRow.click();
    await meshRow.getByTestId('mesh-color-expand').click();
    await expect(page.getByTestId('mesh-lad-ready-note')).toBeVisible({ timeout: 10_000 });

    // --- Open LAD and reuse the ball-pivot triangulation --------------------
    await scanRows.nth(0).getByTestId('scan-row-name').click();
    await page.getByTestId('tool-compute-lad').click();
    const ladPopup = page.getByTestId('lad-popup');
    await expect(ladPopup).toBeVisible();

    const triSelect = page.getByTestId('lad-triangulation-select');
    await expect(triSelect).toBeVisible();
    // Index 0 = "Run a new triangulation"; index 1 = "Reuse: <ball-pivot mesh>".
    await triSelect.selectOption({ index: 1 });

    // Reuse locks scans/grid/lmax: the pickers are hidden and the summary states it.
    await expect(page.getByTestId('lad-reuse-summary')).toBeVisible();
    await expect(page.getByTestId('lad-reuse-summary')).toContainText('1 scan');

    await expect(page.getByTestId('lad-compute-button')).toBeEnabled();
    await page.getByTestId('lad-compute-button').click();

    // The reuse path sends the ball-pivot mesh as a binary frame; the backend
    // injects it (no re-triangulation) and inverts. A real per-voxel result
    // appears once the live backend returns — proof the BP mesh drove G(theta).
    const ladRow = page.getByTestId('lad-row').first();
    await expect(ladRow).toBeVisible({ timeout: 120_000 });

    const voxelCount = parseInt((await ladRow.getAttribute('data-voxel-count'))!, 10);
    expect(voxelCount).toBeGreaterThanOrEqual(1);

    // Positive, finite LAD — the inversion ran on the injected surface, not on an
    // empty/degenerate mesh. (We don't pin the exact value: a ball-pivot surface
    // reconstructs the leaf cube differently than the C++ Delaunay self-test, so
    // its G(theta) — and thus LAD — legitimately differs from the Helios path.)
    const ladMax = parseFloat((await ladRow.getAttribute('data-lad-max'))!);
    expect(Number.isFinite(ladMax)).toBe(true);
    expect(ladMax).toBeGreaterThan(0);
  } finally {
    await close();
  }
});
