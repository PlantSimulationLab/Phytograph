import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { stubSaveDialog } from './helpers/stubSaveDialog';

// Crop applied to MESHES, end-to-end.
//
// Fixture: strip-mesh.ply — 10 unit squares along +x, two triangles each
// (20 triangles, 22 vertices), with z = 0.1·x. Square i contributes centroids
// at x = i + 1/3 and x = i + 2/3.
//
// A mesh is cut by whole triangles, each going to the side its CENTROID is on.
// The box x ∈ [2.5, 6.5] is placed to make that rule visible: it slices through
// squares 2 and 6, and exactly one triangle of each has its centroid inside.
//   inside  = squares 3, 4, 5 (6) + centroid 2.667 + centroid 6.333 = 8
//   outside = 12
// Every centroid is ≥ 0.16 m from a box face, so float rounding can't flip one.
// A crop that kept "any vertex inside" would give 10, "all vertices inside" 6.
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).
const STRIP = join(repoRoot, 'tests', 'e2e', 'fixtures', 'strip-mesh.ply');
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
  outDir = mkdtempSync(join(tmpdir(), 'mesh-crop-'));
});
test.afterEach(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

const stripRow = () => session.page.locator('[data-testid="mesh-row"][data-mesh-name="strip-mesh"]');

async function importStrip() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', STRIP);
  await expect(stripRow()).toBeVisible({ timeout: 30_000 });
  await expect(stripRow()).toHaveAttribute('data-triangle-count', '20');
}

async function setBox(
  page: LaunchedApp['page'],
  box: { x: [number, number]; y: [number, number]; z: [number, number] },
) {
  async function setNumber(testId: string, value: number) {
    const input = page.getByTestId(testId);
    await input.click();
    await input.fill(String(value));
    await input.press('Tab');
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    const [lo, hi] = box[axis];
    await setNumber(`crop-dim-${axis}`, hi - lo);
    await setNumber(`crop-center-${axis}`, (lo + hi) / 2);
  }
  const f = (n: number) => n.toFixed(3);
  await expect(page.getByTestId('crop-panel'))
    .toHaveAttribute('data-crop-min', `${f(box.x[0])},${f(box.y[0])},${f(box.z[0])}`);
  await expect(page.getByTestId('crop-panel'))
    .toHaveAttribute('data-crop-max', `${f(box.x[1])},${f(box.y[1])},${f(box.z[1])}`);
}

// x ∈ [2.5, 6.5]; y and z comfortably enclose the strip (y 0..1, z 0..1).
const MID_BOX = { x: [2.5, 6.5], y: [-1.5, 2.5], z: [-1.5, 2.5] } as { x: [number, number]; y: [number, number]; z: [number, number] };

// Open Crop and check the strip in the Meshes list.
async function openCropOnStrip() {
  const { page } = session;
  await page.getByTestId('tool-crop').click();
  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();
  const row = panel.locator('[data-testid="crop-mesh-target-row"][data-label="strip-mesh"]');
  await row.locator('input').check();
  await expect(panel).toHaveAttribute('data-mesh-count', '1');
  return panel;
}

test('crops a mesh to the box by triangle centroid, and the export matches', async () => {
  const { app, page } = session;
  await importStrip();

  // Crop is available with only a mesh in the scene (no point cloud).
  await expect(page.getByTestId('scan-row')).toHaveCount(0);
  const panel = await openCropOnStrip();

  // The box starts on the checked mesh's own extent.
  await expect(panel).toHaveAttribute('data-crop-min', '0.000,0.000,0.000');
  await expect(panel).toHaveAttribute('data-crop-max', '10.000,1.000,1.000');

  await setBox(page, MID_BOX);
  // The live preview is already drawing exactly the triangles Apply will keep.
  await expect(panel).toHaveAttribute('data-mesh-preview-kept', '8');
  await expect(page.getByTestId('crop-apply')).toHaveText('Apply crop to 1 mesh');
  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });

  await expect(stripRow()).toHaveAttribute('data-triangle-count', '8');
  await expect(page.getByTestId('mesh-row')).toHaveCount(1);
  await expect(page.getByTestId('toast-title').filter({ hasText: 'Cropped 1 mesh to 8 triangles' }))
    .toBeVisible();

  // The file on disk is the cropped mesh: 8 faces, and only the 10 vertices
  // those faces use — the 12 belonging solely to removed triangles are gone.
  await stripRow().click();
  await expect(stripRow()).toHaveAttribute('data-selected', 'true');
  const objPath = join(outDir, 'cropped.obj');
  await stubSaveDialog(app, objPath);
  await page.evaluate(() => (window as any).__openExportPanel?.());
  await expect(page.getByTestId('export-modal')).toBeVisible();
  await page.getByTestId('export-mesh-obj').click();
  await expect(page.getByTestId('toast-title').filter({ hasText: 'Export Complete' }))
    .toBeVisible({ timeout: 20_000 });
  expect(existsSync(objPath)).toBe(true);
  const obj = readFileSync(objPath, 'utf8').split('\n');
  const verts = obj.filter(l => l.startsWith('v ')).map(l => l.slice(2).trim().split(/\s+/).map(Number));
  const faces = obj.filter(l => l.startsWith('f '));
  expect(faces).toHaveLength(8);
  expect(verts).toHaveLength(10);
  // Whole triangles are kept, so vertices reach past the box to the edges of
  // the two straddling triangles — x from 2 to 7, never the strip's 0 or 10.
  const xs = verts.map(v => v[0]);
  expect(Math.min(...xs)).toBeCloseTo(2, 5);
  expect(Math.max(...xs)).toBeCloseTo(7, 5);
});

test('a mesh crop is one undo step, and redo re-applies it', async () => {
  const { page } = session;
  await importStrip();
  const panel = await openCropOnStrip();
  await setBox(page, MID_BOX);
  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(stripRow()).toHaveAttribute('data-triangle-count', '8');

  await page.keyboard.press('ControlOrMeta+z');
  await expect(stripRow()).toHaveAttribute('data-triangle-count', '20');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(stripRow()).toHaveAttribute('data-triangle-count', '8');
});

test('Keep Outside removes the in-box triangles instead', async () => {
  const { page } = session;
  await importStrip();
  const panel = await openCropOnStrip();
  await page.getByTestId('crop-mode-outside').click();
  await setBox(page, MID_BOX);
  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(stripRow()).toHaveAttribute('data-triangle-count', '12');
});

test('Segment splits a mesh in two without losing a triangle', async () => {
  const { page } = session;
  await importStrip();
  const panel = await openCropOnStrip();
  await page.getByTestId('crop-mode-segment').click();
  await setBox(page, MID_BOX);
  await expect(page.getByTestId('crop-apply')).toHaveText('Segment 1 mesh');
  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });

  const segment = page.locator('[data-testid="mesh-row"][data-mesh-name="strip-mesh (segment)"]');
  await expect(page.getByTestId('mesh-row')).toHaveCount(2);
  await expect(stripRow()).toHaveAttribute('data-triangle-count', '8');
  await expect(segment).toHaveAttribute('data-triangle-count', '12');
  await expect(segment).toHaveAttribute('data-visible', 'true');

  // Both halves came from one gesture, so one undo puts the mesh back whole.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('mesh-row')).toHaveCount(1);
  await expect(stripRow()).toHaveAttribute('data-triangle-count', '20');
});

test('Keep originals leaves the source mesh whole and hidden', async () => {
  const { page } = session;
  await importStrip();
  const panel = await openCropOnStrip();
  await page.getByTestId('crop-retain-original').locator('input').check();
  await setBox(page, MID_BOX);
  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });

  const cropped = page.locator('[data-testid="mesh-row"][data-mesh-name="strip-mesh (cropped)"]');
  await expect(cropped).toHaveAttribute('data-triangle-count', '8');
  await expect(cropped).toHaveAttribute('data-visible', 'true');
  await expect(cropped).toHaveAttribute('data-selected', 'true');
  await expect(stripRow()).toHaveAttribute('data-triangle-count', '20');
  await expect(stripRow()).toHaveAttribute('data-visible', 'false');
});

test('a screen-space rectangle crops a mesh, and Apply keeps what the preview showed', async () => {
  const { page } = session;
  await importStrip();
  const panel = await openCropOnStrip();
  await page.getByTestId('crop-shape-rect').click();
  await expect(panel).toHaveAttribute('data-crop-mode', 'rect');
  // No region yet, so nothing is previewed.
  await expect(panel).toHaveAttribute('data-mesh-preview-kept', '');

  const overlay = page.getByTestId('crop-rect-overlay');
  await expect(overlay).toBeVisible();
  const box = await overlay.boundingBox();
  if (!box) throw new Error('crop-rect-overlay has no bounding box');
  // Left half of the viewport, full height (the crop panel floats over the
  // right edge, so the drag stays clear of it).
  const inset = 8;
  const midX = box.x + box.width / 2;
  await page.mouse.move(box.x + inset, box.y + inset);
  await page.mouse.down();
  await page.mouse.move(midX, box.y + box.height / 2);
  await page.mouse.move(midX, box.y + box.height - inset);
  await page.mouse.up();
  await expect(page.getByTestId('crop-apply')).toBeEnabled();

  // A half-viewport cut through a framed mesh keeps some triangles, not all
  // and not none — unless the projection of the mesh into the frozen camera
  // is wrong.
  await expect(panel).toHaveAttribute('data-mesh-preview-kept', /^\d+$/);
  const previewed = Number(await panel.getAttribute('data-mesh-preview-kept'));
  expect(previewed).toBeGreaterThan(0);
  expect(previewed).toBeLessThan(20);

  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(stripRow()).toHaveAttribute('data-triangle-count', String(previewed));
});

test('a crop that would empty a mesh leaves it unchanged and says so', async () => {
  const { page } = session;
  await importStrip();
  const panel = await openCropOnStrip();
  // A box well clear of the strip (x 0..10).
  await setBox(page, { x: [20, 24], y: [-1.5, 2.5], z: [-1.5, 2.5] });
  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('toast-title').filter({ hasText: 'Nothing left of strip-mesh' }))
    .toBeVisible();
  await expect(stripRow()).toHaveAttribute('data-triangle-count', '20');
});

test('one box crops a point cloud and a mesh together', async () => {
  const { app, page } = session;
  // tiny.xyz: cylinder at the origin, r = 0.3, 5 z-layers × 12 points at
  // z = 0, 0.375, 0.75, 1.125, 1.5.
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);
  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(tinyRow).toHaveAttribute('data-point-count', '60', { timeout: 20_000 });
  await importStrip();

  await page.getByTestId('tool-crop').click();
  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();
  await panel.locator('[data-testid="crop-target-row"][data-label="tiny"]').locator('input').check();
  await panel.locator('[data-testid="crop-mesh-target-row"][data-label="strip-mesh"]').locator('input').check();
  await expect(panel).toHaveAttribute('data-selection-count', '1');
  await expect(panel).toHaveAttribute('data-mesh-count', '1');

  // x ∈ [-1.5, 4.5], z ∈ [0.25, 1.25].
  //  cloud: the three middle layers (0.375, 0.75, 1.125) → 36 points.
  //  mesh:  z = 0.1·x, so z ≥ 0.25 means centroid x ≥ 2.5, and x ≤ 4.5 caps it:
  //         centroids 2.667, 3.333, 3.667, 4.333 → 4 triangles.
  await setBox(page, { x: [-1.5, 4.5], y: [-1.5, 2.5], z: [0.25, 1.25] });
  await expect(page.getByTestId('crop-apply')).toHaveText('Apply crop to 1 scan + 1 mesh');
  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

  await expect(stripRow()).toHaveAttribute('data-triangle-count', '4');
  await expect(tinyRow).toHaveAttribute('data-point-count', '36', { timeout: 20_000 });
});
