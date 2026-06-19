import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// E57 is a structured scan format. Phytograph recovers sky/miss points from the
// grid's cartesianInvalidState flag and tags them is_miss=1. Those far-field
// (~20 km) points are kept in the backend session (for LAD) but EXCLUDED from
// the octree so they don't poison camera framing — so the scan row shows only
// the hit count, and a "Show misses" toggle reveals them on demand.
//
// The fixture (structured-scan.e57) is a 20-cell scan: 15 real returns + 5 sky
// misses (the top elevation row). Per CLAUDE.md: live backend, drive the real
// UI through the file chooser, assert on concrete output, no mocking.
const E57 = join(repoRoot, 'tests', 'e2e', 'fixtures', 'structured-scan.e57');

test('imports an E57, excludes misses from the octree, and toggles the miss overlay', async () => {
  const { app, page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await importFiles(app, page, 'import-auto', E57);

    // Path-backed import routes through the wizard; E57 columns are fixed, so
    // auto-detect assigns x/y/z and Import enables immediately.
    await completeImportWizard(page);

    const scanRow = page.getByTestId('scan-row').first();
    await expect(scanRow).toBeVisible({ timeout: 30_000 });
    // The octree holds the 15 HITS only — the 5 misses are not in it.
    await expect(scanRow).toHaveAttribute('data-point-count', '15');

    // The "Show misses" toggle is offered because the scan carries miss info.
    const scanId = await scanRow.getAttribute('data-scan-id');
    expect(scanId).toBeTruthy();
    const missToggle = page.getByTestId(`scan-toggle-misses-${scanId}`);
    await expect(missToggle).toBeVisible();

    // Toggling it on streams the projected-miss OCTREE (its own app://octree/
    // cache) into the scene. MissOctree registers the loaded cloud under
    // window.__missOctrees keyed by its cache id, so we assert the shell actually
    // loaded — not merely that the toggle flipped (a "didn't throw" non-test).
    await expect(missToggle).toHaveAttribute('title', 'Show sky/miss points');
    await missToggle.click();
    await expect(missToggle).toHaveAttribute('title', 'Hide sky/miss points');

    // The miss points are sky returns — they project ABOVE the hits (the import
    // frames the camera on the hit cloud, so the misses start outside the view
    // frustum and potree, correctly, streams no tiles for an off-screen octree).
    // A user reveals them the same way they would any out-of-frame geometry:
    // reframe. Snap to the top view (the viewport gizmo's Top button) so the
    // camera looks straight down +Z — hits and misses share an x/y footprint, so
    // both fall inside the frustum and the overlay streams. We assert against the
    // octree hook (set only once tiles are actually VISIBLE), so this still proves
    // the shell RENDERED, not merely that the metadata loaded.
    await page.getByRole('button', { name: 'Top View' }).click();

    // The octree loads + streams asynchronously; poll until the hook appears.
    await expect
      .poll(() => page.evaluate(() => {
        const reg = (window as unknown as { __missOctrees?: Record<string, boolean> }).__missOctrees;
        return reg ? Object.keys(reg).length : 0;
      }), { timeout: 15_000 })
      .toBeGreaterThan(0);

    // And back off — the shell unmounts and its hook entry is cleaned up.
    await missToggle.click();
    await expect(missToggle).toHaveAttribute('title', 'Show sky/miss points');
    await expect
      .poll(() => page.evaluate(() => {
        const reg = (window as unknown as { __missOctrees?: Record<string, boolean> }).__missOctrees;
        return reg ? Object.keys(reg).length : 0;
      }), { timeout: 15_000 })
      .toBe(0);

    await expect(page.getByTestId('mesh-row')).toHaveCount(0);
  } finally {
    await close();
  }
});
