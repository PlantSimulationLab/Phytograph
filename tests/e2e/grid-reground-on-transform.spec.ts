import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// The ground grid re-grounds on a COMMITTED transform, and only then.
//
// The case that exposed it: a scan imported upside down, flipped 180 deg about X
// to fix its up-axis. The default pivot sits at ground level, so the flip swings
// the cloud DOWN through the floor. The grid used to stay latched to the import
// and was drawn across the top of the now-upright scan. Two things had to change
// for it to land underneath: the grid's bounds had to re-latch on the commit, and
// the cloud's ground level had to be recomputed from the moved points, because
// carrying the old ground point through the flip leaves it at the top.
//
// tiny.xyz is a vertical cylinder, r=0.3, h=1.5, base exactly at z=0.
const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
const HEIGHT = 1.5;

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

const row = () => session.page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
const viewer = () => session.page.locator('[data-grid-floor]');
const gridFloor = async () => parseFloat((await viewer().getAttribute('data-grid-floor'))!);

async function importTiny() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);
  await expect(row()).toBeVisible({ timeout: 30_000 });
  // A freshly imported scan is auto-selected; re-clicking would toggle it off.
  await expect(row()).toHaveAttribute('data-selected', 'true');
}

async function sceneOriginZ(): Promise<number> {
  const { page } = session;
  await page.getByTestId('tool-set-scene-origin').click();
  await expect(page.getByTestId('scene-origin-panel')).toBeVisible();
  const z = parseFloat(await page.getByTestId('scene-origin-input-z').inputValue());
  await page.getByTestId('scene-origin-close').click();
  return z;
}

const scanMinZ = async () => {
  const raw = await row().getAttribute('data-scan-bounds');
  if (!raw) throw new Error('scan row has no data-scan-bounds');
  return Number(raw.split(',')[2]);
};

test('flipping a scan upside down re-grounds the grid under it, not across its top', async () => {
  const { page } = session;
  await importTiny();

  // Baseline: the cylinder stands on z=0 and the grid sits there.
  await expect.poll(gridFloor).toBeCloseTo(0, 3);
  const originBefore = await sceneOriginZ();
  expect(Math.abs(originBefore)).toBeLessThan(0.05);

  await page.getByTestId('tool-cloud-translate').click();
  const panel = page.getByTestId('translate-panel');
  await expect(panel).toBeVisible();
  const input = page.getByTestId('rotation-input-x');
  await input.fill('180');
  await input.press('Enter');
  await expect(panel).toHaveAttribute('data-dirty', 'true');

  // A DRAFT must not move the grid: it holds still while the user is still
  // adjusting, and only a commit re-grounds it.
  expect(await gridFloor()).toBeCloseTo(0, 3);

  await page.getByTestId('translate-ok').click();
  await expect(panel).toHaveAttribute('data-dirty', 'false', { timeout: 120_000 });
  await expect(panel).toHaveAttribute('data-applying', 'false');
  await page.getByTestId('translate-cancel').click();
  await expect(panel).toBeHidden();

  // The cloud really did swing down through the floor: it now spans [-1.5, 0].
  await expect.poll(scanMinZ).toBeCloseTo(-HEIGHT, 2);

  // THE assertion: the grid moved to the new bottom. Before the fix it stayed at
  // 0, the old floor, which is now the top of the cylinder.
  await expect.poll(gridFloor, { timeout: 10_000 }).toBeCloseTo(-HEIGHT, 2);

  // The scene origin (the rotation pivot) deliberately does NOT follow: moving
  // it would make a second rotation turn about a different point.
  expect(await sceneOriginZ()).toBeCloseTo(originBefore, 3);
});

test('a translation commit carries the grid with the scan', async () => {
  // Control on the other kind of transform, and on the zero snap: lifting the
  // cylinder 10 m puts its ground far from 0, so the grid must follow it there
  // rather than stay snapped to the origin.
  const { page } = session;
  await importTiny();
  await expect.poll(gridFloor).toBeCloseTo(0, 3);

  await page.getByTestId('tool-cloud-translate').click();
  const panel = page.getByTestId('translate-panel');
  await expect(panel).toBeVisible();
  const input = page.getByTestId('translate-input-z');
  await input.fill('10');
  await input.press('Enter');
  expect(await gridFloor()).toBeCloseTo(0, 3);

  await page.getByTestId('translate-ok').click();
  await expect(panel).toHaveAttribute('data-dirty', 'false', { timeout: 120_000 });
  await expect(panel).toHaveAttribute('data-applying', 'false');
  await page.getByTestId('translate-cancel').click();
  await expect(panel).toBeHidden();

  await expect.poll(scanMinZ).toBeCloseTo(10, 2);
  await expect.poll(gridFloor, { timeout: 10_000 }).toBeCloseTo(10, 2);
});
