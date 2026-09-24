import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { resetToFreshScene } from './helpers/resetApp';

// QSM selection outline — the QSM twin of mesh-selection-outline.spec.ts.
// Selecting a QSM (from its panel row OR by clicking it in the viewport) must
// draw the same lime JFA outline meshes get, a viewport click must highlight the
// panel row, and clicking empty space must clear both.
//
// The fixture's trunk runs straight up the Z axis from (0,0,0) to (0,0,2.5) with
// no world shift, so (0,0,1) is guaranteed to be on the tube. None of the rank
// colors pass the lime test (the only green, rank 3 #2fcf6b, has red < 80).
const QSM_CSV = join(repoRoot, 'tests', 'e2e', 'fixtures', 'qsm-cylinders.csv');
const TRUNK_POINT: [number, number, number] = [0, 0, 1];

async function countLimePixels(page: Page, pngBuffer: Buffer): Promise<number> {
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

test.describe('QSM selection outline', () => {
  let session: LaunchedApp;

  test.beforeAll(async () => {
    session = await launchApp();
    await expect(session.page.getByTestId('backend-splash')).toBeHidden({ timeout: 90_000 });
  });
  test.afterAll(async () => {
    await session?.close();
  });
  test.beforeEach(async () => {
    await resetToFreshScene(session.app, session.page);
  });

  // Import the fixture QSM and frame it, leaving nothing selected.
  async function importAndFrameQsm() {
    const { app, page } = session;
    await importFiles(app, page, 'import-qsm', [QSM_CSV]);
    const row = page.getByTestId('qsm-row').first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.click();
    await expect(row).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('zoom-to-selection').click();
    await row.click(); // plain click on the sole selected row deselects it
    await expect(row).toHaveAttribute('data-selected', 'false');
    await page.waitForTimeout(800);
    return row;
  }

  // Move first so R3F has raycast the pixel before the press (see
  // viewport-pick.spec.ts clickViewport for why page.mouse.click is flaky here).
  async function clickViewport(x: number, y: number) {
    const { page } = session;
    await page.mouse.move(x, y);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.mouse.down();
    await page.mouse.up();
  }

  test('selecting a QSM row outlines it in the viewport', async () => {
    const { page } = session;
    const row = await importAndFrameQsm();
    const canvas = page.locator('canvas').first();

    expect(await countLimePixels(page, await canvas.screenshot())).toBeLessThan(50);

    await row.click();
    await expect(row).toHaveAttribute('data-selected', 'true');
    await page.waitForTimeout(800);
    expect(await countLimePixels(page, await canvas.screenshot())).toBeGreaterThan(300);

    await row.click();
    await expect(row).toHaveAttribute('data-selected', 'false');
    await page.waitForTimeout(800);
    expect(await countLimePixels(page, await canvas.screenshot())).toBeLessThan(50);
  });

  test('clicking a QSM in the viewport selects its row and outlines it; empty space clears', async () => {
    const { page } = session;
    const row = await importAndFrameQsm();
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no canvas');

    const pt = await page.evaluate((w) => (window as any).__worldToScreen?.(w) ?? null, TRUNK_POINT);
    if (!pt?.visible) throw new Error(`trunk point not on screen: ${JSON.stringify(pt)}`);

    await clickViewport(pt.x, pt.y);
    await expect(row).toHaveAttribute('data-selected', 'true');
    await page.waitForTimeout(800);
    expect(await countLimePixels(page, await canvas.screenshot())).toBeGreaterThan(300);

    await clickViewport(box.x + 10, box.y + 10);
    await expect(row).toHaveAttribute('data-selected', 'false');
    await page.waitForTimeout(800);
    expect(await countLimePixels(page, await canvas.screenshot())).toBeLessThan(50);
  });
});
