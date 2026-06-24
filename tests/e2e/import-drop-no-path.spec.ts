import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { completeImportWizard } from './helpers/importWizard';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Regression: a point cloud DRAGGED onto the window could silently degrade to
// the in-renderer flat parser (no LOD octree) whenever its on-disk path didn't
// resolve via webUtils.getPathForFile — e.g. a cloud-storage placeholder, or
// any File that doesn't carry a real OS path. A flat 15M-point cloud then made
// downstream tools (crop, filter) unusably slow because their previews iterate
// every point on the CPU per render, where octree clouds clip on the GPU.
//
// The fix: when a dropped octree-eligible file has no resolvable path, the
// renderer persists its bytes to a private temp file (FsWriteTempBinary) and
// routes THAT through the same backend octree pipeline File → Import uses.
//
// This test reproduces the no-path case directly: a synthetic File created in
// the page has no OS path (webUtils.getPathForFile returns '' / throws), so the
// drop hits exactly the fallback the fix targets. The load-bearing assertion is
// data-octree="true" — before the fix this drop produced a flat cloud.
test('a dropped point cloud with no OS path still imports as octree-backed', async () => {
  const { app, page, close } = await launchApp();

  try {
    const xyz = readFileSync(TINY, 'utf-8');

    // Build a DataTransfer carrying a path-less File and drop it on the app
    // root (the react-dropzone surface). page-created Files have no native
    // path, which is the whole point — it forces the temp-file staging route.
    const dataTransfer = await page.evaluateHandle((content) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], 'dropped.xyz', { type: 'text/plain' }));
      return dt;
    }, xyz);

    const root = page.getByTestId('app-root');
    await root.waitFor({ state: 'attached' });
    await root.dispatchEvent('drop', { dataTransfer });

    // The fix routes this through the wizard (path-backed import), exactly like
    // File → Import. Before the fix there was no wizard — it parsed flat inline.
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="dropped.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });

    // tiny.xyz = 60 points (two comment/header lines skipped). The count coming
    // back from octree metadata proves the backend converter ran on the staged
    // temp file rather than the renderer's flat parser.
    expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);

    // Load-bearing: the dropped, path-less cloud must be OCTREE-backed. Before
    // the fix this drop fell to the flat parser → data-octree "false".
    await expect(row).toHaveAttribute('data-octree', 'true');

    await expect(page.locator('canvas').first()).toBeAttached();
  } finally {
    await close();
  }
});
