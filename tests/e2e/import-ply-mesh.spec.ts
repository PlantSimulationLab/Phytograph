import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { completeImportWizard } from './helpers/importWizard';

// PLY is an ambiguous container: it may hold a point cloud (vertices only) or a
// polygon mesh (vertices + faces). Auto-detect must read the header and route
// each to the correct pathway:
//   - cube-mesh.ply (has `element face`) → mesh, via /api/mesh/import
//   - tiny.ply      (vertices only)      → point cloud
//
// Per CLAUDE.md Testing rules: live backend, drive the real UI through the file
// chooser, assert on concrete output (triangle vs point counts), no mocking.
const MESH_PLY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'cube-mesh.ply');
const CLOUD_PLY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.ply');

test('auto-detects a PLY polygon mesh and imports it as a mesh', async () => {
  const { page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(MESH_PLY);

    // The cube becomes a mesh row (not a scan/point-cloud row).
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 30_000 });
    // 12 triangles in the cube fixture.
    await expect(meshRow).toHaveAttribute('data-triangle-count', '12');
    // Auto-named after the imported file's base name (cube-mesh.ply → cube-mesh).
    await expect(meshRow).toHaveAttribute('data-mesh-name', 'cube-mesh');

    // It must NOT have landed as a point cloud.
    await expect(page.getByTestId('scan-row')).toHaveCount(0);
    await expect(page.getByTestId('empty-viewer-hint')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('auto-detects a vertices-only PLY and imports it as a point cloud', async () => {
  const { page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(CLOUD_PLY);

    // A path-backed point cloud routes through the import wizard; complete it.
    await completeImportWizard(page);

    // The vertices-only PLY lands as a scan (point cloud) with 60 points.
    const scanRow = page.getByTestId('scan-row').first();
    await expect(scanRow).toBeVisible({ timeout: 30_000 });
    await expect(scanRow).toHaveAttribute('data-point-count', '60');

    // It must NOT have been treated as a mesh.
    await expect(page.getByTestId('mesh-row')).toHaveCount(0);
  } finally {
    await close();
  }
});
