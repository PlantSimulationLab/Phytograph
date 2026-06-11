import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Regression: translating an octree-backed cloud did nothing on screen. Both the
// Translate gizmo and the Blender-style T-modal write the offset into React
// `editStates`, and the cloud's parent <group> carries `position={translation}`
// — but a PointCloudOctree is attached to the SCENE ROOT, not inside that group,
// so the group transform never reached it. The points stayed put while the
// bounds/gizmo moved. The fix sets the offset on the octree object itself.
//
// This test drives the real T-modal (the keyboard path the user reported) and
// asserts on the LIVE three.js object position (window.__octreePositions), which
// is exactly the surface the bug lived on — React state was already correct.
test('T-modal translate moves an octree cloud in the rendered scene', async () => {
  const { app, page, close } = await launchApp();

  try {
    // Import a cloud through the real file picker + wizard.
    await importFiles(app, page, 'import-auto', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    // Load-bearing: this must be an octree cloud, the path the bug affected.
    await expect(cloudRow).toHaveAttribute('data-octree', 'true');
    // Freshly imported scan is auto-selected, so the transform tools target it.
    // (No re-click — a plain click on the sole selection toggles it off.)
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Wait for the octree to actually stream in and register its position hook.
    await page.waitForFunction(() => {
      const reg = (window as any).__octreePositions;
      return reg && Object.keys(reg).length === 1;
    }, { timeout: 20_000 });

    const readEntry = async () => page.evaluate(() => {
      const reg = (window as any).__octreePositions;
      return reg[Object.keys(reg)[0]] as {
        net: { x: number; y: number; z: number };
        world: { x: number; y: number; z: number };
      };
    });
    const readNet = async () => (await readEntry()).net;

    // Baseline: untranslated cloud has zero NET offset on top of its loader base.
    const before = await readEntry();
    expect(before.net).toEqual({ x: 0, y: 0, z: 0 });

    // Regression guard for the "corner slammed to the origin" bug: the fixture
    // cylinder is centered at (x,y)=(0,0) spanning [-0.3,0.3], so its min-corner
    // (the octree's world position) must sit at clearly-negative x/y — NOT at the
    // origin, which is what overwriting the loader's base offset produced.
    expect(before.world.x).toBeLessThan(-0.05);
    expect(before.world.y).toBeLessThan(-0.05);

    // Drive the T-modal exactly as a user would: hover the canvas (so the modal
    // has a mouse anchor), press T, lock the X axis, type an exact value, commit.
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    await page.keyboard.press('t');
    await expect(page.getByTestId('transform-hud')).toHaveAttribute('data-transform-op', 'translate');
    await page.keyboard.press('x');
    await expect(page.getByTestId('transform-hud')).toHaveAttribute('data-transform-axis', 'x');
    // Type a +5 offset along X, then commit with Enter.
    await page.keyboard.press('5');
    await page.keyboard.press('Enter');
    // HUD gone → modal committed.
    await expect(page.getByTestId('transform-hud')).toHaveCount(0);

    // The live octree object must have actually moved +5 in X (and only X),
    // measured as net offset on top of its (preserved) loader base position.
    await expect.poll(readNet, { timeout: 5_000 }).toEqual({ x: 5, y: 0, z: 0 });
  } finally {
    await close();
  }
});
