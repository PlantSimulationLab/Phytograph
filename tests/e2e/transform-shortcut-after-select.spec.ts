import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';

// Regression: the Blender-style t / s / r transform shortcuts used to no-op on
// the FIRST press after selecting an object, and only start working once the
// user jiggled the mouse.
//
// Cause: the keyboard-modal effect owned its cursor anchor as an effect-local
// `{ x, y, set: false }`, and the effect re-subscribes on every selection
// change. So the click that selects a mesh tore down the listener set that had
// just recorded the cursor and installed a fresh one with `set: false`;
// startModal bails when unset, silently. Any later mousemove re-armed it, which
// is why "move the mouse slightly, press t again" appeared to fix it.
//
// The anchor now lives in a ref that survives re-subscription, and mousedown
// records it too. This test therefore presses the shortcut with NO intervening
// page.mouse.move — every other transform test moves the mouse first, which is
// exactly why none of them caught this.
const SPHERE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-mesh.ply');

test('t/s/r open the transform modal on the first press after selecting a mesh', async () => {
  const { app, page, close } = await launchApp();
  try {
    await expect(page.getByTestId('backend-splash')).toBeHidden({ timeout: 90_000 });

    await importFiles(app, page, 'import-mesh', SPHERE);
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1500); // let the scene settle / auto-frame

    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no canvas');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Select the mesh by clicking it in the viewport. This is the event that
    // used to reset the anchor: the selection state change re-runs the effect.
    await page.mouse.click(cx, cy);
    await expect(meshRow).toHaveAttribute('data-selected', 'true');

    const hud = page.getByTestId('transform-hud');

    // FIRST press, no mouse movement in between — this is the whole point.
    await page.keyboard.press('t');
    await expect(hud).toHaveAttribute('data-transform-op', 'translate');
    await page.keyboard.press('Escape');
    await expect(hud).toHaveCount(0);

    // Escape cancels but doesn't change selection, so the effect doesn't
    // re-subscribe here; re-select to re-arm the original failure condition
    // before each of the remaining two shortcuts.
    await page.mouse.click(box.x + 10, box.y + 10);          // deselect
    await expect(meshRow).toHaveAttribute('data-selected', 'false');
    await page.mouse.click(cx, cy);                           // re-select
    await expect(meshRow).toHaveAttribute('data-selected', 'true');

    await page.keyboard.press('s');
    await expect(hud).toHaveAttribute('data-transform-op', 'scale');
    await page.keyboard.press('Escape');
    await expect(hud).toHaveCount(0);

    await page.mouse.click(box.x + 10, box.y + 10);
    await expect(meshRow).toHaveAttribute('data-selected', 'false');
    await page.mouse.click(cx, cy);
    await expect(meshRow).toHaveAttribute('data-selected', 'true');

    await page.keyboard.press('r');
    await expect(hud).toHaveAttribute('data-transform-op', 'rotate');
    await page.keyboard.press('Escape');
    await expect(hud).toHaveCount(0);
  } finally {
    await close();
  }
});
