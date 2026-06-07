import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
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
  const { page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(E57);

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

    // Toggling it on must not error and must flip the control's state. The
    // overlay itself fetches /misses and renders 5 points; we assert the toggle
    // reflects "on" (its title switches to "Hide sky/miss points").
    await expect(missToggle).toHaveAttribute('title', 'Show sky/miss points');
    await missToggle.click();
    await expect(missToggle).toHaveAttribute('title', 'Hide sky/miss points');

    // And back off.
    await missToggle.click();
    await expect(missToggle).toHaveAttribute('title', 'Show sky/miss points');

    await expect(page.getByTestId('mesh-row')).toHaveCount(0);
  } finally {
    await close();
  }
});
