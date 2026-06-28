import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launchApp } from './helpers/launchApp';

// When a Create Voxel Grid box is added it starts as a unit cube at the origin
// and the Transform panel opens so the user can dial in a real-world origin and
// size. The annoyance this guards: after editing the origin/scale far from the
// unit-cube-at-origin default, the viewport used to stay framed on the original
// (now empty) spot. We now re-frame the voxel box whenever its origin or scale
// is committed — and crucially the re-frame fires on the DebouncedNumberInput
// COMMIT (Enter / blur / debounce), never per keystroke.
//
// Per CLAUDE.md E2E rules: live backend, drive the real UI (toolbar button,
// transform-panel inputs), assert concrete numbers (camera target follows).

const dist = (p: number[], t: number[]) =>
  Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);

async function waitForCameraHooks(page: Page) {
  await page.waitForFunction(
    () => typeof (window as any).__getCameraState === 'function',
    { timeout: 20_000 },
  );
}

// Commit a DebouncedNumberInput by typing then pressing Enter (the explicit
// confirm path the user asked for). selectText first so we replace the default.
async function setField(page: Page, testId: string, value: string) {
  const input = page.getByTestId(testId);
  await input.click();
  await input.selectText();
  await input.fill(value);
  await input.press('Enter');
}

test('Editing a voxel grid origin re-frames the viewport on the new location', async () => {
  const { app, page, close } = await launchApp();

  try {
    // Create the voxel grid via the real toolbar command. It auto-selects the new
    // box and opens the Transform panel (handleCreateShape).
    await page.getByTestId('tool-create-voxel').click();
    await expect(page.getByTestId('mesh-pos-x')).toBeVisible({ timeout: 20_000 });
    await waitForCameraHooks(page);

    // Initial frame: a unit cube at the origin → camera target ~origin, tight zoom.
    // Give the create-time auto-frame a beat to settle.
    await expect.poll(async () => {
      const cam = await page.evaluate(() => (window as any).__getCameraState());
      return Math.hypot(...cam.target);
    }, { timeout: 5_000 }).toBeLessThan(5);

    const before = await page.evaluate(() => (window as any).__getCameraState());
    // Small coords → no display offset, target is world space directly.
    expect(before.displayOffset).toEqual([0, 0, 0]);

    // Move the grid origin far from the start (40,40,40). Each commit is on Enter.
    await setField(page, 'mesh-pos-x', '40');
    await setField(page, 'mesh-pos-y', '40');
    await setField(page, 'mesh-pos-z', '40');

    // The camera target must follow the box out to ~(40,40,40), not stay at origin.
    await expect.poll(async () => {
      const cam = await page.evaluate(() => (window as any).__getCameraState());
      return cam.target[0];
    }, { timeout: 5_000 }).toBeGreaterThan(30);

    const after = await page.evaluate(() => (window as any).__getCameraState());
    expect(after.target[1]).toBeGreaterThan(30);
    expect(after.target[2]).toBeGreaterThan(30);
    // It really moved — far from where it started.
    expect(dist(after.target, before.target)).toBeGreaterThan(30);
  } finally {
    await close();
  }
});

test('Editing a voxel grid scale re-frames so the larger box stays in view', async () => {
  const { app, page, close } = await launchApp();

  try {
    await page.getByTestId('tool-create-voxel').click();
    await expect(page.getByTestId('mesh-scale-x')).toBeVisible({ timeout: 20_000 });
    await waitForCameraHooks(page);

    await expect.poll(async () => {
      const cam = await page.evaluate(() => (window as any).__getCameraState());
      return dist(cam.position, cam.target);
    }, { timeout: 5_000 }).toBeLessThan(10);

    const before = await page.evaluate(() => (window as any).__getCameraState());
    const radiusBefore = dist(before.position, before.target);

    // Grow the box to 30 m on each axis. The frame distance must grow with it
    // (framing uses maxDim × 2), proving the scale commit re-framed.
    await setField(page, 'mesh-scale-x', '30');
    await setField(page, 'mesh-scale-y', '30');
    await setField(page, 'mesh-scale-z', '30');

    await expect.poll(async () => {
      const cam = await page.evaluate(() => (window as any).__getCameraState());
      return dist(cam.position, cam.target);
    }, { timeout: 5_000 }).toBeGreaterThan(radiusBefore * 3);
  } finally {
    await close();
  }
});
