import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';

// A textured OBJ (with its sibling MTL + PNG) imported through the real
// dropzone must route through the backend's /api/mesh/import endpoint and come
// back as a textured mesh — i.e. the mesh row reports textured materials.
//
// Per CLAUDE.md Testing rules: live backend, drive the UI, assert on concrete
// output (textured-material count + triangle count), no mocking.
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'quad.obj');

test('imports a textured OBJ+MTL and renders it textured', async () => {
  const { page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // Auto-detect import (OBJ → mesh). The handler opens a real OS file
    // chooser, so intercept it before clicking.
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(FIXTURE);

    // The textured quad becomes a mesh row.
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 30_000 });

    // Two triangles in the fixture.
    await expect(meshRow).toHaveAttribute('data-triangle-count', '2');

    // Auto-named after the imported file's base name (quad.obj → quad).
    await expect(meshRow).toHaveAttribute('data-mesh-name', 'quad');

    // The backend resolved the MTL + PNG, so the mesh must carry exactly one
    // textured material into the renderer.
    const texturedStr = await meshRow.getAttribute('data-textured-materials');
    expect(texturedStr).not.toBeNull();
    expect(parseInt(texturedStr!, 10)).toBe(1);

    // Viewer is no longer empty.
    await expect(page.getByTestId('empty-viewer-hint')).toHaveCount(0);
  } finally {
    await close();
  }
});
