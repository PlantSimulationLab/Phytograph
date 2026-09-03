import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// Zoom-to-cursor must keep working while a TOOL OVERLAY is on screen.
//
// The crop box draws a faint full-volume mesh (opacity 0.05) around the crop
// region. It is nearly invisible but fully raycastable, so the depth probe that
// drives zoom-to-cursor hit its front face before reaching the points inside it
// and anchored the camera there — zooming inside the crop preview converged on
// a flat plane in front of the data instead of on the cloud, which felt exactly
// like the pre-zoom-to-cursor behavior.
//
// The fix marks overlays (`SCENE_OVERLAY` in lib/sceneOverlay.ts) so the probe
// skips them. These tests pin that zoom behaves the SAME with the tool open as
// without it — the comparison is the assertion, so it can't be satisfied by a
// zoom that is broken in both cases.

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

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

const readState = () => session.page.evaluate(() => (window as any).__getCameraState());

async function loadFramedScene() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', FIXTURE);
  await completeImportWizard(page);
  await expect(
    page.locator('[data-testid="scan-row"][data-scan-name="tiny"]'),
  ).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(
    () => (window as any).__getCameraState?.()?.framedContent === true,
    { timeout: 20_000 },
  );
}

// Distance from the camera to the cloud's own centre — what "zoomed in" means
// to the user. Not |camera − target|, which a rigid zoom translation preserves.
function distToCloud(s: any): number {
  const c = [
    (s.bounds.min[0] + s.bounds.max[0]) / 2 - s.displayOffset[0],
    (s.bounds.min[1] + s.bounds.max[1]) / 2 - s.displayOffset[1],
    (s.bounds.min[2] + s.bounds.max[2]) / 2 - s.displayOffset[2],
  ];
  return Math.hypot(s.position[0] - c[0], s.position[1] - c[1], s.position[2] - c[2]);
}

// Scroll in over the viewport centre and report how much closer we got.
async function zoomInAtCentre(notches: number): Promise<number> {
  const { page } = session;
  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const before = await readState();
  const dBefore = distToCloud(before);

  await page.mouse.move(cx, cy);
  for (let i = 0; i < notches; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(250);

  const after = await readState();
  return dBefore / distToCloud(after);  // >1 means we got closer
}

test('zoom closes on the cloud just as well with the crop box on screen as without it', async () => {
  const { page } = session;
  await loadFramedScene();

  // Baseline: no tool open.
  const plainRatio = await zoomInAtCentre(12);
  expect(plainRatio).toBeGreaterThan(2);

  // Reset and repeat with the crop preview up.
  await resetToFreshScene(session.app, page);
  await loadFramedScene();

  await page.getByTestId('tool-crop').click();
  await expect(page.getByTestId('crop-panel')).toBeVisible();

  const cropRatio = await zoomInAtCentre(12);

  // The same gesture must close on the cloud by a comparable factor. Before the
  // fix the camera stalled against the crop box's front face, so this ratio
  // collapsed toward 1 while the baseline stayed above 2.
  expect(cropRatio).toBeGreaterThan(2);
  expect(cropRatio).toBeGreaterThan(plainRatio * 0.5);
});

test('the crop box does not become the zoom anchor: the camera ends up inside it', async () => {
  const { page } = session;
  await loadFramedScene();

  await page.getByTestId('tool-crop').click();
  await expect(page.getByTestId('crop-panel')).toBeVisible();

  const before = await readState();
  const dBefore = distToCloud(before);

  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 25; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(300);

  const after = await readState();
  const dAfter = distToCloud(after);

  // Deep inside the cloud's own extent — which is only reachable by passing
  // through where the crop box's near face sits. Anchoring on that face caps
  // the approach at the face's distance and this fails.
  const cloudSpan = Math.max(
    after.bounds.max[0] - after.bounds.min[0],
    after.bounds.max[1] - after.bounds.min[1],
    after.bounds.max[2] - after.bounds.min[2],
  );
  expect(dAfter).toBeLessThan(cloudSpan);
  expect(dAfter).toBeLessThan(dBefore * 0.2);
});

test('pan stays proportional to zoom depth inside the crop preview', async () => {
  const { page } = session;
  await loadFramedScene();

  await page.getByTestId('tool-crop').click();
  await expect(page.getByTestId('crop-panel')).toBeVisible();

  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const sample = async () => {
    const before = await readState();
    const subject = Math.hypot(
      before.position[0] - before.target[0],
      before.position[1] - before.target[1],
      before.position[2] - before.target[2],
    );
    const p0 = [...before.position];
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 100, cy, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(150);
    const after = await readState();
    const moved = Math.hypot(
      after.position[0] - p0[0],
      after.position[1] - p0[1],
      after.position[2] - p0[2],
    );
    return { subject, moved };
  };

  const wide = await sample();

  await page.mouse.move(cx, cy);
  for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(250);
  const close = await sample();

  // Genuinely closer, and the pan step shrank with it — the same proportionality
  // the tool-less case has, so opening crop doesn't restore the old
  // oversensitive panning.
  expect(close.subject).toBeLessThan(wide.subject * 0.5);
  expect(close.moved).toBeLessThan(wide.moved * 0.5);
});
