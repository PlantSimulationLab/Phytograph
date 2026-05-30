import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// The viewport axes gizmo (bottom-left X/Y/Z widget) snaps the camera to look
// down a world axis when an axis head is clicked. Two regressions were fixed:
//
//   1. Wrong up-axis. This app is Z-up; drei's GizmoViewport interpolated with
//      a hardcoded Y-up basis, so clicking +X left you with +Y up (and +Y left
//      you with -Z up) instead of +Z up.
//   2. Zoom jump. drei recomputed the orbit radius from distance-to-origin
//      rather than distance-to-target, yanking the zoom on every click.
//
// The gizmo heads now call window.__orientToAxis (CameraController), which is
// what this test drives — through the real OrbitControls + camera — asserting
// a correct Z-up basis and an unchanged camera-to-target distance.
test('viewport gizmo orients down a world axis with Z-up and no zoom change', async () => {
  const { page, close } = await launchApp();

  try {
    // Import a cloud so the viewer mounts with real content and a framed camera.
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(FIXTURE);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });

    // Wait for the camera controller (and its window hooks) to be live.
    await page.waitForFunction(
      () => typeof (window as any).__orientToAxis === 'function'
        && typeof (window as any).__getCameraState === 'function',
      { timeout: 20_000 },
    );

    const dist = (p: number[], t: number[]) =>
      Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);

    // Helper: run orientToAxis for a world direction, then read camera + the
    // resulting up vector back out.
    const orient = async (axis: { x: number; y: number; z: number }) =>
      page.evaluate((a) => {
        (window as any).__orientToAxis(a);
        return (window as any).__getCameraState();
      }, axis);

    // Baseline distance before any gizmo interaction.
    const before = await page.evaluate(() => (window as any).__getCameraState());
    const radiusBefore = dist(before.position, before.target);
    expect(radiusBefore).toBeGreaterThan(0);

    // --- Click +X: should look down +X with +Z up, same distance. ---
    const px = await orient({ x: 1, y: 0, z: 0 });
    // Camera sits on the +X side of the target.
    expect(px.position[0]).toBeGreaterThan(px.target[0]);
    expect(Math.abs(px.position[1] - px.target[1])).toBeLessThan(1e-3);
    expect(Math.abs(px.position[2] - px.target[2])).toBeLessThan(1e-3);
    // Distance unchanged (no zoom jump).
    expect(dist(px.position, px.target)).toBeCloseTo(radiusBefore, 4);
    // Up is +Z.
    expect(px.up).not.toBeNull();
    expect(px.up[2]).toBeCloseTo(1, 5);

    // --- Click +Y: should look down +Y, still +Z up (the old bug gave -Z). ---
    const py = await orient({ x: 0, y: 1, z: 0 });
    expect(py.position[1]).toBeGreaterThan(py.target[1]);
    expect(dist(py.position, py.target)).toBeCloseTo(radiusBefore, 4);
    expect(py.up[2]).toBeCloseTo(1, 5);

    // --- Click +Z (top-down): looking along Z is degenerate, falls back to
    //     Y-up; distance still preserved. ---
    const pz = await orient({ x: 0, y: 0, z: 1 });
    expect(pz.position[2]).toBeGreaterThan(pz.target[2]);
    expect(dist(pz.position, pz.target)).toBeCloseTo(radiusBefore, 4);
    expect(pz.up[1]).toBeCloseTo(1, 5);
  } finally {
    await close();
  }
});
