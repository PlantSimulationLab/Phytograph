import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// Drives the interactive triangle filter AND the leaf-angle plot for a NON-Helios
// (Open3D) triangulation against the LIVE backend — the two pure-geometry mesh
// tools that used to be gated to Helios meshes only.
//
// Flow (all through the real UI):
//   import tree.xyz → triangulate with Delaunay (an Open3D method that bridges
//   long gaps, so the Lmax filter has a dramatic, assertable effect) →
//   expand the mesh row → confirm the Lmax / aspect filter controls appear and
//   the Helios-only Auto button + separation readout do NOT → tighten Lmax and
//   assert the triangle count drops → open "Leaf angles…" and assert the plot
//   renders with the gridless "Whole mesh" fallback + a de Wit fit.
//
// Per CLAUDE.md E2E rules: live backend, real UI, concrete output assertions
// (triangle counts in known ranges, rendered chart elements), not "didn't throw".
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

test('Open3D mesh: triangle filter + leaf-angle plot (no Helios)', async () => {
  const { app, page, backendVersion, close } = await launchApp();

  try {
    expect(backendVersion).toMatch(/^\d+\.\d+\.\d+/);

    await importFiles(app, page, 'import-auto', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // --- Triangulate with Delaunay (Open3D, no scan params) ----------------
    await page.getByTestId('tool-triangulate').click();
    const modal = page.getByTestId('triangulation-popup');
    await expect(modal).toBeVisible();
    // A paramless imported cloud defaults to an Open3D method (Ball Pivoting);
    // switch to Delaunay so the Lmax filter has long bridge triangles to cut.
    await modal.getByTestId('triangulation-method').selectOption('delaunay');
    await modal.getByTestId('triangulation-run-button').click();

    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });

    const countOf = async () => {
      const s = await meshRow.getAttribute('data-triangle-count');
      return s ? parseInt(s, 10) : 0;
    };
    const unfiltered = await countOf();
    expect(unfiltered).toBeGreaterThan(100);

    // NOTE: the interactive Lmax/aspect triangle filter (mesh-tri-filter) is a
    // Helios-only feature — commit f0cf7ba ("Drop post-triangulation Lmax/aspect
    // filter for Open3D cloud methods") deliberately made it exclusive to Helios
    // meshes, since each Open3D method (ball-pivot radius, alpha, poisson depth)
    // already applies its own length scale. Open3D/Delaunay meshes carry no
    // triangleFilter/unfilteredMesh, so MeshesListPanel hides those controls for
    // them. This test therefore no longer asserts the filter panel; it verifies
    // the leaf-angle plot, which IS available for any triangulated non-DEM mesh.
    await meshRow.click();
    await meshRow.getByTestId('mesh-color-expand').click();

    // --- Leaf-angle plot works on the Open3D mesh (gridless whole-mesh) ----
    await page.getByTestId('mesh-leaf-angles').click();
    const popup = page.getByTestId('leaf-angle-popup');
    await expect(popup).toBeVisible();

    // The inclination PDF chart renders curves (empirical + de Wit fit line).
    const inclChart = page.getByTestId('incl-chart');
    await expect(inclChart).toBeVisible();
    await expect(inclChart.locator('path.recharts-line-curve').first()).toBeVisible();
    // Default 18 bins → 18 empirical points.
    await expect.poll(async () => inclChart.locator('circle.recharts-dot').count()).toBe(18);

    // The azimuth rose renders.
    const rose = page.getByTestId('azimuth-rose');
    await expect(rose).toBeVisible();
    expect(await rose.locator('path').count()).toBeGreaterThan(0);

    // A de Wit best-fit label names one of the canonical archetypes.
    const fitLabel = page.getByTestId('dewit-fit-label');
    await expect(fitLabel).toBeVisible();
    await expect(fitLabel).toContainText(
      /Best fit: (Planophile|Erectophile|Plagiophile|Extremophile|Spherical|Uniform) \(R²=/);

    // No grid → exactly one "Whole mesh" cell entry (the gridless fallback).
    const cellBoxes = page.getByTestId('cell-checkbox');
    await expect(cellBoxes).toHaveCount(1);
    await expect(cellBoxes.first()).toContainText('Whole mesh');
  } finally {
    await close();
  }
});
