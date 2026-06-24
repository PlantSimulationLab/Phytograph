import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';

// Mesh selection outline (jump-flood / screen-space). Drives the real workflow:
// import a mesh, select it BY CLICKING IT IN THE VIEWPORT, and assert the lime
// outline actually renders (by counting lime pixels in a screenshot), then that
// clicking empty space deselects and the outline disappears.
//
// A BLUE sphere fixture is used on purpose: the outline color (#a3e635, lime)
// then can't be confused with the mesh fill, so a lime-pixel count is an
// unambiguous proof the outline is on screen.
const SPHERE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-mesh.ply');

// Count "lime" pixels (the outline color) in a PNG screenshot by decoding it in
// the browser (Node here has no image lib). Lime ≈ rgb(163,230,53): green
// dominant and bright, red mid, blue low.
async function countLimePixels(page: import('@playwright/test').Page, pngBuffer: Buffer): Promise<number> {
  const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;
  return page.evaluate(async (url) => {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(); img.src = url; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (g > 170 && g > r + 20 && g > b + 60 && r > 80 && r < 220 && b < 130) n++;
    }
    return n;
  }, dataUrl);
}

test('outlines a mesh selected by clicking it in the viewport', async () => {
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

    // Baseline (mesh imported but not selected): no lime outline.
    const baseline = await countLimePixels(page, await canvas.screenshot());
    expect(baseline).toBeLessThan(50);

    // Select by clicking the mesh in the VIEWPORT (center → on the sphere).
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(meshRow).toHaveAttribute('data-selected', 'true');
    await page.waitForTimeout(800);

    // Outline must now be on screen — a clear band of lime pixels.
    const selected = await countLimePixels(page, await canvas.screenshot());
    expect(selected).toBeGreaterThan(500);

    // Deselect by clicking empty space → outline disappears.
    await page.mouse.click(box.x + 10, box.y + 10);
    await expect(meshRow).toHaveAttribute('data-selected', 'false');
    await page.waitForTimeout(800);
    const deselected = await countLimePixels(page, await canvas.screenshot());
    expect(deselected).toBeLessThan(50);
  } finally {
    await close();
  }
});
