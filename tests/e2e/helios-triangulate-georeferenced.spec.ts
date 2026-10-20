import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubSaveDialog } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// A Helios triangulation of a GEOREFERENCED cloud must be the same mesh as the
// cloud's local-coordinate twin, and must sit where the cloud is.
//
// Float32 resolves only 0.5 m at a UTM northing of ~4.2e6 m. The triangulation
// used to hand Helios world coordinates and keep the returned mesh in world
// coordinates too, so a georeferenced scan was snapped onto that lattice before
// the Delaunay ran (the leaf cube collapsed to a handful of triangles) and the
// mesh drawn and reused for LAD was the lattice. Now Helios runs in the cloud's
// stored frame, the mesh is kept there (MeshEntry.vertexOffset), and export
// adds the offset back in double precision.
//
// The twin is generated here from the committed leaf-cube fixture: every
// coordinate (scan origin included) moved by SHIFT. Same scan, same points.
const SRC_DIR = join(repoRoot, 'tests', 'e2e', 'fixtures', 'lad-leafcube');
const SHIFT = [512_345, 4_271_234, 87];

let session: LaunchedApp;
let workDir: string;

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'helios-georef-'));
  const rows = readFileSync(join(SRC_DIR, 'leafcube.xyz'), 'utf8').split('\n').filter(l => l.trim());
  writeFileSync(join(workDir, 'leafcube_utm.xyz'), rows.map((l) => {
    const t = l.trim().split(/\s+/);
    const [x, y, z] = t.slice(0, 3).map(Number);
    return [(x + SHIFT[0]).toFixed(6), (y + SHIFT[1]).toFixed(6), (z + SHIFT[2]).toFixed(6), ...t.slice(3)].join(' ');
  }).join('\n') + '\n');
  writeFileSync(join(workDir, 'leafcube_utm.xml'), `<?xml version="1.0"?>
<helios>
<scan>
  <filename> leafcube_utm.xyz </filename>
  <ASCII_format> x y z is_miss </ASCII_format>
  <origin> ${-5 + SHIFT[0]} ${SHIFT[1]} ${0.5 + SHIFT[2]} </origin>
  <size> 2600 5200 </size>
</scan>
</helios>
`);
  session = await launchApp();
});

test.afterAll(async () => {
  await session?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// Import one XML scan and run a Helios triangulation on it (auto grid);
// returns the triangle count the Meshes panel reports.
async function importAndTriangulate(xml: string): Promise<number> {
  const { app, page } = session;
  await stubOpenDialog(app, xml);
  await page.getByTestId('tool-add-scan').click();
  const popup = page.getByTestId('scan-parameters-popup');
  await expect(popup).toBeVisible();
  await page.getByTestId('scan-import-xml').click();
  await expect(popup).not.toBeVisible({ timeout: 20_000 });
  await completeImportWizard(page);

  const scanRow = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
  await expect(scanRow).toHaveCount(1, { timeout: 20_000 });
  await expect(scanRow).toHaveAttribute('data-has-data', 'true');
  await scanRow.getByTestId('scan-row-name').click();

  await page.getByTestId('tool-triangulate').click();
  const triModal = page.getByTestId('triangulation-popup');
  await expect(triModal).toBeVisible();
  await expect(triModal.getByTestId('triangulation-method')).toHaveValue('helios');
  await triModal.getByTestId('triangulation-run-button').click();

  const meshRow = page.getByTestId('mesh-row').filter({ hasText: 'Helios triangulation' });
  await expect(meshRow).toBeVisible({ timeout: 120_000 });
  return parseInt((await meshRow.getAttribute('data-triangle-count'))!, 10);
}

test('a georeferenced scan triangulates to the same mesh, exported at its world position', async () => {
  const { app, page } = session;

  const local = await importAndTriangulate(join(SRC_DIR, 'leafcube.xml'));
  expect(local).toBeGreaterThan(1000);

  await resetToFreshScene(app, page);
  const georef = await importAndTriangulate(join(workDir, 'leafcube_utm.xml'));
  // The same points in a different frame: the same mesh, to within the few
  // near-degenerate Delaunay choices that float32 rounding flips. (The importer
  // picks its own shift, floor(min), so the twin's stored coordinates are not
  // the original's and round differently; measured 3,119 vs 3,112.) Before the
  // fix the georeferenced cloud collapsed on the 0.5 m float32 lattice: 4
  // triangles where the backend test's woodcube has 3,651.
  expect(Math.abs(georef - local)).toBeLessThanOrEqual(0.01 * local);

  // Export it and read the coordinates back off disk.
  const meshRow = page.getByTestId('mesh-row').filter({ hasText: 'Helios triangulation' });
  await meshRow.click();
  await expect(meshRow).toHaveAttribute('data-selected', 'true');
  const objPath = join(workDir, 'georef.obj');
  await stubSaveDialog(app, objPath);
  await page.evaluate(() => (window as any).__openExportPanel?.());
  await expect(page.getByTestId('export-modal')).toBeVisible();
  await page.getByTestId('export-mesh-obj').click();
  await expect(page.getByTestId('toast-title').filter({ hasText: 'Export Complete' }))
    .toBeVisible({ timeout: 20_000 });

  const verts = readFileSync(objPath, 'utf8').split('\n')
    .filter(l => l.startsWith('v '))
    .map(l => l.slice(2).trim().split(/\s+/).map(Number));
  expect(verts.length).toBeGreaterThan(500);
  // In WORLD coordinates, on the cube: the 1x1x1 m box centered on (0,0,0.5)
  // before the shift. A mesh left in the stored frame would sit near zero.
  for (const [x, y, z] of verts) {
    expect(Math.abs(x - SHIFT[0])).toBeLessThan(0.6);
    expect(Math.abs(y - SHIFT[1])).toBeLessThan(0.6);
    expect(Math.abs(z - SHIFT[2] - 0.5)).toBeLessThan(0.6);
  }
  // Not on the float32 lattice: at this northing it allows 3 distinct y values
  // across the cube; the leaves give hundreds.
  const distinctY = new Set(verts.map(v => Math.round(v[1] * 1000)));
  expect(distinctY.size).toBeGreaterThan(200);
});
