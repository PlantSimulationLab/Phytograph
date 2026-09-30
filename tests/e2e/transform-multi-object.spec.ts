import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { stubSaveDialog } from './helpers/stubSaveDialog';

// The Transformation tool as a multi-object picker tool: every cloud and mesh
// in the scene is listed, and ONE relative move / rotate / scale about the
// scene origin applies to all checked objects. Order: scale along the world
// axes, then rotate, then translate:  M = T(P + t) · R · S · T(−P).
//
// Every assertion is on geometry the app actually holds or wrote, computed
// independently from the fixture — never on the panel's own numbers.
const CLOUD = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sparse.xyz');
const CUBE_PLY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'cube-mesh.ply');
const UTM = join(repoRoot, 'tests', 'e2e', 'fixtures', 'utm-tree.xyz');
const UNDO = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';

test.describe('Transform tool: clouds and meshes together', () => {
  let session: LaunchedApp;

  test.beforeAll(async () => {
    session = await launchApp();
  });
  test.afterAll(async () => {
    await session?.close();
  });
  test.beforeEach(async () => {
    await resetToFreshScene(session.app, session.page);
  });

  const scanRow = (name: string) =>
    session.page.locator(`[data-testid="scan-row"][data-scan-name="${name}"]`);
  const targetRow = (label: string) =>
    session.page.locator(`[data-testid="transform-target-row"][data-label="${label}"]`);

  async function importCloud(path: string, name: string) {
    await importFiles(session.app, session.page, 'import-point-cloud', path);
    await completeImportWizard(session.page);
    const row = scanRow(name);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveAttribute('data-octree', 'true');
    return row;
  }

  async function importCube() {
    await importFiles(session.app, session.page, 'import-mesh', CUBE_PLY);
    const row = session.page.getByTestId('mesh-row').first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    return row;
  }

  async function setSceneOrigin(x: string, y: string, z: string) {
    const { page } = session;
    await page.getByTestId('tool-set-scene-origin').click();
    await expect(page.getByTestId('scene-origin-panel')).toBeVisible();
    for (const [axis, v] of [['x', x], ['y', y], ['z', z]] as const) {
      const input = page.getByTestId(`scene-origin-input-${axis}`);
      await input.fill(v);
      await input.press('Enter');
    }
    await page.getByTestId('scene-origin-close').click();
    await expect(page.getByTestId('scene-origin-panel')).toBeHidden();
  }

  async function field(testId: string, value: string) {
    const input = session.page.getByTestId(testId);
    await input.fill(value);
    await input.press('Enter');
  }

  const bounds = async (row: ReturnType<typeof scanRow>) =>
    (await row.getAttribute('data-scan-bounds'))!.split(',').map(Number);
  const vec = async (row: ReturnType<typeof scanRow>, attr: string) =>
    (await row.getAttribute(attr))!.split(',').map(Number);

  async function openTool() {
    await session.page.getByTestId('tool-cloud-translate').click();
    await expect(session.page.getByTestId('translate-panel')).toBeVisible();
  }

  async function ok() {
    await session.page.getByTestId('translate-ok').click();
    await expect(session.page.getByTestId('translate-panel')).toBeHidden({ timeout: 60_000 });
  }

  // Net draft translation of the cloud's live octree object (what is DRAWN).
  async function drawnNetX(row: ReturnType<typeof scanRow>) {
    const cacheId = await row.getAttribute('data-octree-cache-id');
    return session.page.evaluate((id) => {
      const reg = (window as any).__octreePositions;
      return reg?.[id!]?.net?.x ?? NaN;
    }, cacheId);
  }

  test('one scale + rotate + move bakes a cloud and a mesh together; undo restores the mesh', async () => {
    const { page } = session;
    const cube = await importCube();
    const cloud = await importCloud(CLOUD, 'sparse');
    await setSceneOrigin('0', '0', '0');

    // Nothing selected: the tool must still open, with nothing checked.
    await page.getByTestId('scans-panel').getByTitle('Deselect All').click();
    await page.getByTestId('meshes-deselect-all').click();
    const [x0, y0, z0, x1, y1, z1] = await bounds(cloud);
    const p0 = await vec(cube, 'data-mesh-position');

    await openTool();
    await expect(page.getByTestId('transform-target-row')).toHaveCount(2);
    await expect(page.locator('[data-testid="transform-target-row"][data-checked="true"]')).toHaveCount(0);
    await page.getByTestId('transform-target-row').nth(0).click();
    await page.getByTestId('transform-target-row').nth(1).click();
    await expect(page.locator('[data-testid="transform-target-row"][data-checked="true"]')).toHaveCount(2);

    // Independent X scale: unlock first.
    await page.getByTestId('scale-lock').click();
    await expect(page.getByTestId('scale-lock')).toHaveAttribute('data-locked', 'false');
    await field('scale-input-x', '2');
    // A cloud is checked and the scale is non-uniform → the scan-geometry warning.
    await expect(page.getByTestId('transform-nonuniform-warning')).toBeVisible();
    await field('rotation-input-z', '90');
    await field('translate-input-x', '5');
    await ok();

    // Cloud: (x, y, z) → S → (2x, y, z) → Rz90 → (−y, 2x, z) → +5x. A 90°
    // turn keeps an AABB exact, so its corners are known precisely.
    const want = [5 - y1, 2 * x0, z0, 5 - y0, 2 * x1, z1];
    await expect.poll(async () => Math.abs((await bounds(cloud))[0] - want[0]), { timeout: 20_000 })
      .toBeLessThan(2e-3);
    const got = await bounds(cloud);
    // 2e-3: the attribute rounds to 3 decimals on both sides of the comparison.
    for (let i = 0; i < 6; i++) expect(Math.abs(got[i] - want[i])).toBeLessThan(2e-3);

    // Mesh: an axis-aligned mesh stays position / rotation / scale.
    await expect(cube).toHaveAttribute('data-mesh-rotation', '0.0,0.0,90.0');
    await expect(cube).toHaveAttribute('data-mesh-scale', '2.00,1.00,1.00');
    const p1 = await vec(cube, 'data-mesh-position');
    expect(p1[0]).toBeCloseTo(5 - p0[1], 2);
    expect(p1[1]).toBeCloseTo(2 * p0[0], 2);
    expect(p1[2]).toBeCloseTo(p0[2], 2);

    // Undo reverts the MESH transaction; the cloud bake is permanent.
    const cloudAfter = await bounds(cloud);
    await page.keyboard.press(UNDO);
    await expect(cube).toHaveAttribute('data-mesh-rotation', '0.0,0.0,0.0');
    await expect(cube).toHaveAttribute('data-mesh-scale', '1.00,1.00,1.00');
    expect(await bounds(cloud)).toEqual(cloudAfter);
  });

  test('the checked set, not the pane selection, is what moves', async () => {
    const { page } = session;
    const cloud = await importCloud(CLOUD, 'sparse');
    await expect(cloud).toHaveAttribute('data-selected', 'true');

    // Opened with the cloud selected → seeded checked.
    await openTool();
    const row = targetRow('sparse');
    await expect(row).toHaveAttribute('data-checked', 'true');

    // Clicking the Scans pane while the tool is open changes nothing it targets.
    await cloud.getByTestId('scan-row-name').click();
    await expect(cloud).toHaveAttribute('data-selected', 'false');
    await expect(row).toHaveAttribute('data-checked', 'true');

    await field('translate-input-x', '3');
    await expect.poll(() => drawnNetX(cloud), { timeout: 10_000 }).toBeCloseTo(3, 5);

    // Unchecking takes the cloud out of the operation: it snaps back.
    await row.click();
    await expect(row).toHaveAttribute('data-checked', 'false');
    await expect.poll(() => drawnNetX(cloud), { timeout: 10_000 }).toBeCloseTo(0, 5);
    await expect(page.getByTestId('translate-ok')).toBeDisabled();

    // Re-checking applies the CURRENT delta, since the fields describe it.
    await row.click();
    await expect.poll(() => drawnNetX(cloud), { timeout: 10_000 }).toBeCloseTo(3, 5);

    // Cancel discards everything.
    await page.getByTestId('translate-cancel').click();
    await expect(page.getByTestId('translate-panel')).toBeHidden();
    await expect.poll(() => drawnNetX(cloud), { timeout: 10_000 }).toBeCloseTo(0, 5);
  });

  test('a non-uniform scale on a rotated mesh is baked into its vertices', async () => {
    const { app, page } = session;
    const cube = await importCube();

    // Turn the cube 45° about Z in its own (absolute) editor.
    await cube.getByTestId('mesh-transform-toggle').click();
    await field('mesh-rot-z', '45');
    await expect(cube).toHaveAttribute('data-mesh-rotation', '0.0,0.0,45.0');
    await cube.getByTestId('mesh-transform-toggle').click();
    await expect(page.getByTestId('mesh-pos-x')).toHaveCount(0);

    // Stretch world X by 2: a shear in the cube's own frame.
    await expect(cube).toHaveAttribute('data-selected', 'true');
    await openTool();
    await expect(page.locator('[data-testid="transform-target-row"][data-checked="true"]')).toHaveCount(1);
    await page.getByTestId('scale-lock').click();
    await field('scale-input-x', '2');
    await expect(page.getByTestId('transform-mesh-bake-note')).toBeVisible();
    // Only a mesh is checked → no scan-geometry warning.
    await expect(page.getByTestId('transform-nonuniform-warning')).toHaveCount(0);
    await ok();
    await expect(cube).toHaveAttribute('data-mesh-scale', '1.00,1.00,1.00');

    // The exported OBJ holds the LOCAL vertices. Its rotation has moved to the
    // transform, so local pairwise distances are world distances: they must be
    // those of S(2,1,1)·Rz(45°)·v for the fixture's unit cube.
    const dir = mkdtempSync(join(tmpdir(), 'transform-shear-'));
    try {
      const objPath = join(dir, 'sheared.obj');
      await stubSaveDialog(app, objPath);
      await page.evaluate(() => (window as any).__openExportPanel?.());
      await expect(page.getByTestId('export-modal')).toBeVisible();
      await page.getByTestId('export-mesh-obj').click();
      await expect(page.getByTestId('toast-title').filter({ hasText: 'Export Complete' }))
        .toBeVisible({ timeout: 20_000 });
      const verts = readFileSync(objPath, 'utf8').split('\n')
        .filter(l => l.startsWith('v '))
        .map(l => l.slice(2).trim().split(/\s+/).slice(0, 3).map(Number));
      expect(verts).toHaveLength(8);

      const c = Math.SQRT1_2;
      const cubeV = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
      const world = cubeV.map(([x, y, z]) => [2 * (c * x - c * y), c * x + c * y, z]);
      const dists = (pts: number[][]) => {
        const out: number[] = [];
        for (let i = 0; i < pts.length; i++) {
          for (let j = i + 1; j < pts.length; j++) {
            out.push(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]));
          }
        }
        return out;
      };
      const got = dists(verts);
      const want = dists(world);
      for (let i = 0; i < want.length; i++) expect(got[i]).toBeCloseTo(want[i], 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // Undo restores the original vertices AND the 45° transform.
    await page.keyboard.press(UNDO);
    await expect(cube).toHaveAttribute('data-mesh-rotation', '0.0,0.0,45.0');
  });

  test('rotating a UTM-shifted cloud lands where it was drawn (world-shift conjugation)', async () => {
    // Import with the wizard's default global shift ON: the session stores
    // coordinates with ~(545000, 4183000) subtracted. The tool's matrix lives
    // in that stored frame; sending it unconjugated moved the geometry by
    // (R·shift − shift) — ~6,000 km for a 90° turn — while the view (posed
    // from the same matrix) looked right. Export reads the SESSION, so it is
    // where the error shows.
    const { app, page } = session;
    const cloud = await importCloud(UTM, 'utm-tree');
    await expect(cloud).toHaveAttribute('data-selected', 'true');

    // Pivot = the cloud's own center, so a 90° turn leaves its bbox center put.
    await page.getByTestId('tool-set-scene-origin').click();
    await page.getByTestId('scene-origin-to-selection').click();
    await page.getByTestId('scene-origin-close').click();

    await openTool();
    await field('rotation-input-z', '90');
    await ok();

    const src = readFileSync(UTM, 'utf8').split('\n')
      .filter(l => l.trim() && !l.startsWith('#'))
      .map(l => l.trim().split(/\s+/).slice(0, 3).map(Number));
    const box = (pts: number[][]) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const p of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
      return { lo, hi };
    };
    const before = box(src);

    const dir = mkdtempSync(join(tmpdir(), 'transform-utm-'));
    try {
      const out = join(dir, 'rotated.asc');
      await stubSaveDialog(app, out);
      await page.evaluate(() => (window as any).__openExportPanel?.());
      await expect(page.getByTestId('export-modal')).toBeVisible();
      await page.getByTestId('export-format-asc').click();
      await page.getByTestId('export-cloud-go').click();
      await expect.poll(() => (existsSync(out) ? readFileSync(out, 'utf8').length : 0), { timeout: 30_000 })
        .toBeGreaterThan(0);
      await expect(page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }))
        .toBeVisible({ timeout: 30_000 });
      const pts = readFileSync(out, 'utf8').split('\n')
        .filter(l => l.trim() && !l.startsWith('#'))
        .map(l => l.trim().split(/\s+/).slice(0, 3).map(Number));
      expect(pts).toHaveLength(src.length);
      const after = box(pts);
      for (let k = 0; k < 2; k++) {
        expect((after.lo[k] + after.hi[k]) / 2).toBeCloseTo((before.lo[k] + before.hi[k]) / 2, 2);
      }
      // X and Y spans swap under a 90° turn about Z.
      expect(after.hi[0] - after.lo[0]).toBeCloseTo(before.hi[1] - before.lo[1], 2);
      expect(after.hi[1] - after.lo[1]).toBeCloseTo(before.hi[0] - before.lo[0], 2);
      expect(after.lo[2]).toBeCloseTo(before.lo[2], 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
