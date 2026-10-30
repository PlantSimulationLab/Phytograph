import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { resetToFreshScene } from './helpers/resetApp';
import { stubSaveDialog } from './helpers/stubSaveDialog';

// An OBJ's `o`/`g` object groups survive import as sub-groups of the one mesh:
// listed under its row (collapsed by default), each with its own eye, and
// selectable so t/r/s, Extract, Delete and Recolor act on just those groups.
//
// The fixture is three unit cubes, 3 m apart along X, one per group (12
// triangles each), so every result has an exact expected value: which group's
// vertices moved and by how much is read back from the exported OBJ on disk.
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'three-groups.obj');
const UNDO = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';

let session: LaunchedApp;
let outDir: string;
test.beforeAll(async () => {
  session = await launchApp();
  await expect(session.page.getByTestId('backend-splash')).toBeHidden({ timeout: 90_000 });
});
test.afterAll(async () => {
  await session?.close();
});
test.beforeEach(async () => {
  await resetToFreshScene(session.app, session.page);
  outDir = mkdtempSync(join(tmpdir(), 'mesh-groups-'));
});
test.afterEach(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

async function importGrouped(page: Page) {
  await importFiles(session.app, page, 'import-mesh', FIXTURE);
  const row = page.getByTestId('mesh-row');
  await expect(row).toHaveCount(1, { timeout: 60_000 });
  await expect(row).toHaveAttribute('data-triangle-count', '36');
  // Collapsed by default.
  await expect(page.getByTestId('mesh-group-list')).toHaveCount(0);
  const expand = page.getByTestId('mesh-groups-expand');
  await expect(expand).toHaveText(/3 groups/);
  await expand.click();
  await expect(page.getByTestId('mesh-group-row')).toHaveCount(3);
  return row;
}

const groupRow = (page: Page, name: string) =>
  page.locator(`[data-testid="mesh-group-row"][data-group-name="${name}"]`);

/** Select the (first) mesh row and export it as OBJ; returns {obj, mtl?}. */
async function exportObj(page: Page, name: string): Promise<{ obj: string; mtl: string | null }> {
  const row = page.getByTestId('mesh-row').first();
  // Click the NAME: the row's center holds the "N groups" disclosure button.
  if ((await row.getAttribute('data-selected')) !== 'true') await row.getByTestId('mesh-row-name').click();
  await expect(row).toHaveAttribute('data-selected', 'true');
  const objPath = join(outDir, `${name}.obj`);
  await stubSaveDialog(session.app, objPath);
  await page.evaluate(() => (window as any).__openExportPanel?.());
  await expect(page.getByTestId('export-modal')).toBeVisible();
  await page.getByTestId('export-mesh-obj').click();
  await expect(page.getByTestId('toast-title').filter({ hasText: 'Export Complete' }).last())
    .toBeVisible({ timeout: 20_000 });
  let mtl: string | null = null;
  try { mtl = readFileSync(join(outDir, `${name}.mtl`), 'utf8'); } catch { /* no materials */ }
  return { obj: readFileSync(objPath, 'utf8'), mtl };
}

/** Per group: the bounding box min corner of its faces' vertices, and the material each face uses. */
function parseGroups(obj: string): Map<string, { min: number[]; faces: number; materials: Set<string> }> {
  const verts: number[][] = [];
  const out = new Map<string, { min: number[]; faces: number; materials: Set<string> }>();
  let group = '';
  let mat = '';
  for (const line of obj.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'v') verts.push(p.slice(1, 4).map(Number));
    else if (p[0] === 'g') group = p.slice(1).join(' ');
    else if (p[0] === 'usemtl') mat = p[1];
    else if (p[0] === 'f') {
      let g = out.get(group);
      if (!g) { g = { min: [Infinity, Infinity, Infinity], faces: 0, materials: new Set() }; out.set(group, g); }
      g.faces++;
      g.materials.add(mat);
      for (const tok of p.slice(1)) {
        const v = verts[parseInt(tok.split('/')[0], 10) - 1];
        for (let k = 0; k < 3; k++) g.min[k] = Math.min(g.min[k], v[k]);
      }
    }
  }
  return out;
}

test('lists the groups and toggles each one\'s visibility', async () => {
  const { page } = session;
  await importGrouped(page);

  for (const name of ['cube_a', 'cube_b', 'cube_c']) {
    await expect(groupRow(page, name)).toHaveAttribute('data-triangle-count', '12');
    await expect(groupRow(page, name)).toHaveAttribute('data-visible', 'true');
  }

  await groupRow(page, 'cube_b').getByTestId('mesh-group-visibility').click();
  await expect(groupRow(page, 'cube_b')).toHaveAttribute('data-visible', 'false');
  // Only that group: the others and the mesh itself stay visible.
  await expect(groupRow(page, 'cube_a')).toHaveAttribute('data-visible', 'true');
  await expect(page.getByTestId('mesh-row')).toHaveAttribute('data-visible', 'true');

  await groupRow(page, 'cube_b').getByTestId('mesh-group-visibility').click();
  await expect(groupRow(page, 'cube_b')).toHaveAttribute('data-visible', 'true');

  // Collapses again.
  await page.getByTestId('mesh-groups-expand').click();
  await expect(page.getByTestId('mesh-group-list')).toHaveCount(0);
});

test('t moves only the selected group, and undo puts it back', async () => {
  const { page } = session;
  const meshRow = await importGrouped(page);

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Selecting a group deselects the mesh: the gesture is scoped to the group.
  await meshRow.getByTestId('mesh-row-name').click();
  await expect(meshRow).toHaveAttribute('data-selected', 'true');
  await groupRow(page, 'cube_a').click();
  await expect(groupRow(page, 'cube_a')).toHaveAttribute('data-selected', 'true');
  await expect(meshRow).toHaveAttribute('data-selected', 'false');
  await expect(page.getByTestId('mesh-group-actions')).toBeVisible();

  const hud = page.getByTestId('transform-hud');
  await page.keyboard.press('t');
  await expect(hud).toHaveAttribute('data-transform-op', 'translate');
  await page.keyboard.press('x');
  await page.keyboard.press('2');
  await page.keyboard.press('Enter');
  await expect(hud).toHaveCount(0);

  // The mesh itself did not move — the group's vertices did.
  await expect(meshRow).toHaveAttribute('data-mesh-position', '0.00,0.00,0.00');
  const moved = parseGroups((await exportObj(page, 'moved')).obj);
  expect([...moved.keys()].sort()).toEqual(['cube_a', 'cube_b', 'cube_c']);
  expect(moved.get('cube_a')!.min).toEqual([2, 0, 0]);
  expect(moved.get('cube_b')!.min).toEqual([3, 0, 0]);
  expect(moved.get('cube_c')!.min).toEqual([6, 0, 0]);
  expect(moved.get('cube_a')!.faces).toBe(12);

  await page.keyboard.press(UNDO);
  const restored = parseGroups((await exportObj(page, 'restored')).obj);
  expect(restored.get('cube_a')!.min).toEqual([0, 0, 0]);
  expect(restored.get('cube_b')!.min).toEqual([3, 0, 0]);
});

test('Escape cancels a group gesture without touching the vertices', async () => {
  const { page } = session;
  await importGrouped(page);
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  await groupRow(page, 'cube_c').click();
  const hud = page.getByTestId('transform-hud');
  await page.keyboard.press('s');
  await expect(hud).toHaveAttribute('data-transform-op', 'scale');
  await page.keyboard.press('3');
  await page.keyboard.press('Escape');
  await expect(hud).toHaveCount(0);

  const groups = parseGroups((await exportObj(page, 'canceled')).obj);
  expect(groups.get('cube_c')!.min).toEqual([6, 0, 0]);
});

test('Extract splits the selected group into its own mesh', async () => {
  const { page } = session;
  await importGrouped(page);

  await groupRow(page, 'cube_c').click();
  await page.getByTestId('mesh-group-extract').click();

  const rows = page.getByTestId('mesh-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-triangle-count', '24');
  await expect(rows.nth(1)).toHaveAttribute('data-triangle-count', '12');
  await expect(rows.nth(1)).toHaveAttribute('data-mesh-name', /cube_c/);
  // The source lists only what it kept.
  await expect(page.getByTestId('mesh-group-row')).toHaveCount(2);
  await expect(groupRow(page, 'cube_c')).toHaveCount(0);

  // One undo step puts the group back and removes the new mesh.
  await page.keyboard.press(UNDO);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-triangle-count', '36');
});

test('Delete removes the selected group after confirmation', async () => {
  const { page } = session;
  const meshRow = await importGrouped(page);

  await groupRow(page, 'cube_b').click();
  await page.getByTestId('mesh-group-delete').click();
  await expect(page.getByTestId('delete-confirm-title')).toHaveText(/Delete group\?/);
  await page.getByTestId('confirm-delete').click();

  await expect(meshRow).toHaveAttribute('data-triangle-count', '24');
  await expect(page.getByTestId('mesh-group-row')).toHaveCount(2);
  const groups = parseGroups((await exportObj(page, 'deleted')).obj);
  expect([...groups.keys()].sort()).toEqual(['cube_a', 'cube_c']);
});

test('Recolor paints only the group', async () => {
  const { page } = session;
  await importGrouped(page);

  await groupRow(page, 'cube_a').getByTestId('mesh-group-color-swatch').click();
  const popover = page.getByTestId('mesh-color-popover');
  await expect(popover).toHaveAttribute('data-target', 'group');
  await popover.locator('input[type="text"]').fill('#ff0000');
  await popover.getByRole('button', { name: 'Done' }).click();
  await expect(popover).toHaveCount(0);

  const { obj, mtl } = await exportObj(page, 'recolored');
  const groups = parseGroups(obj);
  expect(mtl).not.toBeNull();
  // Each material's Kd, by name.
  const kd = new Map<string, number[]>();
  let cur = '';
  for (const line of mtl!.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p[0] === 'newmtl') cur = p[1];
    else if (p[0] === 'Kd') kd.set(cur, p.slice(1, 4).map(Number));
  }
  const colorOf = (g: string) => [...groups.get(g)!.materials].map((m) => kd.get(m));
  expect(colorOf('cube_a')).toHaveLength(1);
  const [r, gg, b] = colorOf('cube_a')[0]!;
  expect(r).toBeGreaterThan(0.9);
  expect(gg).toBeLessThan(0.1);
  expect(b).toBeLessThan(0.1);
  // The other groups kept the mesh's own color, which is not red.
  for (const other of ['cube_b', 'cube_c']) {
    const [r2, g2, b2] = colorOf(other)[0]!;
    expect(r2 > 0.9 && g2 < 0.1 && b2 < 0.1).toBe(false);
  }
});
