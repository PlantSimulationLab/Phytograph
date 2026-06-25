import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { stubSaveDialog, getSaveDialogCalls } from './helpers/stubSaveDialog';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'ground_plants.xyz');

// ground_plants.xyz: a flat 40×40 ground grid (1600 pts at z≈0) plus a raised
// plant blob (600 pts, z 0.12–0.8). Drives the real DOM against the live
// backend: import (→ octree) → segment ground → Generate DEM (ground-aware, with
// height-above-ground) → assert a DEM surface mesh appears, then export the
// underlying grid as an ESRI ASCII grid and a GeoTIFF and assert the real bytes.
test('generates a DEM from ground points and exports raster grids', async () => {
  const { app, page, close } = await launchApp();
  const ascPath = join(tmpdir(), `phytograph_dem_e2e_${Date.now()}.asc`);
  const tifPath = join(tmpdir(), `phytograph_dem_e2e_${Date.now()}.tif`);
  for (const p of [ascPath, tifPath]) if (existsSync(p)) rmSync(p);

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="ground_plants.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // 1) Segment ground first so the cloud carries a ground_class column — the
    //    DEM tool is ground-aware and will grid only the ground points.
    await page.getByTestId('tool-ground-segment').click();
    await page.getByTestId('ground-cloth-resolution').fill('0.1');
    await page.getByTestId('ground-class-threshold').fill('0.05');
    await page.getByTestId('ground-segment-run-button').click();
    await expect(page.getByTestId('class-legend')).toBeVisible({ timeout: 60_000 });

    // 2) Generate the DEM. The cloud has a ground class, so NO "no ground" warning.
    await page.getByTestId('tool-dem').click();
    const panel = page.getByTestId('dem-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('dem-no-ground-warning')).toHaveCount(0);
    // The panel shows a live grid-size estimate derived from the cloud's extent
    // and the cell size (nx × ny cells).
    const estimate = page.getByTestId('dem-grid-estimate');
    await expect(estimate).toBeVisible();
    await expect(estimate).toContainText(/Estimated grid: [\d,]+ × [\d,]+ cells/);
    await page.getByTestId('dem-cell-size').fill('0.5');
    await page.getByTestId('dem-compute-hag').check();   // exercise the CHM + octree-rebuild path
    await page.getByTestId('dem-run-button').click();

    // 3) A DEM surface mesh appears, named "<cloud> DEM", with real triangles.
    const demRow = page.locator('[data-testid="mesh-row"][data-mesh-name="ground_plants.xyz DEM"]');
    await expect(demRow).toBeVisible({ timeout: 60_000 });
    const tris = parseInt((await demRow.getAttribute('data-triangle-count')) ?? '0', 10);
    expect(tris).toBeGreaterThan(0);

    // 4) The DEM surface mesh offers raster export right in its Meshes-panel row
    //    (no plant-only "Leaf angles…" button — that's hidden for a DEM). The
    //    expandable options render as a sibling of the row header, so the buttons
    //    are page-level (there is only one DEM mesh).
    await demRow.getByTestId('mesh-color-expand').click();
    await expect(page.getByTestId('mesh-dem-export-tif')).toBeVisible();
    await expect(page.getByTestId('mesh-dem-export-asc')).toBeVisible();
    await expect(page.getByTestId('mesh-leaf-angles')).toHaveCount(0);

    // 5a) Export ESRI ASCII grid → assert the real header + grid shape on disk.
    await stubSaveDialog(app, ascPath);
    await page.getByTestId('mesh-dem-export-asc').click();
    await expect.poll(async () => (await getSaveDialogCalls(app)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    // Poll on file CONTENT, not mere existence: fs.writeBinary creates the file
    // before the bytes flush, so existsSync can be true while the read is empty.
    let asc = '';
    await expect.poll(
      () => { asc = existsSync(ascPath) ? readFileSync(ascPath, 'utf-8') : ''; return asc.split('\n')[0]; },
      { timeout: 15_000 },
    ).toMatch(/^ncols \d+$/);

    const lines = asc.split('\n');
    expect(lines[0]).toMatch(/^ncols \d+$/);
    expect(lines[1]).toMatch(/^nrows \d+$/);
    const ncols = parseInt(lines[0].split(' ')[1], 10);
    const nrows = parseInt(lines[1].split(' ')[1], 10);
    expect(ncols).toBeGreaterThan(0);
    expect(nrows).toBeGreaterThan(0);
    expect(lines[2]).toMatch(/^xllcorner /);
    expect(lines[4]).toMatch(/^cellsize 0\.5/);
    // Data rows follow the 6-line header; first row has ncols values.
    const dataRows = lines.slice(6).filter((l) => l.trim().length > 0);
    expect(dataRows.length).toBe(nrows);
    expect(dataRows[0].trim().split(/\s+/).length).toBe(ncols);
    // The ground plane sits at z≈0, so finite cells are near 0 (not the plant top).
    const finiteVals = dataRows
      .flatMap((r) => r.trim().split(/\s+/).map(Number))
      .filter((v) => v !== -9999 && Number.isFinite(v));
    expect(finiteVals.length).toBeGreaterThan(0);
    expect(Math.max(...finiteVals)).toBeLessThan(0.5);

    // 5b) Export GeoTIFF → assert a real TIFF on disk (little-endian magic II*\0).
    await stubSaveDialog(app, tifPath);
    await page.getByTestId('mesh-dem-export-tif').click();
    // Poll on file size (bytes flushed), not mere existence.
    await expect.poll(
      () => (existsSync(tifPath) ? readFileSync(tifPath).length : 0),
      { timeout: 15_000 },
    ).toBeGreaterThan(100);
    const tif = readFileSync(tifPath);
    // TIFF byte-order magic: 'II' + 42 (little-endian) or 'MM' + 42 (big-endian).
    const magic = tif.subarray(0, 4);
    const isII = magic[0] === 0x49 && magic[1] === 0x49 && magic[2] === 0x2a && magic[3] === 0x00;
    const isMM = magic[0] === 0x4d && magic[1] === 0x4d && magic[2] === 0x00 && magic[3] === 0x2a;
    expect(isII || isMM).toBe(true);
  } finally {
    for (const p of [ascPath, tifPath]) if (existsSync(p)) rmSync(p);
    await close();
  }
});
