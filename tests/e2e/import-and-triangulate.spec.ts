import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Imports a point cloud through the real dropzone, then runs Poisson
// triangulation against the live backend by clicking through the UI:
//   nav → Import → Auto-detect → setInputFiles
//   click cloud row → tool-triangulate → change method to "poisson" →
//   set non-default octree depth → click Run → wait for mesh row to appear
//   in the UI and assert its triangle count.
//
// Per CLAUDE.md Testing rules:
//   1. Live backend on :8008 — no mocking.
//   2. Drive the UI — clicks, change events, DOM reads only.
//   3. Real assertions — read num_triangles from the mesh row, not from
//      a network spy.
test('imports a point cloud, then triangulates via the UI with non-default options', async () => {
  const { app, page, backendVersion, close } = await launchApp();

  try {
    expect(backendVersion).toMatch(/^\d+\.\d+\.\d+/);

    // Import: open the menu, click Auto-detect. That handler calls
    // react-dropzone's open() which fires a real OS file chooser, so we
    // intercept via filechooser BEFORE the click (otherwise the dialog
    // appears on screen and the click hangs waiting for it to close).
    await importFiles(app, page, 'import-auto', FIXTURE);
    await completeImportWizard(page);

    // Confirm the cloud appeared in the cloud list with the right point
    // count. tiny.xyz has 60 data lines (2 comment lines skipped).
    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-point-count', '60');

    // Three.js canvas should be in the DOM. We don't assert on boundingBox
    // dimensions because under PHYTOGRAPH_E2E=1 the window is hidden and
    // layout sizes can be 0; visibility + attached is the load-bearing
    // signal that the viewer mounted.
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeAttached();

    // Freshly imported scan is auto-selected — tool buttons require a selection.
    // (No re-click — a plain click on the sole selection toggles it off.)
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Poisson IS the subject here (this is the only spec driving Poisson and its
    // depth wiring through the UI), so it can't move to Ball Pivoting the way
    // per-instance-colormap / triangulate-merge did. Open3D 0.19.0's Poisson
    // fails nondeterministically on ~6% of calls (see `_run_poisson_isolated`),
    // surfacing as either the child's own PoissonRecon error ("Failed to close
    // loop … FEMTree.IsoSurface…") or the backend's segfault note. Retry ONLY
    // on those two upstream signatures — any other error fails immediately.
    const UPSTREAM_POISSON_FLAKE = /PoissonRecon|Poisson reconstruction crashed inside Open3D/;
    const meshRow = page.getByTestId('mesh-row').first();
    const errorToast = page.getByTestId('toast-error').filter({ hasText: 'Triangulation Failed' });
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      // Open the unified Triangulation modal. The imported scan (no scan params)
      // makes Ball Pivoting the default method and the scan auto-selected.
      await page.getByTestId('tool-triangulate').click();
      const modal = page.getByTestId('triangulation-popup');
      await expect(modal).toBeVisible();
      // The freshly-imported scan should be pre-selected in the picker.
      await expect(modal.getByTestId('triangulation-scan-row')).toHaveCount(1);

      // Non-default user options: switch from Ball Pivoting to Poisson, pick a
      // non-default octree depth of 7. Lower depth = faster on sparse fixtures
      // and exercises method-specific parameter wiring.
      await modal.getByTestId('triangulation-method').selectOption('poisson');
      const depth = modal.getByTestId('triangulation-poisson-depth');
      await expect(depth).toBeVisible();
      // Range input: fill triggers React's onChange the same way the slider does.
      await depth.fill('7');
      await expect(depth).toHaveValue('7');

      // Run it.
      await modal.getByTestId('triangulation-run-button').click();

      // Wait for the mesh row OR a failure toast (Poisson on 60 pts at depth 7
      // takes a few seconds at most against the local backend).
      await expect(meshRow.or(errorToast)).toBeVisible({ timeout: 60_000 });
      if (await meshRow.isVisible()) break;

      const message = (await errorToast.getByTestId('toast-message').textContent()) ?? '';
      if (!UPSTREAM_POISSON_FLAKE.test(message) || attempt >= MAX_ATTEMPTS) {
        throw new Error(`Triangulation failed on attempt ${attempt}/${MAX_ATTEMPTS}: ${message}`);
      }
      console.log(`[import-and-triangulate] upstream Open3D Poisson flake on attempt ${attempt}, retrying: ${message}`);
      // A failed run must not leave a mesh behind, and the toast must go so it
      // can't be mistaken for the next attempt's result.
      await expect(page.getByTestId('mesh-row')).toHaveCount(0);
      await errorToast.getByTestId('toast-close').click();
      await expect(errorToast).toHaveCount(0);
    }
    await expect(page.getByTestId('mesh-row')).toHaveCount(1);

    // The triangle count attribute is set from the live backend response.
    // For this cylinder fixture at Poisson depth 7 we expect a meaningful
    // mesh (low hundreds to low thousands of triangles). The exact value
    // depends on open3d's Poisson reconstruction; assert on a robust range.
    const trianglesStr = await meshRow.getAttribute('data-triangle-count');
    expect(trianglesStr).not.toBeNull();
    const triangles = parseInt(trianglesStr!, 10);
    expect(triangles).toBeGreaterThan(100);
    expect(triangles).toBeLessThan(20_000);

    // Sanity: the visible row text should also report the triangle count.
    await expect(meshRow.getByTestId('mesh-row-count')).toContainText('triangles');

    // The default mesh name should indicate the triangulation method and the
    // source cloud, not a bare "Mesh".
    await expect(meshRow.getByTestId('mesh-row-name')).toHaveText('Poisson triangulation (tiny)');

    // Expand the row and assert the triangulation provenance readout shows the
    // method and the non-default octree depth we set (7).
    await meshRow.getByTestId('mesh-color-expand').click();
    // The expanded panel renders as a SIBLING of mesh-row (inside the per-mesh
    // wrapper), so scope to the page, not the row.
    const info = page.getByTestId('mesh-triangulation-info');
    await expect(info).toBeVisible();
    await expect(info).toContainText('Poisson triangulation');
    await expect(info).toContainText('Octree depth: 7');
  } finally {
    await close();
  }
});
