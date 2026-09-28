import { test, expect, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers/launchApp';

// Plant-organ segmentation on an IN-MEMORY cloud (the renderer's flat path:
// `ps.hits` sent inline, both result columns scattered back to full length).
//
// Every import and every synthetic scan now becomes an octree session, so the
// app reaches this path only through a fallback: a synthetic scan whose session
// could not be built stays a plain in-memory cloud. The backend takes that
// fallback on purpose under PHYTOGRAPH_E2E_SCAN_WITHOUT_SESSION=1, which is why
// this spec launches its own app instead of sharing organ-segment.spec.ts's.
// Everything else is the live backend and the real UI.
//
// Misses: the fallback strips sky/miss rows from the in-memory arrays, so this
// cloud has none. That the flat path sends hits only is pinned at the source by
// src/renderer/components/missExclusionChokepoint.test.ts.

test.describe.configure({ timeout: 400_000 });

let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp({ PHYTOGRAPH_E2E_SCAN_WITHOUT_SESSION: '1' });
});
test.afterAll(async () => {
  await session?.close();
});

async function readResultToast(page: Page) {
  const toast = page.locator('[data-testid="toast-success"]').filter({ hasText: 'Plant Organ Segmentation Complete' }).last();
  await expect(toast).toBeVisible({ timeout: 180_000 });
  const text = (await toast.getByTestId('toast-message').textContent()) ?? '';
  const m = text.replace(/,/g, '').match(/(\d+) leaflets; (\d+) soil (\d+) stem (\d+) leaf points\. Read the cloud in (\w+)\./);
  expect(m, `unexpected toast: ${text}`).not.toBeNull();
  const [, leaflets, soil, stem, leaf, units] = m!;
  return { leaflets: +leaflets, soil: +soil, stem: +stem, leaf: +leaf, units };
}

test('labels an in-memory synthetic scan of a generated bean', async () => {
  const { page } = session;

  await page.getByTestId('tool-plant-generate').click();
  await expect(page.getByTestId('plant-generation-popup')).toBeVisible();
  await page.getByTestId('plant-species-select').selectOption('bean');
  await page.getByTestId('plant-age-input').fill('25');
  await page.getByTestId('plant-generate-button').click();
  await expect(page.getByTestId('mesh-row').first()).toBeVisible({ timeout: 120_000 });

  // A scanner 1 m above the plant base, sweeping a 40-degree downward cone
  // finely enough (0.2 degrees, ~3.5 mm at 1 m) for the model's 2 mm voxel.
  await page.getByTestId('tool-add-scan').click();
  await expect(page.getByTestId('scan-parameters-popup')).toBeVisible();
  await page.getByTestId('scan-label-input').fill('above');
  await page.getByTestId('scan-origin-x').fill('0');
  await page.getByTestId('scan-origin-y').fill('0');
  await page.getByTestId('scan-origin-z').fill('1');
  await page.getByTestId('scan-zenith-min').fill('140');
  await page.getByTestId('scan-zenith-max').fill('180');
  await page.getByTestId('scan-zenith-points').fill('200');
  await page.getByTestId('scan-azimuth-min').fill('0');
  await page.getByTestId('scan-azimuth-max').fill('360');
  await page.getByTestId('scan-azimuth-points').fill('720');
  await page.getByTestId('scan-submit').click();

  await page.getByTestId('run-synthetic-scan').click();
  await expect(page.getByTestId('synthetic-scan-options-popup')).toBeVisible();
  await page.getByTestId('scan-opt-run').click();

  const row = page.locator('[data-testid="scan-row"][data-scan-name="above"]');
  await expect(row).toHaveAttribute('data-has-data', 'true', { timeout: 180_000 });
  // Held in the renderer, not an octree session: this is the path under test.
  await expect(row).toHaveAttribute('data-octree', 'false');
  const total = parseInt((await row.getAttribute('data-point-count')) ?? '0', 10);

  // A row click TOGGLES selection, and the scanner row may already be the
  // selection once its scan lands: click only if it is not.
  if ((await row.getAttribute('data-selected')) !== 'true') await row.click();
  await expect(row).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('tool-organ-segment').click();
  await expect(page.getByTestId('organ-segment-panel')).toBeVisible();
  await page.getByTestId('organ-segment-run-button').click();

  const r = await readResultToast(page);
  console.log(`in-memory scan: ${total} points`, r);
  expect(r.units).toBe('metres');
  await expect(page.locator('[data-testid="toast-info"]')).toHaveCount(0);
  // Every point of the in-memory cloud was labelled, and only once.
  expect(r.soil + r.stem + r.leaf).toBe(total);
  // A bean from above with no ground in the scene: nearly all leaf, some
  // stem, next to no soil. Helios builds this 25-day bean with 95 leaflets
  // (PlantArchitecture.getPlantLeafObjectIDs); a single overhead view hides
  // some under others, and the model finds ~85.
  expect(r.leaf).toBeGreaterThan(0.7 * total);
  expect(r.stem).toBeGreaterThan(0);
  expect(r.soil).toBeLessThan(0.05 * total);
  expect(r.leaflets).toBeGreaterThanOrEqual(50);
  expect(r.leaflets).toBeLessThanOrEqual(115);

  // Both columns landed on the in-memory cloud, which is still in memory.
  const legend = page.getByTestId('class-legend');
  await expect(legend).toBeVisible({ timeout: 30_000 });
  await expect(legend).toHaveAttribute('data-legend-attribute', 'plant_organ');
  await page.getByRole('button', { name: 'Display' }).click();
  const colorMode = page.getByTestId('display-color-mode');
  await expect(colorMode).toHaveValue('scalar:plant_organ');
  await colorMode.selectOption('scalar:leaflet_id');
  await expect(colorMode).toHaveValue('scalar:leaflet_id');
  await expect(row).toHaveAttribute('data-octree', 'false');
  expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(total);
});
