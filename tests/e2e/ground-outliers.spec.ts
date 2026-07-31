import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// "Ground" must survive a few erroneous returns below the terrain.
//
// The scene origin, the ground grid and the ground-plane pick target all used
// `bounds.min.z`, which is defined by a SINGLE point — so one bad low return
// (multipath, a bird, a scanner artefact) sank the whole ground reference by
// however far that point happened to be. Real scans carry a few of these.
//
// The fixture is a 3 m canopy over a flat ground slab at z≈0, plus 3 points
// ~12 m below it — 0.1% of the cloud, which is what noise actually looks like.
// The backend computes an outlier-resistant floor (a low Z percentile) once at
// import; this drives the whole chain through the real UI and asserts the ground
// lands on the terrain, not on the noise.
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'ground-outlier.xyz');

// From the fixture header: real ground is z ∈ [0, 0.05], the lowest noise point
// is at z = -12.4, and the canopy tops out at z = 3.
const REAL_GROUND_MAX = 0.05;
const NOISE_Z = -12.4;

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

async function importFixture() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', FIXTURE);
  await completeImportWizard(page);
  const row = page.locator('[data-testid="scan-row"][data-scan-name="ground-outlier.xyz"]');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => typeof (window as any).__getCameraState === 'function'
      && (window as any).__getCameraState()?.framedContent === true,
    { timeout: 30_000 },
  );
}

test('the scene origin lands on the real ground, not on points below it', async () => {
  const { page } = session;
  await importFixture();

  // Read the origin through the real Scene Origin panel.
  await page.getByTestId('tool-set-scene-origin').click();
  const panel = page.getByTestId('scene-origin-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-has-origin', 'false'); // the DEFAULT
  const originZ = parseFloat(
    (await page.getByTestId('scene-origin-input-z').inputValue()),
  );

  // The bounds minimum really is down at the noise — so this is not vacuous.
  const viewer = page.locator('[data-scene-bounds-size]');
  const boundsMinZ = parseFloat((await viewer.getAttribute('data-scene-min-z'))!);
  expect(boundsMinZ).toBeLessThan(-10);

  // The origin sits on the terrain instead.
  expect(originZ).toBeGreaterThan(NOISE_Z + 1);
  expect(originZ).toBeLessThanOrEqual(REAL_GROUND_MAX + 0.2);
  expect(originZ).toBeGreaterThanOrEqual(-0.2);

  await page.getByTestId('scene-origin-close').click();
});

test('the camera looks at the real ground, so the scene is not framed around the noise', async () => {
  const { page } = session;
  await importFixture();

  const state = await page.evaluate(() => (window as any).__getCameraState());
  const targetZWorld = state.target[2] + state.displayOffset[2];

  // The look-at follows the ground anchor. If it had used the raw minimum it
  // would sit ~12 m below the terrain, pointing the camera at empty space under
  // the scene with the actual content pushed to the top of the viewport.
  expect(targetZWorld).toBeGreaterThan(NOISE_Z + 1);
  expect(targetZWorld).toBeLessThanOrEqual(REAL_GROUND_MAX + 0.2);
});

test('a cloud with no sub-terrain noise is unaffected', async () => {
  // Control: the robust estimate must not shift the ground on a clean cloud —
  // otherwise the fix would be trading one wrong ground for another. tiny.xyz is
  // a clean vertical cylinder whose base sits exactly at z=0.
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz'));
  await completeImportWizard(page);
  await expect(
    page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]'),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('tool-set-scene-origin').click();
  await expect(page.getByTestId('scene-origin-panel')).toBeVisible();
  const originZ = parseFloat(await page.getByTestId('scene-origin-input-z').inputValue());

  // The true floor is 0; a clean cloud must land on it, not a percentile above it.
  expect(Math.abs(originZ)).toBeLessThan(0.05);

  await page.getByTestId('scene-origin-close').click();
});
