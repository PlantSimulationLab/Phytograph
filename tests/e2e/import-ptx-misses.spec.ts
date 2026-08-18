import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// PTX is a COMPLETE rectangular raster: every beam gets a line, and a beam that
// returned nothing is written with all-zero coordinates. Unlike E57 it stores no
// per-cell angles, so each miss's beam direction is measured back off the scan
// grid itself (zenith per row, azimuth per column — exact, because PTX
// coordinates are in the scanner's own frame). Those far-field (~20 km) points
// are kept in the backend session for LAD but EXCLUDED from the octree, so the
// scan row shows only the hit count and a "Show misses" toggle reveals them.
//
// The fixture (structured-scan.ptx) is a 12 x 8 grid: 72 real returns plus 24
// sky misses (the top two zenith rows). Per CLAUDE.md: live backend, drive the
// real UI through the file chooser, assert on concrete output, no mocking.
const PTX = join(repoRoot, 'tests', 'e2e', 'fixtures', 'structured-scan.ptx');

test('imports a PTX, recovers its sky/miss points, and toggles the overlay', async () => {
  const { app, page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await importFiles(app, page, 'import-auto', PTX);

    // Path-backed import routes through the wizard. PTX defines its own column
    // layout, so the roles are read-only — but the rows themselves are plain
    // ASCII behind a fixed header, so the preview DOES show real values. That is
    // how a user checks the column count and the intensity/colour scales before
    // committing, and it costs ~2 ms even on a multi-GB file.
    await expect(page.getByTestId('import-wizard-preview-row').first())
      .toBeVisible({ timeout: 20_000 });
    const cells = await page.getByTestId('import-wizard-preview-row').first()
      .locator('td').allTextContents();
    expect(cells).toHaveLength(7);                       // x y z intensity r g b
    expect(cells.slice(0, 3).some(v => parseFloat(v) !== 0)).toBe(true);  // a real return
    await completeImportWizard(page);

    const scanRow = page.getByTestId('scan-row').first();
    await expect(scanRow).toBeVisible({ timeout: 30_000 });
    // The octree holds the 72 HITS only — the 24 recovered misses are not in it.
    await expect(scanRow).toHaveAttribute('data-point-count', '72');

    // The scan carries miss info, so the toggle is offered.
    const scanId = await scanRow.getAttribute('data-scan-id');
    expect(scanId).toBeTruthy();
    const missToggle = page.getByTestId(`scan-toggle-misses-${scanId}`);
    await expect(missToggle).toBeVisible();
    await expect(missToggle).toHaveAttribute('title', 'Show sky/miss points');

    // Reveal them: reframe to the top view first so the projected shell falls
    // inside the frustum (potree streams nothing for an off-screen octree), then
    // assert against the octree hook, which is set only once tiles are actually
    // VISIBLE — proving the shell rendered, not merely that metadata loaded.
    await missToggle.click();
    await expect(missToggle).toHaveAttribute('title', 'Hide sky/miss points');
    await page.getByRole('button', { name: 'Top View' }).click();
    await expect
      .poll(() => page.evaluate(() => {
        const reg = (window as unknown as { __missOctrees?: Record<string, boolean> }).__missOctrees;
        return reg ? Object.keys(reg).length : 0;
      }), { timeout: 15_000 })
      .toBeGreaterThan(0);

    await missToggle.click();
    await expect(missToggle).toHaveAttribute('title', 'Show sky/miss points');

    // PTX also carries the scanner pose and grid resolution, so the import
    // auto-fills the scan parameters. Nothing else here supplies them — there is
    // no XML and the user entered nothing — so a populated grid can only have
    // come out of the PTX header.
    await page.getByTestId(`scan-edit-${scanId}`).click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await expect(page.getByTestId('scan-zenith-points')).toHaveValue('8');
    await expect(page.getByTestId('scan-azimuth-points')).toHaveValue('12');
    // And the registered scanner position from the transform's last row.
    await expect(page.getByTestId('scan-origin-x')).toHaveValue('2');
    await expect(page.getByTestId('scan-origin-y')).toHaveValue('-1');
    await expect(page.getByTestId('scan-origin-z')).toHaveValue('1.5');

    await expect(page.getByTestId('mesh-row')).toHaveCount(0);
  } finally {
    await close();
  }
});
