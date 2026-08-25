import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { resetToFreshScene } from './helpers/resetApp';

// The scene origin's relationship to SCANNER positions, both directions:
//
//   1. Import seeds it. A scan project knows where its instrument stood, and on
//      the first import into a blank scene the centroid of those stations is a
//      better pivot than the point cloud's bounding-box centre.
//   2. The panel snaps it. "Snap to scanner" moves the origin exactly onto one
//      chosen station.
//
// Plus the two things that must NOT happen: seeding a scene whose scans record
// no position (a plain XYZ import keeps the ground-anchored scene centre), and
// re-seeding when scans arrive later (that would yank the pivot, and the camera
// target with it, out from under a user mid-session).
//
// Shared session: one app + backend for the whole file; File → New between tests.

const TWO_STATION_XML = join(repoRoot, 'tests', 'e2e', 'fixtures', 'two-station-scan.xml');
const PLAIN_XYZ = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// two-station-scan.xml's <origin> tags, and their mean — the value the import
// seed must produce. Deliberately far from the point data (x ∈ [-0.3, 1.3],
// y ∈ [-0.3, 0.3], z ∈ [0, 1.5]), so no assertion here can pass by coincidence.
const STATION_A: [number, number, number] = [3, 1, 1.5];
const STATION_B: [number, number, number] = [5, 4, 1.5];
const STATION_MEAN: [number, number, number] = [4, 2.5, 1.5];

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

// Import the two-station Helios XML through the real Add Scan → Import XML
// route. Both referenced .xyz files sit alongside the XML, so they auto-attach
// and one wizard covers the pair.
// `expectedRows` is the TOTAL row count afterwards — the two stations plus
// whatever was already in the scene.
async function importTwoStationXml(expectedRows = 2): Promise<void> {
  const { app, page } = session;
  await stubOpenDialog(app, TWO_STATION_XML);
  await page.getByTestId('tool-add-scan').click();
  const popup = page.getByTestId('scan-parameters-popup');
  await expect(popup).toBeVisible();
  await page.getByTestId('scan-import-xml').click();
  await expect(popup).not.toBeVisible({ timeout: 20_000 });
  await completeImportWizard(page);
  await expect(page.getByTestId('scans-panel').locator('[data-testid="scan-row"]'))
    .toHaveCount(expectedRows, { timeout: 30_000 });
}

async function openOriginPanel() {
  const { page } = session;
  await page.getByTestId('tool-set-scene-origin').click();
  const panel = page.getByTestId('scene-origin-panel');
  await expect(panel).toBeVisible();
  return panel;
}

// The origin as the panel's three fields report it — the actual user-visible
// value, not viewer internals.
async function readOrigin(): Promise<[number, number, number]> {
  const { page } = session;
  const [x, y, z] = await Promise.all(
    (['x', 'y', 'z'] as const).map(async (a) =>
      parseFloat(await page.getByTestId(`scene-origin-input-${a}`).inputValue())),
  );
  return [x, y, z];
}

function expectClose(actual: number[], expected: number[], tol = 0.01) {
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(actual[i] - expected[i])).toBeLessThan(tol);
  }
}

test('the first import seeds the origin at the mean of the scanner positions', async () => {
  const { page } = session;
  await importTwoStationXml();

  const panel = await openOriginPanel();
  // Sourced from the scans, not from the user and not from the bounds default.
  await expect(panel).toHaveAttribute('data-origin-source', 'scanners');
  await expect(page.getByTestId('scene-origin-source-note')).toBeVisible();
  expectClose(await readOrigin(), STATION_MEAN);

  // Not vacuous: the scene centre the origin would otherwise take is metres
  // away in every axis (the stations pull the bounding box out around a
  // 1.6 m-wide cylinder pair sitting on z = 0).
  const viewer = page.locator('[data-scene-bounds-size]');
  const sceneCenter = (await viewer.getAttribute('data-scene-center'))!.split(',').map(parseFloat);
  expect(Math.abs(sceneCenter[0] - STATION_MEAN[0])).toBeGreaterThan(1);
  expect(Math.abs(sceneCenter[1] - STATION_MEAN[1])).toBeGreaterThan(0.5);

  // Reset is offered against the seed (it is not the plain default) and lands
  // on the scene centre at ground level.
  const reset = page.getByTestId('scene-origin-clear');
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect(panel).toHaveAttribute('data-origin-source', 'default');
  const afterReset = await readOrigin();
  expectClose(afterReset.slice(0, 2), sceneCenter.slice(0, 2), 0.15);
  const sceneMinZ = parseFloat((await viewer.getAttribute('data-scene-min-z'))!);
  expect(Math.abs(afterReset[2] - sceneMinZ)).toBeLessThan(0.15);
  // …which is a different place from the seed, or the reset proved nothing.
  expect(Math.abs(afterReset[2] - STATION_MEAN[2])).toBeGreaterThan(1);
});

test('Snap to scanner puts the origin exactly on the chosen station', async () => {
  const { page } = session;
  await importTwoStationXml();

  const panel = await openOriginPanel();
  const select = page.getByTestId('scene-origin-scanner-select');
  await expect(select).toBeEnabled();
  // One entry per station, in scans-panel order.
  await expect(select.locator('option')).toHaveCount(2);

  const rows = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
  const rowOrigin = async (i: number) =>
    (await rows.nth(i).getAttribute('data-scan-origin'))!.split(',').map(parseFloat);
  // The rows agree with the fixture, so the row attribute is a sound reference
  // for what the snap should produce.
  expectClose(await rowOrigin(0), STATION_A);
  expectClose(await rowOrigin(1), STATION_B);

  // Default target is the first station…
  await page.getByTestId('scene-origin-to-scanner').click();
  await expect(panel).toHaveAttribute('data-origin-source', 'user');
  expectClose(await readOrigin(), STATION_A, 1e-3);

  // …and picking the second station snaps onto it instead.
  const optionValues = await select.locator('option').evaluateAll(
    (opts) => opts.map((o) => (o as HTMLOptionElement).value));
  await select.selectOption(optionValues[1]);
  await page.getByTestId('scene-origin-to-scanner').click();
  expectClose(await readOrigin(), STATION_B, 1e-3);

  // Reset still returns to the scene default from a snapped origin.
  await page.getByTestId('scene-origin-clear').click();
  await expect(panel).toHaveAttribute('data-origin-source', 'default');
  expect(Math.abs((await readOrigin())[0] - STATION_B[0])).toBeGreaterThan(1);
});

test('a scene with no recorded scanner positions keeps the default and disables the snap', async () => {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', PLAIN_XYZ);
  await completeImportWizard(page);
  await expect(page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]'))
    .toBeVisible({ timeout: 30_000 });

  const panel = await openOriginPanel();
  // A plain XYZ records no pose, so there is nothing to seed from…
  await expect(panel).toHaveAttribute('data-origin-source', 'default');
  await expect(page.getByTestId('scene-origin-source-note')).toHaveCount(0);
  // …and nothing to snap to.
  await expect(page.getByTestId('scene-origin-scanner-select')).toBeDisabled();
  await expect(page.getByTestId('scene-origin-to-scanner')).toBeDisabled();
});

test('scans imported into a populated scene do not move the origin', async () => {
  const { app, page } = session;
  // A plain cloud first: the scene is no longer blank, and the origin is the
  // ordinary scene-centre default.
  await importFiles(app, page, 'import-auto', PLAIN_XYZ);
  await completeImportWizard(page);
  await expect(page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]'))
    .toBeVisible({ timeout: 30_000 });

  const panel = await openOriginPanel();
  await expect(panel).toHaveAttribute('data-origin-source', 'default');

  // Now bring in the two stations. Their positions become snappable, but the
  // seed must not fire a second time.
  await importTwoStationXml(3);

  await expect(panel).toHaveAttribute('data-origin-source', 'default');
  // Still the scene-centre default — which legitimately shifts as the scene
  // grows, so what is asserted is that it did NOT land on the station mean.
  const after = await readOrigin();
  expect(Math.abs(after[2] - STATION_MEAN[2])).toBeGreaterThan(1);
  expect(Math.abs(after[0] - STATION_MEAN[0])).toBeGreaterThan(1);
  await expect(page.getByTestId('scene-origin-scanner-select')).toBeEnabled();
  await expect(page.getByTestId('scene-origin-scanner-select').locator('option')).toHaveCount(2);
});
