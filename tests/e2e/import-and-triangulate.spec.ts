import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';

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
  const { page, backendVersion, close } = await launchApp();

  try {
    expect(backendVersion).toMatch(/^\d+\.\d+\.\d+/);

    // Go to Viewer (where Import lives).
    await page.getByTestId('nav-viewer').click();

    // Import: open the menu, click Auto-detect, then push the fixture into
    // the hidden file input that react-dropzone exposes.
    await page.getByTestId('import-menu-button').click();
    await page.getByTestId('import-menu-auto').click();
    await page.getByTestId('app-dropzone-input').setInputFiles(FIXTURE);

    // Confirm the cloud appeared in the cloud list with the right point
    // count. tiny.xyz has 60 data lines (2 comment lines skipped).
    const cloudRow = page.locator('[data-testid="cloud-row"][data-cloud-name="tiny.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-point-count', '60');

    // Three.js canvas should be in the DOM. We don't assert on boundingBox
    // dimensions because under PHYTOGRAPH_E2E=1 the window is hidden and
    // layout sizes can be 0; visibility + attached is the load-bearing
    // signal that the viewer mounted.
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeAttached();

    // Select the cloud (tool buttons require a selection).
    await cloudRow.click();
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Open the triangulation panel.
    await page.getByTestId('tool-triangulate').click();
    const panel = page.getByTestId('triangulation-panel');
    await expect(panel).toBeVisible();

    // Non-default user options: switch from Ball Pivoting to Poisson, pick a
    // non-default octree depth of 7 (default is 9). Lower depth = faster on
    // sparse fixtures and exercises method-specific parameter wiring.
    await page.getByTestId('triangulation-method').selectOption('poisson');
    const depth = page.getByTestId('triangulation-poisson-depth');
    await expect(depth).toBeVisible();
    // Range input: fill triggers React's onChange the same way the slider does.
    await depth.fill('7');
    await expect(depth).toHaveValue('7');

    // Run it.
    await page.getByTestId('triangulation-run-button').click();

    // Wait for the mesh row to appear (Poisson on 60 pts at depth 7 takes a
    // few seconds at most against the local backend).
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });

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
  } finally {
    await close();
  }
});
