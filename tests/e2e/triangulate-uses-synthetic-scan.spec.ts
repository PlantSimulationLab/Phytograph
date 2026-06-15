import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// Regression: triangulation (and LAD) must use the IN-RAM synthetic scan data
// that "Overwrite existing data" wrote, NOT silently re-read the original file
// the scanner was imported from.
//
// The bug: importing the four sphere scans from XML stamps each scanner with a
// `sourcePath` pointing at its coarse (100x200) sphere_scan*.xyz. Running a
// finer synthetic scan in overwrite mode replaced `data` but left `sourcePath`
// intact, so the triangulate request took the file_path branch and Helios
// re-triangulated the COARSE on-disk points. With a small Lmax every coarse
// triangle edge exceeds Lmax and gets filtered → 0 triangles, even though the
// fine in-RAM cloud would triangulate richly. (Same hazard for LAD.)
//
// Reproduction here: import the coarse scans, bump each scanner to a finer
// angular grid, scan the sphere mesh with Overwrite, then triangulate at
// Lmax=0.05. The coarse file yields 0 triangles at that Lmax; the fine
// synthetic data yields thousands. Asserting a substantial count proves the
// synthetic data — not the stale file — drove the triangulation.
test('triangulation uses overwritten synthetic data, not the stale source file', async () => {
  const { app, page, close } = await launchApp();

  try {
    // ── 1. Import the four coarse sphere scans from XML ───────────────────
    // Each scanner gets data + params AND a sourcePath to its 100x200 .xyz.
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
    await stubOpenDialog(app, xmlFixture);

    await page.getByTestId('tool-add-scan').click();
    const addPopup = page.getByTestId('scan-parameters-popup');
    await expect(addPopup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(addPopup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page, { timeout: 60_000 });

    const scansPanel = page.getByTestId('scans-panel');
    const rows = scansPanel.locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(4, { timeout: 20_000 });
    for (let i = 0; i < 4; i++) {
      await expect(rows.nth(i)).toHaveAttribute('data-has-data', 'true');
      await expect(rows.nth(i)).toHaveAttribute('data-has-params', 'true');
    }

    // ── 2. Bump each scanner to a finer angular grid ──────────────────────
    // The imported params are 100x200 over zenith 30-130 / azimuth 0-360.
    // Raise the resolution to 400x400 (FOV unchanged) so the synthetic scan
    // produces a genuinely finer cloud than the on-disk coarse file. We edit
    // via each row's pencil button (scan-edit-<id>), reusing the params popup.
    const editPopup = page.getByTestId('scan-parameters-popup');
    for (let i = 0; i < 4; i++) {
      await rows.nth(i).locator('[data-testid^="scan-edit-"]').click();
      await expect(editPopup).toBeVisible();
      await page.getByTestId('scan-zenith-points').fill('400');
      await page.getByTestId('scan-azimuth-points').fill('400');
      await page.getByTestId('scan-submit').click();
      await expect(editPopup).not.toBeVisible();
    }

    // ── 3. Import the sphere mesh to scan ─────────────────────────────────
    // sphere-mesh.ply is the R=0.25 sphere centered at (0,0,0.5) that the four
    // scan origins (±2 on each axis at z=0.5) look at. Use the explicit "Mesh"
    // import (not auto-detect) so the faces-bearing PLY routes straight to a mesh
    // row instead of the point-cloud import wizard.
    await importFiles(app, page, 'import-mesh', join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-mesh.ply'));
    const meshRows = page.getByTestId('mesh-row');
    await expect(meshRows).toHaveCount(1, { timeout: 30_000 });

    // ── 4. Run the synthetic scan, overwriting the coarse imported data ───
    await page.getByTestId('run-synthetic-scan').click();
    // The Synthetic Scan Options popup opens first — accept defaults and run.
    const scanOptions = page.getByTestId('synthetic-scan-options-popup');
    await expect(scanOptions).toBeVisible();
    await page.getByTestId('scan-opt-run').click();
    await expect(scanOptions).not.toBeVisible();
    // Then, because four scanners already carry imported data, the
    // overwrite/duplicate prompt appears. Choose Overwrite (the bug's path).
    await page.getByTestId('scan-overwrite-replace').click();

    // The scan-complete toast confirms the synthetic scan ran and wrote hits.
    await expect(page.getByText(/Scanned [\d,]+ points across/)).toBeVisible({ timeout: 120_000 });

    // Every scanner row keeps params and now carries the fresh synthetic data.
    for (let i = 0; i < 4; i++) {
      await expect(rows.nth(i)).toHaveAttribute('data-has-data', 'true');
    }
    // The fine 400x400 scan must land far more points per scanner than the
    // 100x200 file did (~60). Verify every scanner's data was overwritten with
    // the denser synthetic cloud — not left as the coarse import.
    for (let i = 0; i < 4; i++) {
      const ptStr = await rows.nth(i).getAttribute('data-point-count');
      expect(parseInt(ptStr!, 10)).toBeGreaterThan(364);
    }

    // ── 5. Triangulate at a small Lmax ────────────────────────────────────
    await rows.nth(0).click();
    for (let i = 1; i < 4; i++) {
      await rows.nth(i).click({ modifiers: ['ControlOrMeta'] });
    }
    await page.getByTestId('tool-triangulate').click();
    // The static Triangulate tool opens the panel; with 2+ clouds (or the Helios
    // method) it shows a Setup button that opens the multi-scan Helios dialog.
    await page.getByTestId('triangulation-setup-button').click();
    const heliosPopup = page.getByTestId('helios-triangulation-popup');
    await expect(heliosPopup).toBeVisible();
    // Triangulation runs unfiltered; the Lmax/aspect filter is applied in the
    // mesh panel afterwards.
    await page.getByTestId('helios-triangulate-button').click();

    // A second mesh row (the triangulation result) is appended after the
    // imported sphere mesh.
    await expect(meshRows).toHaveCount(2, { timeout: 60_000 });
    const triMeshRow = meshRows.last();

    // Expand the row and apply a small Lmax. The stale-file bug would triangulate
    // the coarse file → 0 triangles at Lmax=0.05; the fine synthetic data yields
    // thousands. (The chevron's stopPropagation means no row selection is needed.)
    await triMeshRow.getByTestId('mesh-color-expand').click();
    await page.getByTestId('mesh-helios-lmax').fill('0.05');
    await page.getByTestId('mesh-helios-aspect').fill('4');
    await expect.poll(async () => {
      const s = await triMeshRow.getAttribute('data-triangle-count');
      return s ? parseInt(s, 10) : 0;
    }, { timeout: 10_000 }).toBeGreaterThan(500);
    const triangles = parseInt((await triMeshRow.getAttribute('data-triangle-count'))!, 10);

    // The filter breakdown is shown persistently in the mesh's provenance panel:
    // its "Kept" must match the mesh's triangle count and there must be more
    // candidates than kept (filtering happened). We read textContent rather than
    // asserting on-screen visibility — the breakdown's data is what this test
    // verifies. The expanded panel renders as a SIBLING of mesh-row, so scope the
    // stats query to the page, not the row. Only one mesh is expanded.
    const stats = page.getByTestId('mesh-triangulation-filter-stats');
    await expect(stats).toBeAttached({ timeout: 10_000 });
    const statsText = (await stats.textContent()) ?? '';
    expect(statsText).toContain('Filter breakdown');
    const candidates = parseInt(statsText.match(/Candidates:\s*([\d,]+)/)![1].replace(/,/g, ''), 10);
    const kept = parseInt(statsText.match(/Kept:\s*([\d,]+)/)![1].replace(/,/g, ''), 10);
    expect(kept).toBe(triangles);          // panel "Kept" matches the mesh count
    expect(candidates).toBeGreaterThan(kept);
  } finally {
    await close();
  }
});
