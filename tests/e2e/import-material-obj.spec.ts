import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';

// An OBJ whose materials are solid MTL `Kd` colors (no textures, no UVs) must
// import with those colors baked into per-vertex colors — not render flat. This
// pins the riegl_vz.obj regression where a multi-material untextured OBJ came
// in flat blue because the import fell back to the local parser (which ignores
// the MTL). It must now route through the backend, which reads Kd.
//
// It also pins the default opacity: a file-imported mesh defaults to 100%
// (there's no underlying point cloud to see through), unlike an in-app
// triangulation which stays translucent.
//
// Per CLAUDE.md Testing rules: live backend, drive the real dropzone, assert on
// concrete output (vertex-color flag, zero textured materials, opacity), no
// mocking.
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'two-material.obj');

test('imports a multi-material untextured OBJ with per-vertex colors at 100% opacity', async () => {
  const { app, page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // Auto-detect import (OBJ → mesh) through the real OS file chooser.
    await importFiles(app, page, 'import-auto', FIXTURE);

    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 30_000 });

    // Two triangles, auto-named after the file's base name.
    await expect(meshRow).toHaveAttribute('data-triangle-count', '2');
    await expect(meshRow).toHaveAttribute('data-mesh-name', 'two-material');

    // No textures in this OBJ — it must NOT be treated as a textured mesh...
    await expect(meshRow).toHaveAttribute('data-textured-materials', '0');
    // ...and the MTL Kd colors must have come through as per-vertex colors
    // (this is the regression: previously false → flat single color).
    await expect(meshRow).toHaveAttribute('data-has-vertex-colors', 'true');

    // File-imported meshes default to fully opaque.
    await expect(meshRow).toHaveAttribute('data-opacity', '1');

    await expect(page.getByTestId('empty-viewer-hint')).toHaveCount(0);
  } finally {
    await close();
  }
});
