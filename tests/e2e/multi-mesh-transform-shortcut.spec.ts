import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';

// Regression: with SEVERAL meshes selected, the Blender-style t / s / r
// shortcuts transformed only the FIRST one.
//
// Cause: the keyboard transform modal targeted `selectedMesh` — a memo that
// returns `Array.from(selectedMeshIds)[0]` — and its state carried a single
// `meshId`. So startModal captured one original, apply* wrote one entry, and
// cancelModal restored one. Every other mesh in the selection sat still. The
// multi-CLOUD translate beside it had always carried `cloudIds` + a per-id map
// of originals; meshes and skeletons now use the same shape.
//
// The gesture is driven through the modal's NUMERIC path (type a value, Enter)
// rather than a mouse drag, so the expected result is exact — a screen-space
// drag delta depends on the camera and can only be asserted as "changed".
//
// Two meshes of DIFFERENT sizes: scale multiplies each mesh's own captured
// baseline, so a shared-value bug (writing one mesh's result to both) shows up
// as identical numbers where the fixtures should keep their proportions.
const CUBE_PLY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'cube-mesh.ply');
const BIG_CUBE_PLY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'big-cube-mesh.ply');

const parseTriple = (s: string | null): [number, number, number] => {
  if (!s) throw new Error('missing transform attribute');
  const parts = s.split(',').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`bad triple: ${s}`);
  return [parts[0], parts[1], parts[2]];
};

test('t/s/r transform EVERY selected mesh, not just the first', async () => {
  const { app, page, close } = await launchApp();

  try {
    await expect(page.getByTestId('backend-splash')).toBeHidden({ timeout: 90_000 });
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await importFiles(app, page, 'import-mesh', [CUBE_PLY, BIG_CUBE_PLY]);
    const meshRows = page.getByTestId('mesh-row');
    await expect(meshRows).toHaveCount(2, { timeout: 60_000 });
    await page.waitForTimeout(1500); // let the scene settle / auto-frame

    const rowA = meshRows.nth(0);
    const rowB = meshRows.nth(1);

    // Anchor the cursor over the canvas: startModal bails when it has never
    // seen a pointer position (see transform-shortcut-after-select.spec.ts).
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no canvas');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    // Select BOTH meshes through the panel's real Select All button.
    await page.getByTestId('meshes-select-all').click();
    await expect(rowA).toHaveAttribute('data-selected', 'true');
    await expect(rowB).toHaveAttribute('data-selected', 'true');

    const hud = page.getByTestId('transform-hud');

    // ---- TRANSLATE: 3 units along X, both meshes ----------------------------
    const posA0 = parseTriple(await rowA.getAttribute('data-mesh-position'));
    const posB0 = parseTriple(await rowB.getAttribute('data-mesh-position'));

    await page.keyboard.press('t');
    await expect(hud).toHaveAttribute('data-transform-op', 'translate');
    await page.keyboard.press('x');                       // lock to X
    await expect(hud).toHaveAttribute('data-transform-axis', 'x');
    await page.keyboard.press('3');                       // numeric entry: 3 units
    await page.keyboard.press('Enter');
    await expect(hud).toHaveCount(0);

    const posA1 = parseTriple(await rowA.getAttribute('data-mesh-position'));
    const posB1 = parseTriple(await rowB.getAttribute('data-mesh-position'));
    // Each mesh moved by exactly +3 on X from ITS OWN baseline, and not on Y/Z.
    expect(posA1[0]).toBeCloseTo(posA0[0] + 3, 2);
    expect(posB1[0]).toBeCloseTo(posB0[0] + 3, 2);
    expect(posA1[1]).toBeCloseTo(posA0[1], 2);
    expect(posB1[1]).toBeCloseTo(posB0[1], 2);
    expect(posA1[2]).toBeCloseTo(posA0[2], 2);
    expect(posB1[2]).toBeCloseTo(posB0[2], 2);

    // ---- ROTATE: 45 degrees about Z, both meshes ----------------------------
    const rotA0 = parseTriple(await rowA.getAttribute('data-mesh-rotation'));
    const rotB0 = parseTriple(await rowB.getAttribute('data-mesh-rotation'));

    await page.keyboard.press('r');
    await expect(hud).toHaveAttribute('data-transform-op', 'rotate');
    await page.keyboard.press('z');
    await expect(hud).toHaveAttribute('data-transform-axis', 'z');
    await page.keyboard.press('4');
    await page.keyboard.press('5');
    await page.keyboard.press('Enter');
    await expect(hud).toHaveCount(0);

    const rotA1 = parseTriple(await rowA.getAttribute('data-mesh-rotation'));
    const rotB1 = parseTriple(await rowB.getAttribute('data-mesh-rotation'));
    expect(rotA1[2]).toBeCloseTo(rotA0[2] + 45, 1);
    expect(rotB1[2]).toBeCloseTo(rotB0[2] + 45, 1);

    // ---- SCALE: x2 uniform, both meshes -------------------------------------
    const sclA0 = parseTriple(await rowA.getAttribute('data-mesh-scale'));
    const sclB0 = parseTriple(await rowB.getAttribute('data-mesh-scale'));

    await page.keyboard.press('s');
    await expect(hud).toHaveAttribute('data-transform-op', 'scale');
    await page.keyboard.press('2');                       // free axis → uniform
    await page.keyboard.press('Enter');
    await expect(hud).toHaveCount(0);

    const sclA1 = parseTriple(await rowA.getAttribute('data-mesh-scale'));
    const sclB1 = parseTriple(await rowB.getAttribute('data-mesh-scale'));
    expect(sclA1[0]).toBeCloseTo(sclA0[0] * 2, 2);
    expect(sclB1[0]).toBeCloseTo(sclB0[0] * 2, 2);
    expect(sclA1[1]).toBeCloseTo(sclA0[1] * 2, 2);
    expect(sclB1[1]).toBeCloseTo(sclB0[1] * 2, 2);

    // ---- ESCAPE restores EVERY mesh, not just the first ----------------------
    // The cancel path had the same single-target shape as apply, so a partial
    // fix (apply to all, restore one) would leave mesh B displaced here.
    const posA2 = parseTriple(await rowA.getAttribute('data-mesh-position'));
    const posB2 = parseTriple(await rowB.getAttribute('data-mesh-position'));

    await page.keyboard.press('t');
    await expect(hud).toHaveAttribute('data-transform-op', 'translate');
    await page.keyboard.press('y');
    await page.keyboard.press('7');
    // Mid-gesture both have moved; Escape must put both back.
    await page.keyboard.press('Escape');
    await expect(hud).toHaveCount(0);

    expect(parseTriple(await rowA.getAttribute('data-mesh-position'))).toEqual(posA2);
    expect(parseTriple(await rowB.getAttribute('data-mesh-position'))).toEqual(posB2);
  } finally {
    await close();
  }
});
