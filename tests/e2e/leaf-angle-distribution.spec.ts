import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// Drives the leaf-angle distribution feature end-to-end against the LIVE
// backend. We import the four sphere scans, Helios-triangulate them (auto grid),
// then open the mesh's "Leaf angles…" window and assert the inclination PDF
// chart renders, the azimuth rose renders, a de Wit best-fit label appears, and
// the per-cell tick-box toggles a curve off and back on.
//
// The auto grid is a single cell, so the cell list collapses to one "Whole
// mesh" entry — which is the right thing to verify here: the UI path from a
// triangulated mesh to a rendered, area-weighted, de-Wit-fitted distribution.
// The multi-cell binning (triangle_cell_ids routing triangles across >1 voxel)
// is covered against real pyhelios by the backend test
// `test_triangle_cell_ids_align_and_route_to_grid` and by the frontend unit
// tests for computeInclinationPdf({cellId}).
test('leaf angle distribution: inclination PDF, azimuth rose, de Wit fit', async () => {
  const { app, page, close } = await launchApp();

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
    await stubOpenDialog(app, xmlFixture);

    // Import the four sphere scans (params + data auto-attached from the XML).
    await page.getByTestId('tool-add-scan').click();
    const scanPopup = page.getByTestId('scan-parameters-popup');
    await expect(scanPopup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(scanPopup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const scansPanel = page.getByTestId('scans-panel');
    const scanRows = scansPanel.locator('[data-testid="scan-row"]');
    await expect(scanRows).toHaveCount(4, { timeout: 20_000 });

    // Select all four scans.
    await scanRows.nth(0).click();
    for (let i = 1; i < 4; i++) {
      await scanRows.nth(i).click({ modifiers: ['ControlOrMeta'] });
    }

    // --- Helios triangulate (auto grid) ------------------------------------
    await page.getByTestId('tool-triangulate').click();
    // Scans carry params, so the unified Triangulation modal defaults to Helios.
    const modal = page.getByTestId('triangulation-popup');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('triangulation-method')).toHaveValue('helios');
    await expect(modal.getByTestId('helios-grid-allpoints-warning')).toBeVisible();
    // Triangulation runs unfiltered; the Lmax/aspect filter is applied in the
    // mesh panel afterwards.
    await modal.getByTestId('triangulation-run-button').click();

    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });

    // --- Filter the mesh, then open the leaf-angle window ------------------
    await meshRow.click();
    await meshRow.getByTestId('mesh-color-expand').click();
    await page.getByTestId('mesh-tri-lmax').fill('0.5');
    await page.getByTestId('mesh-tri-aspect').fill('5');
    await expect.poll(async () => {
      const s = await meshRow.getAttribute('data-triangle-count');
      return s ? parseInt(s, 10) : 0;
    }, { timeout: 10_000 }).toBeGreaterThan(300);

    await page.getByTestId('mesh-leaf-angles').click();

    const popup = page.getByTestId('leaf-angle-popup');
    await expect(popup).toBeVisible();

    // The inclination PDF chart renders an SVG line path (recharts).
    const inclChart = page.getByTestId('incl-chart');
    await expect(inclChart).toBeVisible();
    const curves = inclChart.locator('path.recharts-line-curve');
    await expect(curves.first()).toBeVisible();
    // One whole-mesh curve + the de Wit dashed fit line = 2 curves.
    const before = await curves.count();
    expect(before).toBeGreaterThanOrEqual(2);

    // The empirical PDF draws a point at each bin center (recharts dots). The
    // default is 18 bins → 18 dots on the whole-mesh curve.
    const dots = inclChart.locator('circle.recharts-dot');
    await expect.poll(async () => dots.count()).toBe(18);

    // Bin count is configurable: switching to 9 bins redraws with 9 points.
    await page.getByTestId('incl-bins').selectOption('9');
    await expect.poll(async () => dots.count()).toBe(9);
    // …and back to a finer 45-bin resolution.
    await page.getByTestId('incl-bins').selectOption('45');
    await expect.poll(async () => dots.count()).toBe(45);

    // The azimuth rose renders, with rings/spokes/petal paths.
    const rose = page.getByTestId('azimuth-rose');
    await expect(rose).toBeVisible();
    expect(await rose.locator('path').count()).toBeGreaterThan(0);
    expect(await rose.locator('circle').count()).toBeGreaterThan(0);

    // A de Wit best-fit label is shown and names one of the six canonical
    // forms. (Which archetype wins depends on scan coverage — the four sphere
    // scanners sit in the horizontal plane and mostly see the sphere's sides,
    // so the reconstruction skews vertical; the exact winner is incidental.
    // The fitting LOGIC is verified deterministically in the unit tests, where
    // the input distribution is controlled.)
    const fitLabel = page.getByTestId('dewit-fit-label');
    await expect(fitLabel).toBeVisible();
    await expect(fitLabel).toContainText(
      /Best fit: (Planophile|Erectophile|Plagiophile|Extremophile|Spherical|Uniform) \(R²=/);

    // --- Per-cell tick-boxes -----------------------------------------------
    // Auto grid → exactly one "Whole mesh" cell entry.
    const cellBoxes = page.getByTestId('cell-checkbox');
    await expect(cellBoxes).toHaveCount(1);
    await expect(cellBoxes.first()).toContainText('Whole mesh');

    // Unchecking the cell removes its curve (the fit line goes too, since there
    // is nothing visible to fit) → no line curves remain.
    await cellBoxes.first().locator('input[type=checkbox]').uncheck();
    await expect.poll(async () => curves.count()).toBeLessThan(before);

    // Re-check restores the curves.
    await cellBoxes.first().locator('input[type=checkbox]').check();
    await expect.poll(async () => curves.count()).toBe(before);
  } finally {
    await close();
  }
});
