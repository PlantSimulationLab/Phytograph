import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubSaveDialog, getSaveDialogCalls } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';

// Terrain-following ("snapped") voxel grid round-trip through the Helios XML
// bundle, against the live backend.
//
// A snapped grid carries per-column z offsets (gridGroundSnap) that the Helios
// <grid> schema can't hold, so they used to be dropped silently on export and the
// grid re-imported flat. We now write a <columnOffsets> (+ <keptColumns>) tag and
// read it back, reattaching gridGroundSnap on import.
//
// This drives the FULL round trip through the real UI without the (expensive) DEM/
// LAD setup that produces a snap: snapped-grid.xml already carries a <grid> with
// <columnOffsets>, so importing it exercises the import-reattach path directly.
//   import snapped-grid.xml → assert the grid imports SNAPPED (Clear-snap control,
//   which renders iff gridGroundSnap is set, and needs no DEM in the scene) →
//   re-export the bundle → assert the written XML regained <columnOffsets>/<keptColumns>
//   → re-import the exported file → assert the grid is STILL snapped.
// The Clear-snap control is the queryable proof: it is present only when the grid
// mesh has gridGroundSnap.
async function importSnappedGrid(app: ElectronApplication, page: Page, xml: string) {
  await stubOpenDialog(app, xml);
  await page.getByTestId('tool-add-scan').click();
  const popup = page.getByTestId('scan-parameters-popup');
  await expect(popup).toBeVisible();
  await page.getByTestId('scan-import-xml').click();
  await expect(popup).not.toBeVisible({ timeout: 20_000 });
  await completeImportWizard(page);
}

// Open the grid mesh's options and assert it reads back as snapped.
async function expectGridSnapped(page: Page) {
  const gridRow = page.locator('[data-testid="mesh-row"]').filter({ hasText: 'Grid' }).first();
  await expect(gridRow).toBeVisible({ timeout: 20_000 });
  await gridRow.getByTestId('mesh-color-expand').click();
  // The Clear-snap control renders iff the grid mesh has gridGroundSnap — i.e. the
  // per-column offsets were reattached on import. No DEM is needed to show it.
  await expect(page.getByTestId('mesh-grid-snap-clear')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('mesh-grid-snap-section')).toContainText('Snapped to ground');
}

test('round-trips a terrain-following voxel grid through XML export and re-import', async () => {
  const fixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'snapped-grid.xml');
  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-gridsnap-'));
  const xmlPath = join(outDir, 'snapped.xml');

  // ── 1. Import the snapped-grid fixture; the grid must come back SNAPPED ──────
  const { app, page, close } = await launchApp();
  try {
    await stubSaveDialog(app, xmlPath);
    await importSnappedGrid(app, page, fixture);

    await expect(page.getByTestId('scans-panel').locator('[data-testid="scan-row"]'))
      .toHaveCount(1, { timeout: 20_000 });
    await expectGridSnapped(page);

    // ── 2. Re-export the bundle with the grid ticked ──────────────────────────
    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await expect(page.getByTestId('export-modal')).toBeVisible();
    await expect(page.getByTestId('export-scan-mode-xml')).toHaveAttribute('data-active', 'true');
    const gridToggle = page.getByTestId('export-grid-toggle');
    await expect(gridToggle).toBeVisible();
    await gridToggle.check();
    const gridRows = page.getByTestId('export-grid-row');
    await expect(gridRows).toHaveCount(1);
    await gridRows.first().getByRole('checkbox').check();
    await expect(gridRows.first()).toHaveAttribute('data-checked', 'true');

    await page.getByTestId('export-scan-xml').click();
    await expect.poll(async () => (await getSaveDialogCalls(app)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect.poll(() => existsSync(xmlPath), { timeout: 30_000, intervals: [200, 500, 1000] }).toBe(true);

    // The exported XML regained the per-column offsets and the dropped-column mask.
    const xml = readFileSync(xmlPath, 'utf-8');
    const grid = xml.match(/<grid>([\s\S]*?)<\/grid>/);
    expect(grid, xml).not.toBeNull();
    const body = grid![1];
    const offsets = body.match(/<columnOffsets>([^<]*)<\/columnOffsets>/);
    expect(offsets, body).not.toBeNull();
    const vals = offsets![1].trim().split(/\s+/).map(Number);
    expect(vals).toHaveLength(4); // nx*ny == 4
    expect(vals[0]).toBeCloseTo(0.0, 5);
    expect(vals[3]).toBeCloseTo(0.3, 5);
    // One column was dropped outside the footprint → keptColumns is written.
    expect(body).toMatch(/<keptColumns>\s*1\s+1\s+0\s+1\s*<\/keptColumns>/);
  } finally {
    await close();
  }

  // ── 3. Re-import the EXPORTED file into a fresh window: still snapped ────────
  const { app: app2, page: page2, close: close2 } = await launchApp();
  try {
    await importSnappedGrid(app2, page2, xmlPath);
    await expect(page2.getByTestId('scans-panel').locator('[data-testid="scan-row"]'))
      .toHaveCount(1, { timeout: 20_000 });
    // The grid Phytograph wrote itself re-imports snapped — the full write→read loop.
    await expectGridSnapped(page2);
  } finally {
    await close2();
  }
});
