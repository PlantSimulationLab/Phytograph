import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { stubSaveDialog } from './helpers/stubSaveDialog';

// Stitch → Meshes: merging mesh objects into one, end-to-end.
//
// Fixtures:
//   cube-mesh.ply     — unit cube at the origin, 8 vertices / 12 triangles,
//                       per-vertex RGB (vertex 0 is pure red).
//   big-cube-mesh.ply — 10 m cube spanning 20..30 on every axis, 8 vertices /
//                       12 triangles, NO vertex colors.
//   overlap-sheet-a/b.ply — two flat sheets on one unit grid, 45 vertices /
//                       64 triangles each: A spans x 0..8 in gray 200, B spans
//                       x 4..12 in gray 100. They are the SAME surface over
//                       x 4..8, lit differently — two scans from two angles.
//
// The pair is chosen so the merge has to reconcile attributes: one mesh has
// vertex colors and the other only a solid display color. The result is
// asserted from the exported PLY on disk (the only thing stubbed is the native
// Save dialog), so it checks the geometry the merge produced, not the row.
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).
const CUBE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'cube-mesh.ply');
const BIG_CUBE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'big-cube-mesh.ply');
const SHEET_A = join(repoRoot, 'tests', 'e2e', 'fixtures', 'overlap-sheet-a.ply');
const SHEET_B = join(repoRoot, 'tests', 'e2e', 'fixtures', 'overlap-sheet-b.ply');
const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

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
  outDir = mkdtempSync(join(tmpdir(), 'mesh-merge-'));
});
test.afterEach(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const meshRows = () => session.page.getByTestId('mesh-row');
const row = (name: string) => session.page.locator(`[data-testid="mesh-row"][data-mesh-name="${name}"]`);
const mergedRow = () => session.page.locator('[data-testid="mesh-row"][data-mesh-name$="_merged"]');

async function importCubes() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', [CUBE, BIG_CUBE]);
  await expect(meshRows()).toHaveCount(2, { timeout: 30_000 });
  await expect(row('cube-mesh')).toHaveAttribute('data-triangle-count', '12');
  await expect(row('big-cube-mesh')).toHaveAttribute('data-triangle-count', '12');
  return page;
}

// Open Stitch on its Meshes side and tick every mergeable mesh.
async function openMeshMerge() {
  const { page } = session;
  await page.getByTestId('tool-cloud-stitch').click();
  const dialog = page.getByTestId('stitch-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('stitch-mode-meshes').click();
  const picker = dialog.getByTestId('stitch-mesh-picker');
  await expect(picker).toBeVisible();
  for (const r of await picker.locator('[data-testid="picker-row"][data-disabled="false"]').all()) {
    await r.locator('input').check();
  }
  return { dialog, picker };
}

interface PlyVertex { x: number; y: number; z: number; red?: number; green?: number; blue?: number }

// Export the selected mesh as PLY and parse its vertices by header property
// name, so the read does not depend on which optional columns were written.
async function exportSelectedPly(name: string): Promise<{ vertices: PlyVertex[]; faces: number }> {
  const { app, page } = session;
  const path = join(outDir, name);
  await stubSaveDialog(app, path);
  await page.evaluate(() => (window as any).__openExportPanel?.());
  await expect(page.getByTestId('export-modal')).toBeVisible();
  await page.getByTestId('export-mesh-ply').click();
  await expect.poll(() => existsSync(path), { timeout: 20_000 }).toBe(true);

  const lines = readFileSync(path, 'utf8').split('\n');
  const end = lines.indexOf('end_header');
  const header = lines.slice(0, end);
  const count = Number(header.find(l => l.startsWith('element vertex'))!.split(' ')[2]);
  const faces = Number(header.find(l => l.startsWith('element face'))!.split(' ')[2]);
  const faceAt = header.findIndex(l => l.startsWith('element face'));
  const props = header.slice(0, faceAt).filter(l => l.startsWith('property ')).map(l => l.trim().split(' ').pop()!);
  const vertices = lines.slice(end + 1, end + 1 + count).map(l => {
    const cols = l.trim().split(/\s+/).map(Number);
    return Object.fromEntries(props.map((p, i) => [p, cols[i]])) as unknown as PlyVertex;
  });
  return { vertices, faces };
}

test('merges two meshes into one, where they are drawn, reconciling vertex colors', async () => {
  const page = await importCubes();

  // Move the unit cube +5 in X first. It is the FIRST source, so the merged
  // mesh takes its position as its own — the case where baking the vertices
  // and placing the result could disagree.
  await row('cube-mesh').getByTestId('mesh-transform-toggle').click();
  const posX = page.getByTestId('mesh-pos-x');
  await posX.fill('5');
  await posX.press('Enter');
  await expect.poll(async () => Number((await row('cube-mesh').getAttribute('data-mesh-position'))?.split(',')[0]))
    .toBeCloseTo(5, 2);

  // The big cube's solid display color, which the merge must paint it with.
  const bigHex = (await row('big-cube-mesh').getAttribute('data-mesh-color'))!;
  expect(bigHex).toMatch(/^#[0-9a-f]{6}$/i);
  const bigRgb = [1, 3, 5].map(i => parseInt(bigHex.slice(i, i + 2), 16));

  const { dialog } = await openMeshMerge();
  await expect(dialog.getByText('2 meshes selected')).toBeVisible();
  await dialog.getByTestId('stitch-run').click();
  await expect(dialog).toHaveCount(0);

  // One mesh left: the sources are gone and the merge holds every triangle.
  await expect(meshRows()).toHaveCount(1, { timeout: 15_000 });
  await expect(mergedRow()).toHaveAttribute('data-mesh-name', 'cube-mesh_big-cube-mesh_merged');
  await expect(mergedRow()).toHaveAttribute('data-triangle-count', '24');
  await expect(mergedRow()).toHaveAttribute('data-selected', 'true');
  await expect(mergedRow()).toHaveAttribute('data-visible', 'true');

  const { vertices, faces } = await exportSelectedPly('merged.ply');
  expect(faces).toBe(24);
  expect(vertices).toHaveLength(16);

  // The unit cube landed at x 5..6 (moved), the big cube stayed at 20..30.
  const small = vertices.slice(0, 8), big = vertices.slice(8);
  expect(Math.min(...small.map(v => v.x))).toBeCloseTo(5, 4);
  expect(Math.max(...small.map(v => v.x))).toBeCloseTo(6, 4);
  expect(Math.min(...small.map(v => v.y))).toBeCloseTo(0, 4);
  expect(Math.max(...small.map(v => v.z))).toBeCloseTo(1, 4);
  for (const axis of ['x', 'y', 'z'] as const) {
    expect(Math.min(...big.map(v => v[axis]))).toBeCloseTo(20, 4);
    expect(Math.max(...big.map(v => v[axis]))).toBeCloseTo(30, 4);
  }

  // Colors: the unit cube keeps its own per-vertex colors (vertex 0 is red,
  // vertex 7 is the fixture's 64-gray), and the uncolored big cube is filled
  // with ONE color — its solid display color — rather than left undefined.
  expect([small[0].red, small[0].green, small[0].blue]).toEqual([255, 0, 0]);
  expect(Math.abs(small[7].red! - 64)).toBeLessThanOrEqual(1);
  expect(Math.abs(small[7].blue! - 64)).toBeLessThanOrEqual(1);
  // ±1 for the sRGB → linear → sRGB round trip through the float vertex colors.
  for (const v of big) {
    expect(Math.abs(v.red! - bigRgb[0])).toBeLessThanOrEqual(1);
    expect(Math.abs(v.green! - bigRgb[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(v.blue! - bigRgb[2])).toBeLessThanOrEqual(1);
  }
});

// Create a plane through the real Create Plane dialog.
async function createPlane(p: { center: [number, number, number]; width: number; length: number; rotX: number }) {
  const { page } = session;
  await page.getByTestId('tool-create-plane').click();
  const popup = page.getByTestId('create-plane-popup');
  await expect(popup).toBeVisible();
  const set = async (testId: string, value: number) => {
    const input = popup.getByTestId(testId);
    await input.fill(String(value));
    await input.press('Tab');
  };
  await set('plane-center-x', p.center[0]);
  await set('plane-center-y', p.center[1]);
  await set('plane-center-z', p.center[2]);
  await set('plane-width', p.width);
  await set('plane-length', p.length);
  await set('plane-rot-x', p.rotX);
  await popup.getByTestId('create-plane-submit').click();
  await expect(popup).toHaveCount(0);
}

// Primitive shapes, and a source that is ROTATED and SCALED — the transform
// lives beside the mesh, so this is where a merge that copied raw vertices (or
// composed the pivot on the wrong side) would put geometry in the wrong place.
test('merges shapes at their rotated, scaled placement and keeps their opacity', async () => {
  // A: flat 2 × 4 plane at the origin.           → x ∈ [-1, 1],  y ∈ [-2, 2], z = 0
  // B: 2 × 2 plane at (10, 0, 5), stood up by a
  //    90° turn about X (its Y extent becomes Z). → x ∈ [9, 11],  y = 0,       z ∈ [4, 6]
  await createPlane({ center: [0, 0, 0], width: 2, length: 4, rotX: 0 });
  await expect(meshRows()).toHaveCount(1);
  await createPlane({ center: [10, 0, 5], width: 2, length: 2, rotX: 90 });
  await expect(meshRows()).toHaveCount(2);
  await expect(meshRows().nth(1)).toHaveAttribute('data-mesh-rotation', '90.0,0.0,0.0');
  await expect(meshRows().nth(1)).toHaveAttribute('data-mesh-position', '10.00,0.00,5.00');

  // Shapes draw translucent by default; the merge must not turn them opaque.
  const sourceOpacity = await meshRows().first().getAttribute('data-opacity');
  expect(Number(sourceOpacity)).toBeLessThan(1);

  const { dialog } = await openMeshMerge();
  await dialog.getByTestId('stitch-run').click();
  await expect(meshRows()).toHaveCount(1, { timeout: 15_000 });
  await expect(mergedRow()).toHaveAttribute('data-triangle-count', '4');
  await expect(mergedRow()).toHaveAttribute('data-opacity', sourceOpacity!);
  // The transform is baked: the merge carries no rotation or scale of its own.
  await expect(mergedRow()).toHaveAttribute('data-mesh-rotation', '0.0,0.0,0.0');
  await expect(mergedRow()).toHaveAttribute('data-mesh-scale', '1.00,1.00,1.00');

  const { vertices, faces } = await exportSelectedPly('planes.ply');
  expect(faces).toBe(4);
  const n = vertices.length / 2;
  const a = vertices.slice(0, n), b = vertices.slice(n);
  const span = (vs: PlyVertex[], axis: 'x' | 'y' | 'z') => [Math.min(...vs.map(v => v[axis])), Math.max(...vs.map(v => v[axis]))];
  const expectSpan = (vs: PlyVertex[], axis: 'x' | 'y' | 'z', lo: number, hi: number) => {
    const [min, max] = span(vs, axis);
    expect(min).toBeCloseTo(lo, 4);
    expect(max).toBeCloseTo(hi, 4);
  };
  expectSpan(a, 'x', -1, 1); expectSpan(a, 'y', -2, 2); expectSpan(a, 'z', 0, 0);
  expectSpan(b, 'x', 9, 11); expectSpan(b, 'y', 0, 0); expectSpan(b, 'z', 4, 6);
});

test('a merge is one undo step that restores both source meshes', async () => {
  const page = await importCubes();
  const { dialog } = await openMeshMerge();
  await dialog.getByTestId('stitch-run').click();
  await expect(meshRows()).toHaveCount(1, { timeout: 15_000 });
  await expect(mergedRow()).toHaveAttribute('data-triangle-count', '24');

  await page.keyboard.press('ControlOrMeta+z');
  await expect(meshRows()).toHaveCount(2, { timeout: 15_000 });
  await expect(mergedRow()).toHaveCount(0);
  await expect(row('cube-mesh')).toHaveAttribute('data-triangle-count', '12');
  await expect(row('big-cube-mesh')).toHaveAttribute('data-triangle-count', '12');
  await expect(row('cube-mesh')).toHaveAttribute('data-visible', 'true');
});

test('keeping originals leaves the sources hidden beside the merge, and undo brings them back', async () => {
  const page = await importCubes();
  const { dialog } = await openMeshMerge();
  const retain = dialog.getByTestId('stitch-retain-originals');
  await expect(retain).toContainText('Keep original meshes');
  await expect(retain.locator('input')).not.toBeChecked();
  await retain.locator('input').check();
  await dialog.getByTestId('stitch-run').click();

  await expect(meshRows()).toHaveCount(3, { timeout: 15_000 });
  await expect(row('cube-mesh')).toHaveAttribute('data-visible', 'false');
  await expect(row('big-cube-mesh')).toHaveAttribute('data-visible', 'false');
  await expect(row('cube-mesh')).toHaveAttribute('data-triangle-count', '12');
  await expect(mergedRow()).toHaveAttribute('data-triangle-count', '24');
  await expect(mergedRow()).toHaveAttribute('data-visible', 'true');
  await expect(mergedRow()).toHaveAttribute('data-selected', 'true');

  // Hiding the sources is part of the same transaction, so one undo removes
  // the merge AND shows them again.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(meshRows()).toHaveCount(2, { timeout: 15_000 });
  await expect(row('cube-mesh')).toHaveAttribute('data-visible', 'true');
  await expect(row('big-cube-mesh')).toHaveAttribute('data-visible', 'true');
});

async function importSheets() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', [SHEET_A, SHEET_B]);
  await expect(meshRows()).toHaveCount(2, { timeout: 30_000 });
  await expect(row('overlap-sheet-a')).toHaveAttribute('data-triangle-count', '64');
  await expect(row('overlap-sheet-b')).toHaveAttribute('data-triangle-count', '64');
}

// The control for the two tests below: with neither box ticked, the shared
// surface stays doubled and each sheet keeps the gray it was imported with.
test('a plain merge of overlapping meshes keeps both surfaces and both colors', async () => {
  await importSheets();
  const { dialog } = await openMeshMerge();
  await expect(dialog.getByTestId('stitch-mesh-match-colors').locator('input')).not.toBeChecked();
  await expect(dialog.getByTestId('stitch-mesh-remove-overlap').locator('input')).not.toBeChecked();
  await dialog.getByTestId('stitch-run').click();
  await expect(mergedRow()).toHaveAttribute('data-triangle-count', '128', { timeout: 15_000 });

  const { vertices, faces } = await exportSelectedPly('plain.ply');
  expect(faces).toBe(128);
  expect(vertices).toHaveLength(90);
  const reds = vertices.map(v => v.red!);
  expect(Math.max(...reds) - Math.min(...reds)).toBeGreaterThanOrEqual(98);
});

test('matching colors evens out two differently lit meshes without touching geometry', async () => {
  await importSheets();
  const { dialog } = await openMeshMerge();
  await dialog.getByTestId('stitch-mesh-match-colors').locator('input').check();
  await dialog.getByTestId('stitch-run').click();
  await expect(mergedRow()).toHaveAttribute('data-triangle-count', '128', { timeout: 15_000 });
  await expect(session.page.getByText(/colors matched across 2 meshes/)).toBeVisible();

  const { vertices, faces } = await exportSelectedPly('matched.ply');
  expect(faces).toBe(128);
  expect(vertices).toHaveLength(90);
  // Gray 200 and gray 100 meet between the two, and the whole mesh — not just
  // the overlap — is now one shade: both sheets were uniformly lit.
  const reds = vertices.map(v => v.red!);
  expect(Math.max(...reds) - Math.min(...reds)).toBeLessThanOrEqual(3);
  expect(Math.min(...reds)).toBeGreaterThan(110);
  expect(Math.max(...reds)).toBeLessThan(190);
  for (const v of vertices) expect([v.green, v.blue]).toEqual([v.red, v.red]);
});

test('removing the overlapping surface leaves one copy that still covers both meshes', async () => {
  await importSheets();
  const { dialog } = await openMeshMerge();
  await dialog.getByTestId('stitch-mesh-match-colors').locator('input').check();
  await dialog.getByTestId('stitch-mesh-remove-overlap').locator('input').check();
  await dialog.getByTestId('stitch-run').click();
  await expect(meshRows()).toHaveCount(1, { timeout: 15_000 });
  await expect(session.page.getByText(/overlapping triangles removed/)).toBeVisible();

  const { vertices, faces } = await exportSelectedPly('fused.ply');
  // The union is 12 × 4 unit quads = 96 triangles against 128 unmerged. A
  // triangle goes only when all its vertices lose, so the trim leaves a doubled
  // strip along the seam: never fewer than the union, at most two quad columns over.
  expect(faces).toBeGreaterThanOrEqual(96);
  expect(faces).toBeLessThanOrEqual(96 + 16);
  await expect(mergedRow()).toHaveAttribute('data-triangle-count', String(faces));
  // Nothing was lost: every grid point of the 13 × 5 union is still a vertex.
  const points = new Set(vertices.map(v => `${Math.round(v.x)},${Math.round(v.y)}`));
  expect(points.size).toBe(13 * 5);
  for (const v of vertices) expect(Math.abs(v.z)).toBeLessThan(1e-6);
  expect(vertices.length).toBeLessThan(90);
  const reds = vertices.map(v => v.red!);
  expect(Math.max(...reds) - Math.min(...reds)).toBeLessThanOrEqual(3);

  // Still one undo step, restoring both untouched sources.
  await session.page.keyboard.press('ControlOrMeta+z');
  await expect(meshRows()).toHaveCount(2, { timeout: 15_000 });
  await expect(row('overlap-sheet-a')).toHaveAttribute('data-triangle-count', '64');
  await expect(row('overlap-sheet-b')).toHaveAttribute('data-triangle-count', '64');
});

test('a triangulation is listed but cannot be picked for a merge', async () => {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);
  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  // Ball pivoting: deterministic on tiny.xyz (see export-mesh.spec.ts).
  await page.getByTestId('tool-triangulate').click();
  const triModal = page.getByTestId('triangulation-popup');
  await expect(triModal).toBeVisible();
  await triModal.getByTestId('triangulation-method').selectOption('ball_pivoting');
  await triModal.getByTestId('triangulation-run-button').click();
  await expect(meshRows()).toHaveCount(1, { timeout: 60_000 });

  await importFiles(app, page, 'import-auto', CUBE);
  await expect(meshRows()).toHaveCount(2, { timeout: 30_000 });

  const { dialog, picker } = await openMeshMerge();
  const rows = picker.getByTestId('picker-row');
  await expect(rows).toHaveCount(2);
  const refused = picker.locator('[data-testid="picker-row"][data-disabled="true"]');
  await expect(refused).toHaveCount(1);
  await expect(refused).toHaveAttribute('title', /triangulation/);
  await expect(refused.locator('input')).toBeDisabled();

  // Only the imported cube is pickable — one mesh is not a merge.
  await expect(dialog.getByText('Select at least 2 meshes')).toBeVisible();
  await expect(dialog.getByTestId('stitch-run')).toBeDisabled();
});
