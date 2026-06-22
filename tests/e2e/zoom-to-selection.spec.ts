import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// Two viewer-camera behaviors, both regressions we fixed:
//
//  1. Zoom to Selection must UNION every selected object, not short-circuit. It
//     used to return on the first non-empty selection type and only ever read
//     the FIRST selected mesh, so a multi-object selection framed just one piece
//     — e.g. a small object alongside a large one zoomed way in on the small one.
//
//  2. The Snap View buttons (Top/Front/Iso…) must REORIENT only — rotate to the
//     axis while preserving the current orbit target and zoom — not reframe to
//     the selection. They used to call snapToView(dir, selectionTarget), which
//     re-zoomed onto whatever was selected.
//
// Per CLAUDE.md E2E rules: live backend, drive the real UI (file chooser, list
// rows, toolbar buttons), assert concrete numbers (camera target + distance).
//
// Fixtures are sized so the three possible frames are an order of magnitude
// apart, making a regression unmissable:
//   - cube-mesh.ply     : a 1 m cube at the origin     (0,0,0)..(1,1,1)
//   - big-cube-mesh.ply : a 10 m cube far from origin  (20,20,20)..(30,30,30)
// Frame-the-small-mesh distance ≈ maxDim 1 × 2 = 2; frame-the-UNION distance ≈
// maxDim 30 × 2 = 60. The union center is (15,15,15); the small cube's is ~0.5.
const SMALL_MESH = join(repoRoot, 'tests', 'e2e', 'fixtures', 'cube-mesh.ply');
const BIG_MESH = join(repoRoot, 'tests', 'e2e', 'fixtures', 'big-cube-mesh.ply');
// Two clouds (separate scans) for the multi-cloud union case.
const CLOUD = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
const FAR_CLOUD = join(repoRoot, 'tests', 'e2e', 'fixtures', 'large-extent.xyz');

const dist = (p: number[], t: number[]) =>
  Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);

async function waitForCameraHooks(page: Page) {
  await page.waitForFunction(
    () => typeof (window as any).__orientToAxis === 'function'
      && typeof (window as any).__getCameraState === 'function',
    { timeout: 20_000 },
  );
}

test('Zoom to Selection frames the UNION of multiple selected meshes, not just the first', async () => {
  const { app, page, close } = await launchApp();

  try {
    // Import the small cube, then the big far cube. Both land as mesh rows (PLY
    // with faces routes straight to a mesh — no wizard).
    await importFiles(app, page, 'import-auto', SMALL_MESH);
    const smallRow = page.locator('[data-testid="mesh-row"][data-mesh-name="cube-mesh"]');
    await expect(smallRow).toBeVisible({ timeout: 30_000 });

    await importFiles(app, page, 'import-auto', BIG_MESH);
    const bigRow = page.locator('[data-testid="mesh-row"][data-mesh-name="big-cube-mesh"]');
    await expect(bigRow).toBeVisible({ timeout: 30_000 });
    await waitForCameraHooks(page);

    // Select the small cube, then ADD the big one (Ctrl/Cmd-click is additive for
    // meshes — see handleSelectMesh). Both must end selected.
    await smallRow.click();
    await expect(smallRow).toHaveAttribute('data-selected', 'true');
    await bigRow.click({ modifiers: ['ControlOrMeta'] });
    await expect(smallRow).toHaveAttribute('data-selected', 'true');
    await expect(bigRow).toHaveAttribute('data-selected', 'true');

    // Frame the selection through the real toolbar button.
    await page.getByTestId('zoom-to-selection').click();

    const cam = await page.evaluate(() => (window as any).__getCameraState());
    // Small/local coords → displayOffset is zero → target is the world center.
    expect(cam.displayOffset).toEqual([0, 0, 0]);

    // Target must be the UNION center (15,15,15) — NOT either single cube's center
    // (~0.5 or ~25). If the old "first mesh only" bug returned, target would be at
    // one cube and the distance would collapse onto that cube.
    expect(cam.target[0]).toBeGreaterThan(10);
    expect(cam.target[0]).toBeLessThan(20);
    expect(cam.target[1]).toBeGreaterThan(10);
    expect(cam.target[2]).toBeGreaterThan(10);

    // Distance reflects the 30 m union extent (≈ maxDim 30 × 2 = 60), far past the
    // ≈2 of framing only the 1 m cube.
    expect(dist(cam.position, cam.target)).toBeGreaterThan(30);
  } finally {
    await close();
  }
});

test('Zoom to Selection frames the UNION of multiple selected clouds', async () => {
  // The cloud branch of getSnapViewTarget already unioned within a single type;
  // this guards that the loop-everything rewrite didn't regress it.
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', CLOUD);
    await completeImportWizard(page);
    const nearRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(nearRow).toBeVisible({ timeout: 30_000 });

    await importFiles(app, page, 'import-auto', FAR_CLOUD);
    await completeImportWizard(page);
    const farRow = page.locator('[data-testid="scan-row"][data-scan-name="large-extent.xyz"]');
    await expect(farRow).toBeVisible({ timeout: 30_000 });
    await expect(farRow).toHaveAttribute('data-point-count', '64');
    await waitForCameraHooks(page);

    // Select the near cloud, then ADD the far one (Ctrl/Cmd-click is additive).
    await nearRow.click();
    await expect(nearRow).toHaveAttribute('data-selected', 'true');
    await farRow.click({ modifiers: ['ControlOrMeta'] });
    await expect(nearRow).toHaveAttribute('data-selected', 'true');
    await expect(farRow).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('zoom-to-selection').click();

    const cam = await page.evaluate(() => (window as any).__getCameraState());
    // tiny.xyz sits near the origin; large-extent spans (10..40). The union must
    // reach out to ~40, so the camera sits well back from the origin.
    expect(cam.target[0]).toBeGreaterThan(5);
    expect(dist(cam.position, cam.target)).toBeGreaterThan(20);
  } finally {
    await close();
  }
});

test('Zoom to Selection of only the small mesh frames it tightly (control)', async () => {
  // Counterpart to the union test: with ONLY the small cube selected, the frame
  // really is tight — so the union test's large distance is the union working,
  // not the framing math always zooming out.
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', SMALL_MESH);
    const smallRow = page.locator('[data-testid="mesh-row"][data-mesh-name="cube-mesh"]');
    await expect(smallRow).toBeVisible({ timeout: 30_000 });
    await importFiles(app, page, 'import-auto', BIG_MESH);
    const bigRow = page.locator('[data-testid="mesh-row"][data-mesh-name="big-cube-mesh"]');
    await expect(bigRow).toBeVisible({ timeout: 30_000 });
    await waitForCameraHooks(page);

    // Select only the small cube (plain click — no modifier).
    await smallRow.click();
    await expect(smallRow).toHaveAttribute('data-selected', 'true');
    await expect(bigRow).toHaveAttribute('data-selected', 'false');

    await page.getByTestId('zoom-to-selection').click();

    const cam = await page.evaluate(() => (window as any).__getCameraState());
    // Target is the small cube's center (~0.5,0.5,0.5); frame is tight (≈2 m).
    expect(cam.target[0]).toBeLessThan(5);
    expect(cam.target[1]).toBeLessThan(5);
    expect(dist(cam.position, cam.target)).toBeLessThan(10);
  } finally {
    await close();
  }
});

test('Snap View buttons reorient without changing target or zoom', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', SMALL_MESH);
    const smallRow = page.locator('[data-testid="mesh-row"][data-mesh-name="cube-mesh"]');
    await expect(smallRow).toBeVisible({ timeout: 30_000 });
    await importFiles(app, page, 'import-auto', BIG_MESH);
    const bigRow = page.locator('[data-testid="mesh-row"][data-mesh-name="big-cube-mesh"]');
    await expect(bigRow).toBeVisible({ timeout: 30_000 });
    await waitForCameraHooks(page);

    // Select ONLY the small cube. The Snap View buttons must IGNORE this selection
    // — they reorient around wherever the camera currently looks, not reframe the
    // 1 m cube (which is the regression we're guarding against).
    await smallRow.click();
    await expect(smallRow).toHaveAttribute('data-selected', 'true');

    const before = await page.evaluate(() => (window as any).__getCameraState());
    const radiusBefore = dist(before.position, before.target);
    const targetBefore = [...before.target];
    expect(radiusBefore).toBeGreaterThan(0);

    const check = async (title: string, expectSide: (cam: any) => void) => {
      await page.locator(`button[title="${title}"]`).click();
      const cam = await page.evaluate(() => (window as any).__getCameraState());
      // Target preserved (NOT snapped onto the cube center).
      expect(Math.abs(cam.target[0] - targetBefore[0])).toBeLessThan(1e-3);
      expect(Math.abs(cam.target[1] - targetBefore[1])).toBeLessThan(1e-3);
      expect(Math.abs(cam.target[2] - targetBefore[2])).toBeLessThan(1e-3);
      // Zoom (camera→target distance) preserved.
      expect(dist(cam.position, cam.target)).toBeCloseTo(radiusBefore, 3);
      expectSide(cam);
    };

    await check('Top View', (cam) => {
      // Looking down +Z: camera above the target, X/Y aligned.
      expect(cam.position[2]).toBeGreaterThan(cam.target[2]);
      expect(Math.abs(cam.position[0] - cam.target[0])).toBeLessThan(1e-2);
      expect(Math.abs(cam.position[1] - cam.target[1])).toBeLessThan(1e-2);
    });

    await check('Front View', (cam) => {
      // Looking along -Y: camera on the -Y side, Z-up.
      expect(cam.position[1]).toBeLessThan(cam.target[1]);
      expect(cam.up[2]).toBeCloseTo(1, 4);
    });

    await check('Right View', (cam) => {
      // Looking along +X: camera on the +X side.
      expect(cam.position[0]).toBeGreaterThan(cam.target[0]);
      expect(cam.up[2]).toBeCloseTo(1, 4);
    });
  } finally {
    await close();
  }
});
