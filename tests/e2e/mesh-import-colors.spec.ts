import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';

// Meshes imported ONE AT A TIME must each get their own swatch color, the same
// as meshes imported together. The regression: the color allocator was seeded
// only from the scene's scans, so none of the meshes already present counted as
// "used" — every separate import restarted the palette and all of them came in
// blue. A multi-file import hid it, because one allocator spans the batch.
//
// Per CLAUDE.md Testing rules: live backend, real File→Import, assert on the
// color each row actually carries.
const QUAD = join(repoRoot, 'tests', 'e2e', 'fixtures', 'quad.obj');
const TWO_MATERIAL = join(repoRoot, 'tests', 'e2e', 'fixtures', 'two-material.obj');

test('sequentially imported meshes get distinct colors', async () => {
  const { app, page, close } = await launchApp();

  try {
    const rows = page.getByTestId('mesh-row');
    const fixtures = [QUAD, TWO_MATERIAL, QUAD];
    for (let i = 0; i < fixtures.length; i++) {
      await importFiles(app, page, 'import-mesh', fixtures[i]);
      await expect(rows).toHaveCount(i + 1, { timeout: 30_000 });
    }

    const colors = await rows.evaluateAll(els => els.map(e => e.getAttribute('data-mesh-color')));
    expect(colors.every(c => /^#[0-9a-f]{6}$/i.test(c ?? ''))).toBe(true);
    expect(new Set(colors).size).toBe(fixtures.length);
  } finally {
    await close();
  }
});
