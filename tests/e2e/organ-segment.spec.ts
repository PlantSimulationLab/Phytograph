import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// Plant-organ segmentation (the bundled ML model) driven through the real UI
// against the live backend. Both fixtures come from
// backend-api/research/ml/organ_make_fixtures.py and neither was trained on:
//
// potted-tomato.xyz: a Helios synthetic 31-day tomato in a pot, from the
//   val_synth split, at 3 mm, in METERS. Its exact labels (not in the file):
//   38,559 soil, 3,205 stem and 18,981 leaf points, 112 leaflets. The model
//   gives 38,561 / 2,933 / 19,251 and 101 leaflets; the bounds below are set
//   around the TRUTH, wide enough for a retrained model, tight enough to fail
//   one that has lost the stems or merged the leaflets.
// sugar-beet-mm.xyz: a real Sugar4D plant (CC BY 4.0, see sugar-beet-mm.README.md; test split) in
//   MILLIMETERS, 5 hand-labeled leaves plus a crown of young leaves the
//   labelers never separated. The model finds 7 (the 5 and two young ones).
const TOMATO = join(repoRoot, 'tests', 'e2e', 'fixtures', 'potted-tomato.xyz');
const BEET_MM = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sugar-beet-mm.xyz');

// Import, the torch device probe and a CPU-only run share each test's budget;
// the toast wait alone may take minutes on a slow runner.
test.describe.configure({ timeout: 300_000 });

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

/** The success toast's counts: "N leaflets; S soil, T stem, L leaf points. Read the cloud in <units>." */
async function readResultToast(page: Page) {
  const toast = page.locator('[data-testid="toast-success"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText('Plant Organ Segmentation Complete', { timeout: 180_000 });
  const text = (await toast.getByTestId('toast-message').textContent()) ?? '';
  const m = text.replace(/,/g, '').match(/(\d+) leaflets; (\d+) soil (\d+) stem (\d+) leaf points\. Read the cloud in (\w+)\./);
  expect(m, `unexpected toast: ${text}`).not.toBeNull();
  const [, leaflets, soil, stem, leaf, units] = m!;
  return { leaflets: +leaflets, soil: +soil, stem: +stem, leaf: +leaf, units };
}

async function importOne(page: Page, path: string, name: string, points: number) {
  await importFiles(session.app, page, 'import-point-cloud', path);
  await completeImportWizard(page);
  const row = page.locator(`[data-testid="scan-row"][data-scan-name="${name}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-selected', 'true');
  expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(points);
  return row;
}

test('labels a potted tomato soil / stem / leaf and numbers its leaflets', async () => {
  const { page } = session;
  const row = await importOne(page, TOMATO, 'potted-tomato', 60745);

  await page.getByTestId('tool-organ-segment').click();
  await expect(page.getByTestId('organ-segment-panel')).toBeVisible();
  // Defaults: units read from the cloud's size, result colored by organ.
  await expect(page.getByTestId('organ-units')).toHaveValue('auto');
  await expect(page.getByTestId('organ-color-by')).toHaveValue('organ');
  // Where the model will run is torch's own answer, from the live backend.
  const pill = page.getByTestId('organ-ml-device');
  await expect(pill).toBeVisible({ timeout: 60_000 });
  expect(['cuda', 'mps', 'cpu']).toContain(await pill.getAttribute('data-device'));

  await page.getByTestId('organ-segment-run-button').click();
  const r = await readResultToast(page);
  expect(r.units).toBe('meters');
  expect(r.soil + r.stem + r.leaf).toBe(60745);
  expect(r.soil).toBeGreaterThan(36_500);   // truth 38,559
  expect(r.soil).toBeLessThan(40_500);
  expect(r.stem).toBeGreaterThan(2_000);    // truth 3,205
  expect(r.stem).toBeLessThan(4_500);
  expect(r.leaf).toBeGreaterThan(17_000);   // truth 18,981
  expect(r.leaf).toBeLessThan(21_000);
  expect(r.leaflets).toBeGreaterThanOrEqual(85);   // truth 112
  expect(r.leaflets).toBeLessThanOrEqual(135);
  await expect(page.getByTestId('organ-segment-panel')).toHaveCount(0);

  // Colored categorically by the organ column, with the three named classes.
  const legend = page.getByTestId('class-legend');
  await expect(legend).toBeVisible({ timeout: 30_000 });
  await expect(legend).toHaveAttribute('data-legend-attribute', 'plant_organ');
  for (const name of ['Soil', 'Stem', 'Leaf']) {
    await expect(legend.getByText(name, { exact: true })).toBeVisible();
  }

  // Both columns were written: the leaflet ids are a color mode of their own.
  await page.getByRole('button', { name: 'Display' }).click();
  const colorMode = page.getByTestId('display-color-mode');
  await row.click();
  await expect(colorMode).toHaveValue('scalar:plant_organ');
  await colorMode.selectOption('scalar:leaflet_id');
  await expect(colorMode).toHaveValue('scalar:leaflet_id');
  // Leaflet ids are nominal and ~100 of them, so like tree ids they draw no legend.
  await expect(page.getByTestId('class-legend')).toHaveCount(0);
  // Nothing was split off or removed.
  expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(60745);
});

test('reads a millimeter scan as millimeters and can color by leaflet', async () => {
  const { page } = session;
  const row = await importOne(page, BEET_MM, 'sugar-beet-mm', 11267);

  await page.getByTestId('tool-organ-segment').click();
  await expect(page.getByTestId('organ-segment-panel')).toBeVisible();
  // Non-default output: leave the cloud colored by leaflet.
  await page.getByTestId('organ-color-by').selectOption('leaflet');
  await page.getByTestId('organ-segment-run-button').click();

  const r = await readResultToast(page);
  // About 400 units across: a 0.4 m plant in millimeters, not a 400 m one in meters.
  expect(r.units).toBe('millimeters');
  expect(r.soil + r.stem + r.leaf).toBe(11267);
  expect(r.soil).toBeLessThan(200);          // Sugar4D has its soil removed
  expect(r.leaf).toBeGreaterThan(9_000);     // a beet is nearly all leaf
  expect(r.leaflets).toBeGreaterThanOrEqual(4);   // 5 labeled leaves + young ones
  expect(r.leaflets).toBeLessThanOrEqual(9);

  await page.getByRole('button', { name: 'Display' }).click();
  await row.click();
  await expect(page.getByTestId('display-color-mode')).toHaveValue('scalar:leaflet_id');
});

test('explicit meters on a millimeter scan warns that it is not plant-sized', async () => {
  const { page } = session;
  await importOne(page, BEET_MM, 'sugar-beet-mm', 11267);

  await page.getByTestId('tool-organ-segment').click();
  await page.getByTestId('organ-units').selectOption('m');
  await page.getByTestId('organ-segment-run-button').click();

  const r = await readResultToast(page);
  expect(r.units).toBe('meters');
  const info = page.locator('[data-testid="toast-info"]').last();
  await expect(info.getByTestId('toast-message')).toContainText('not the size of a plant', { timeout: 30_000 });
});

test('segments every selected scan, each on its own', async () => {
  const { page } = session;
  // Two different plants in two different units, so the summary has to name
  // each scan's units and each scan's leaflet count separately.
  const tomato = await importOne(page, TOMATO, 'potted-tomato', 60745);
  const beet = await importOne(page, BEET_MM, 'sugar-beet-mm', 11267);
  if ((await tomato.getAttribute('data-selected')) !== 'true') {
    await tomato.click({ modifiers: ['ControlOrMeta'] });
  }
  await expect(tomato).toHaveAttribute('data-selected', 'true');
  await expect(beet).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-organ-segment').click();
  await expect(page.getByTestId('organ-segment-panel')).toBeVisible();
  await expect(page.getByTestId('organ-multi-note')).toContainText('2 scans selected');
  const run = page.getByTestId('organ-segment-run-button');
  await expect(run).toHaveText('Segment 2 Scans');
  await page.getByTestId('organ-color-by').selectOption('leaflet');
  await run.click();

  const toast = page.locator('[data-testid="toast-success"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText('Plant Organ Segmentation Complete', { timeout: 240_000 });
  const text = ((await toast.getByTestId('toast-message').textContent()) ?? '').replace(/,/g, '');
  expect(text).toContain('Segmented 2 of 2 scans.');
  const tm = text.match(/potted-tomato[^:]*: (\d+) leaflets \(meters\)/);
  const bm = text.match(/sugar-beet-mm[^:]*: (\d+) leaflets \(millimeters\)/);
  expect(tm, `unexpected toast: ${text}`).not.toBeNull();
  expect(bm, `unexpected toast: ${text}`).not.toBeNull();
  // The same bounds as the single-scan tests: each plant was read on its own.
  expect(+tm![1]).toBeGreaterThanOrEqual(85);
  expect(+tm![1]).toBeLessThanOrEqual(135);
  expect(+bm![1]).toBeGreaterThanOrEqual(4);
  expect(+bm![1]).toBeLessThanOrEqual(9);
  await expect(page.getByTestId('organ-segment-panel')).toHaveCount(0);

  // Both clouds carry the columns and were left colored by leaflet.
  await page.getByRole('button', { name: 'Display' }).click();
  const colorMode = page.getByTestId('display-color-mode');
  for (const row of [tomato, beet]) {
    await row.click();
    await expect(row).toHaveAttribute('data-selected', 'true');
    await expect(colorMode).toHaveValue('scalar:leaflet_id');
    await colorMode.selectOption('scalar:plant_organ');
    await expect(colorMode).toHaveValue('scalar:plant_organ');
  }
});
