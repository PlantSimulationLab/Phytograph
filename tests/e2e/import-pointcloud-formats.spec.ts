import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// Every supported point-cloud format imports through the UI as a streaming
// octree (not a flat in-renderer cloud). Before this, only the XYZ family
// went through the backend octree converter; PLY/PCD loaded flat via open3d
// and LAS/LAZ via the in-renderer parser / multipart upload. Now all formats
// route through convert_to_octree when dropped with a real disk path.
//
// Per CLAUDE.md Testing rules: live backend, drive the real UI via the file
// chooser, assert the concrete point count and octree-backing read from the
// rendered scan row. Each fixture is the same 60-point cylinder so the
// expected count is identical across formats.
const FIXTURES = join(repoRoot, 'tests', 'e2e', 'fixtures');

const CASES = [
  { file: 'tiny.ply', name: 'tiny.ply' },
  { file: 'tiny.pcd', name: 'tiny.pcd' },
  { file: 'tiny.las', name: 'tiny.las' },
  { file: 'tiny.laz', name: 'tiny.laz' },
];

for (const { file, name } of CASES) {
  test(`imports ${file} as an octree-backed cloud`, async () => {
    const { app, page, close } = await launchApp();
    try {
      await importFiles(app, page, 'import-point-cloud', [join(FIXTURES, file)]);
      await completeImportWizard(page);

      const row = page.locator(`[data-testid="scan-row"][data-scan-name="${name}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });

      // All four fixtures are the same 60-point cylinder.
      expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);
      // Load-bearing: the import went through the backend octree pipeline, not
      // a flat in-renderer parse.
      await expect(row).toHaveAttribute('data-octree', 'true');

      await expect(page.locator('canvas').first()).toBeAttached();
    } finally {
      await close();
    }
  });
}
