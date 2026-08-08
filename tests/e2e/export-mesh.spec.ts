import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { stubSaveDialog, getSaveDialogCalls } from './helpers/stubSaveDialog';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Mesh export through the real Export dialog, asserted against the FILES ON
// DISK. The only thing stubbed is the native Save dialog (an OS-native window a
// test can't click), redirected to a tmp dir; the fs writes are the real IPC
// handlers, and the backend that builds the meshes is live.
//
// Two properties this covers that a blob-capture test could not:
//   1. The export writes only AFTER the user picks a destination — cancelling
//      the dialog must leave nothing behind and report nothing.
//   2. An OBJ export of a textured plant emits the whole bundle (.obj + .mtl +
//      texture images) and re-imports with its materials intact.

let session: LaunchedApp;
let outDir: string;

test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});
test.beforeEach(async () => {
  await resetToFreshScene(session.app, session.page);
  outDir = mkdtempSync(join(tmpdir(), 'mesh-export-'));
});
test.afterEach(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

// Import tiny.xyz and triangulate it, leaving the resulting mesh selected.
// Returns the triangle count the UI reports for the mesh.
async function buildAndSelectMesh(): Promise<number> {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-triangulate').click();
  const triModal = page.getByTestId('triangulation-popup');
  await expect(triModal).toBeVisible();
  await triModal.getByTestId('triangulation-method').selectOption('poisson');
  await triModal.getByTestId('triangulation-poisson-depth').fill('7');
  await triModal.getByTestId('triangulation-run-button').click();

  const meshRow = page.getByTestId('mesh-row').first();
  await expect(meshRow).toBeVisible({ timeout: 60_000 });
  const triangles = parseInt((await meshRow.getAttribute('data-triangle-count')) ?? '0', 10);
  expect(triangles).toBeGreaterThan(0);

  // Select the mesh so the export modal targets it.
  await meshRow.click();
  await expect(meshRow).toHaveAttribute('data-selected', 'true');
  await expect(cloudRow).toHaveAttribute('data-selected', 'false');
  return triangles;
}

// Export lives in File → Export; the native menu is disabled under E2E, so drive
// the same renderer entry point the menu uses.
async function openExportModal(): Promise<void> {
  await session.page.evaluate(() => (window as any).__openExportPanel?.());
  await expect(session.page.getByTestId('export-modal')).toBeVisible();
}

test('exports a triangulated mesh to OBJ at the path the user chose', async () => {
  const { app, page } = session;
  const expectedTriangles = await buildAndSelectMesh();

  const objPath = join(outDir, 'chosen_name.obj');
  await stubSaveDialog(app, objPath);

  await openExportModal();
  await page.getByTestId('export-mesh-obj').click();

  // The success toast must not appear before the file exists — the bug this
  // guards is a toast fired at click time, ahead of the Save dialog.
  await expect(page.getByTestId('toast-title').filter({ hasText: 'Export Complete' }))
    .toBeVisible({ timeout: 20_000 });
  expect(existsSync(objPath)).toBe(true);

  // The dialog was actually asked, and it offered an editable default rather
  // than naming the file behind the user's back.
  const calls = (await getSaveDialogCalls(app)) as { defaultPath?: string }[];
  expect(calls).toHaveLength(1);
  expect(calls[0].defaultPath).toMatch(/\.obj$/);

  // The bytes on disk describe the mesh the UI reported.
  const obj = readFileSync(objPath, 'utf8');
  expect(obj.startsWith('# Mesh exported from Phytograph')).toBe(true);
  const vertexLines = obj.split('\n').filter(l => l.startsWith('v '));
  const faceLines = obj.split('\n').filter(l => l.startsWith('f '));
  expect(vertexLines.length).toBeGreaterThan(0);
  expect(faceLines.length).toBe(expectedTriangles);

  for (const f of faceLines.slice(0, 10)) {
    const idxs = f.slice(2).trim().split(/\s+/).map(tok => parseInt(tok.split('/')[0], 10));
    expect(idxs).toHaveLength(3);
    for (const i of idxs) {
      expect(i).toBeGreaterThanOrEqual(1);
      expect(i).toBeLessThanOrEqual(vertexLines.length);
    }
  }

  // A Poisson mesh carries no materials, so no .mtl is written — the bundle is
  // exactly one file.
  expect(readdirSync(outDir).sort()).toEqual(['chosen_name.obj']);
});

test('writes nothing and reports nothing when the Save dialog is cancelled', async () => {
  const { app, page } = session;
  await buildAndSelectMesh();

  // A cancelled native Save dialog resolves to null.
  await app.evaluate(async ({ ipcMain }) => {
    const g = globalThis as unknown as { __saveDialogCalls?: unknown[] };
    g.__saveDialogCalls = [];
    ipcMain.removeHandler('dialog:save');
    ipcMain.handle('dialog:save', async (_e, opts) => {
      g.__saveDialogCalls!.push(opts);
      return null;
    });
  });

  await openExportModal();
  await page.getByTestId('export-mesh-obj').click();

  // The dialog fired…
  await expect
    .poll(async () => (await getSaveDialogCalls(app)).length, { timeout: 10_000 })
    .toBe(1);
  // …and nothing followed it: no file, and no success toast claiming otherwise.
  expect(readdirSync(outDir)).toEqual([]);
  await expect(page.getByTestId('toast-title').filter({ hasText: 'Export Complete' }))
    .toHaveCount(0);
  // The export modal stays open so the user can retry.
  await expect(page.getByTestId('export-modal')).toBeVisible();
});

test('exports PLY and STL to the chosen path', async () => {
  const { app, page } = session;
  const expectedTriangles = await buildAndSelectMesh();

  const plyPath = join(outDir, 'surface.ply');
  await stubSaveDialog(app, plyPath);
  await openExportModal();
  await page.getByTestId('export-mesh-ply').click();
  await expect(page.getByTestId('toast-title').filter({ hasText: 'Export Complete' }))
    .toBeVisible({ timeout: 20_000 });

  const ply = readFileSync(plyPath, 'utf8');
  expect(ply.startsWith('ply\n')).toBe(true);
  expect(ply).toContain(`element face ${expectedTriangles}`);

  const stlPath = join(outDir, 'surface.stl');
  await stubSaveDialog(app, stlPath);
  await openExportModal();
  await page.getByTestId('export-mesh-stl').click();
  await expect.poll(() => existsSync(stlPath), { timeout: 20_000 }).toBe(true);

  const stl = readFileSync(stlPath, 'utf8');
  expect(stl.startsWith('solid mesh')).toBe(true);
  expect(stl.split('\n').filter(l => l.trim().startsWith('facet normal')).length)
    .toBe(expectedTriangles);
});

test('exports a textured plant as an OBJ + MTL + textures bundle that re-imports', async () => {
  const { app, page } = session;

  // ── Generate a real plant (pyhelios), which carries textured materials ──
  await page.getByTestId('tool-plant-generate').click();
  const plantPopup = page.getByTestId('plant-generation-popup');
  await expect(plantPopup).toBeVisible();
  const species = page.getByTestId('plant-species-select');
  await expect(species.locator('option')).not.toHaveCount(0);
  await species.selectOption('bean');
  await page.getByTestId('plant-age-input').fill('20');
  await page.getByTestId('plant-generate-button').click();

  const meshRow = page.getByTestId('mesh-row').first();
  await expect(meshRow).toBeVisible({ timeout: 120_000 });
  await expect(meshRow).toHaveAttribute('data-is-plant', 'true');
  const plantTriangles = parseInt((await meshRow.getAttribute('data-triangle-count')) ?? '0', 10);
  expect(plantTriangles).toBeGreaterThan(0);
  // The plant must actually carry textured materials, or this test proves
  // nothing about exporting them.
  const texturedCount = parseInt((await meshRow.getAttribute('data-textured-materials')) ?? '0', 10);
  expect(texturedCount).toBeGreaterThan(0);

  // A freshly generated plant is auto-selected — clicking would toggle it OFF.
  await expect(meshRow).toHaveAttribute('data-selected', 'true');

  const objPath = join(outDir, 'bean_plant.obj');
  await stubSaveDialog(app, objPath);
  await openExportModal();
  await page.getByTestId('export-mesh-obj').click();
  await expect(page.getByTestId('toast-title').filter({ hasText: 'Export Complete' }))
    .toBeVisible({ timeout: 30_000 });

  // ── The bundle: geometry + material library + the images it names ──
  const written = readdirSync(outDir);
  expect(written).toContain('bean_plant.obj');
  expect(written).toContain('bean_plant.mtl');

  const obj = readFileSync(objPath, 'utf8');
  expect(obj).toContain('mtllib bean_plant.mtl');
  expect(obj).toContain('# Helios Plant: bean');
  expect(obj.split('\n').filter(l => l.startsWith('f ')).length).toBe(plantTriangles);
  // Textured geometry means real UVs travel with it.
  expect(obj.split('\n').filter(l => l.startsWith('vt ')).length).toBeGreaterThan(0);

  const mtl = readFileSync(join(outDir, 'bean_plant.mtl'), 'utf8');
  const declared = mtl.split('\n').filter(l => l.startsWith('newmtl ')).map(l => l.slice(7).trim());
  expect(declared.length).toBeGreaterThan(0);

  // Every material the OBJ uses is declared in the MTL — an OBJ naming a
  // material its library lacks is exactly the broken round-trip we're fixing.
  const used = [...new Set(obj.split('\n').filter(l => l.startsWith('usemtl ')).map(l => l.slice(7).trim()))];
  expect(used.length).toBeGreaterThan(0);
  for (const name of used) expect(declared).toContain(name);

  // Every image the MTL points at was actually written, and its bytes really are
  // the format its extension claims (a JPEG named .png fails to load downstream).
  const maps = [...new Set(
    mtl.split('\n').filter(l => l.startsWith('map_Kd ')).map(l => l.slice(7).trim()),
  )];
  expect(maps.length).toBeGreaterThan(0);
  for (const img of maps) {
    const imgPath = join(outDir, img);
    expect(existsSync(imgPath)).toBe(true);
    const bytes = readFileSync(imgPath);
    expect(bytes.length).toBeGreaterThan(0);
    if (img.toLowerCase().endsWith('.png')) {
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    } else {
      expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    }
  }

  // Untextured organs (petioles, internodes, stems) are the majority of a bean's
  // triangles and carry NO texture — the backend leaves them out of the material
  // groups because they render from vertex colours. They must still get a real
  // `Kd`, or they come back flat grey: the reported round-trip bug.
  const kds = mtl.split('\n')
    .filter(l => l.startsWith('Kd '))
    .map(l => l.slice(3).trim().split(/\s+/).map(Number));
  const untexturedKds = kds.filter(c => c.some(v => v !== 0.8));
  expect(untexturedKds.length).toBeGreaterThan(0);
  // Plant organ colours are dark olive/green/brown — decisively not the 0.8 grey
  // fallback, and not white.
  for (const [r, g, b] of untexturedKds) {
    expect(Math.max(r, g, b)).toBeLessThan(0.95);
  }
  // At least one organ colour is green-dominant (petioles/internodes/stems).
  expect(untexturedKds.some(([r, g, b]) => g > r && g > b)).toBe(true);
  // Every triangle is accounted for by a real material — nothing fell through to
  // the grey default.
  expect(obj).not.toContain('usemtl default');

  // A generated plant also writes its Helios structure XML beside the mesh.
  expect(written).toContain('bean_plant_helios.xml');

  // ── Round-trip: re-import the exported OBJ and get the materials back ──
  await resetToFreshScene(session.app, session.page);
  await importFiles(app, page, 'import-mesh', objPath);

  const importedRow = page.getByTestId('mesh-row').first();
  await expect(importedRow).toBeVisible({ timeout: 60_000 });
  // Same geometry came back.
  expect(parseInt((await importedRow.getAttribute('data-triangle-count')) ?? '0', 10))
    .toBe(plantTriangles);
  // …and the backend importer resolved the sibling MTL + the images it names, so
  // the re-imported mesh carries textured materials again. Before this fix no
  // .mtl was written at all and this came back 0.
  await expect
    .poll(async () => parseInt((await importedRow.getAttribute('data-textured-materials')) ?? '0', 10),
      { timeout: 30_000 })
    .toBeGreaterThan(0);

  // The untextured organs came back with COLOUR, not grey. The importer rebuilds
  // per-vertex colour from each triangle's material Kd, so this is the end of the
  // chain the user actually sees: petioles and internodes the right colour.
  await expect(importedRow).toHaveAttribute('data-has-vertex-colors', 'true');
  const palette = await page.evaluate(() => {
    const mesh = (window as any).__meshVertexColorPalette?.();
    return mesh ?? null;
  });
  expect(palette, '__meshVertexColorPalette hook missing').not.toBeNull();
  // Grey (0.8,0.8,0.8) was what every untextured organ collapsed to before the
  // fix. A correct round-trip has none of it, and does have green organ colour.
  const greyShare = palette.filter(
    ([r, g, b]: number[]) => Math.abs(r - 0.8) < 0.02 && Math.abs(g - 0.8) < 0.02 && Math.abs(b - 0.8) < 0.02,
  ).length / palette.length;
  expect(greyShare).toBeLessThan(0.05);
  expect(palette.some(([r, g, b]: number[]) => g > r && g > b)).toBe(true);
});
