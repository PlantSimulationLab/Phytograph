import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// With nothing happening the viewer must stop redrawing the whole point budget
// at the display rate, and it must come straight back when something happens.
let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});

const frames = () => session.page.evaluate(() => (window as any).__renderFrames as number);
const isIdle = () => session.page.evaluate(() => (window as any).__renderIdle as boolean);

async function framesOver(ms: number, during?: () => Promise<void>) {
  const before = await frames();
  if (during) await during();
  else await new Promise((resolve) => { setTimeout(resolve, ms); });
  return (await frames()) - before;
}

async function settle() {
  await expect.poll(isIdle, { timeout: 30_000, message: 'the render loop should go idle' }).toBe(true);
}

test('an idle viewer ticks slowly and wakes on activity', async () => {
  test.setTimeout(2 * 60_000);
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);
  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(row).toHaveAttribute('data-point-count', '60', { timeout: 20_000 });

  // Idle: about 1 frame a second, and not zero, since that tick is what shows a
  // scene change nothing reported.
  await settle();
  const idleFrames = await framesOver(3000);
  expect(idleFrames).toBeLessThanOrEqual(6);
  expect(idleFrames).toBeGreaterThanOrEqual(1);

  // Pointer input wakes it at once.
  const box = (await page.locator('canvas').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(isIdle, { timeout: 1000, message: 'pointer input should wake the loop' }).toBe(false);
  const awakeFrames = await framesOver(1000);
  expect(awakeFrames).toBeGreaterThan(idleFrames);

  // Framing moves the camera directly, with no React render behind it. From the
  // native menu there is no DOM input either, so it has to report itself.
  await settle();
  await page.evaluate(() => (window as any).__zoomToSelection?.());
  await expect.poll(isIdle, { timeout: 5_000 }).toBe(false);

  // A React-only change wakes it too.
  await settle();
  await page.evaluate(() => (window as any).__openExportPanel?.());
  await expect.poll(isIdle, { timeout: 5_000 }).toBe(false);
});
