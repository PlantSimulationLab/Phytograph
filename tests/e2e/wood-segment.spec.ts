import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree_wood_leaf.xyz');
const FIXTURE2 = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree_wood_leaf2.xyz');

// tree_wood_leaf.xyz is a synthetic woody plant: a vertical trunk + two angled
// branches (1380 compact "wood" points) and 11 scattered leaf blobs (2860
// "leaf" points), shuffled in z. The default method (the ML model) calls ~900
// of its points wood and the geometric 'sota' method ~1250; the bounds below
// admit both. The 4th column is a ground-truth label, irrelevant to the
// workflow — segmentation computes its own `wood_class`.
//
// Drives the real DOM against the live backend: import (→ octree) → select →
// open the Wood/Leaf panel → run → assert the cloud is re-colored by the
// discrete `wood_class` attribute, and that the Split and Remove-wood output
// modes produce the expected child cloud / reduced point count.
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).

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

test('segments wood vs leaf and colors by the wood_class attribute', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(4240);
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  // Open the Wood/Leaf panel via its toolbar button.
  await page.getByTestId('tool-wood-segment').click();
  const panel = page.getByTestId('wood-segment-panel');
  await expect(panel).toBeVisible();

  // Split mode: also emit wood-only + leaf-only child clouds.
  await page.getByTestId('wood-mode').selectOption('split');
  await page.getByTestId('wood-segment-run-button').click();

  // The discrete class legend proves the cloud is colored categorically by
  // wood_class (wood vs leaf), not a continuous gradient or solid color.
  const legend = page.getByTestId('class-legend');
  await expect(legend).toBeVisible({ timeout: 60_000 });
  await expect(legend).toHaveAttribute('data-legend-attribute', 'wood_class');
  await expect(legend.getByText('Wood', { exact: true })).toBeVisible();
  await expect(legend.getByText('Leaf', { exact: true })).toBeVisible();

  // Split produced two child clouds. Their point counts should partition the
  // original (wood + leaf = 4240) with wood the minority — concrete output,
  // not "didn't error". Bounds allow for the classifier's real error rate.
  const woodRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf (wood)"]');
  const leafRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf (leaf)"]');
  await expect(woodRow).toBeVisible({ timeout: 60_000 });
  await expect(leafRow).toBeVisible({ timeout: 60_000 });
  const woodN = parseInt((await woodRow.getAttribute('data-point-count')) ?? '0', 10);
  const leafN = parseInt((await leafRow.getAttribute('data-point-count')) ?? '0', 10);
  expect(woodN + leafN).toBe(4240);
  // ~33% of points are wood; the classifier predicts a similar minority.
  expect(woodN).toBeGreaterThan(700);
  expect(woodN).toBeLessThan(2000);
  expect(leafN).toBeGreaterThan(woodN);

  // Splitting auto-hides the classified original: it still holds all 4240
  // points, so leaving it visible would draw the whole cloud on top of the two
  // halves just extracted from it. The children stay visible.
  await expect(cloudRow).toHaveAttribute('data-visible', 'false');
  await expect(woodRow).toHaveAttribute('data-visible', 'true');
  await expect(leafRow).toHaveAttribute('data-visible', 'true');
});

test('removes wood, leaving a leaf-only cloud', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');
  expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(4240);

  await page.getByTestId('tool-wood-segment').click();
  // Pinned to the geometric method: ML is the default and every other test
  // here exercises it, so this one keeps 'sota' (and its ground-removal
  // skeleton path) covered end to end.
  await page.getByTestId('wood-method').selectOption('sota');
  await page.getByTestId('wood-mode').selectOption('remove');
  await page.getByTestId('wood-segment-run-button').click();

  // Remove-wood replaces the cloud in place with just the leaf points: the
  // same row's point count drops to the leaf count (~2860, minus a few wood
  // points that bleed into leaf). Wood is the majority removed → a clear drop.
  await expect(async () => {
    const n = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(n).toBeGreaterThan(2200);   // kept the leaves
    expect(n).toBeLessThan(3600);      // dropped the wood
  }).toPass({ timeout: 60_000 });
});

test('segments two selected scans together and labels both', async () => {
  const { app, page } = session;

  // Import two distinct tree scans at once.
  await importFiles(app, page, 'import-point-cloud', [FIXTURE, FIXTURE2]);
  await completeImportWizard(page);

  const row1 = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf"]');
  const row2 = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf2"]');
  await expect(row1).toBeVisible({ timeout: 20_000 });
  await expect(row2).toBeVisible({ timeout: 20_000 });

  // Select both: click the first, then meta-click the second to add it.
  await row1.click();
  await row2.click({ modifiers: ['Meta'] });
  await expect(row1).toHaveAttribute('data-selected', 'true');
  await expect(row2).toHaveAttribute('data-selected', 'true');

  // Open the panel; with >1 scan selected the multi-mode chooser appears.
  await page.getByTestId('tool-wood-segment').click();
  await expect(page.getByTestId('wood-segment-panel')).toBeVisible();
  const multi = page.getByTestId('wood-multi-mode');
  await expect(multi).toBeVisible();
  await page.getByTestId('wood-mode-aggregate').check();

  await page.getByTestId('wood-segment-run-button').click();

  // Both scans should be labeled by wood_class (the discrete legend appears,
  // and neither scan was deleted — aggregate writes labels back in place).
  const legend = page.getByTestId('class-legend');
  await expect(legend).toBeVisible({ timeout: 60_000 });
  await expect(legend).toHaveAttribute('data-legend-attribute', 'wood_class');
  await expect(legend.getByText('Wood', { exact: true })).toBeVisible();
  await expect(legend.getByText('Leaf', { exact: true })).toBeVisible();
  // Both original scans survive with their original point counts (labeled,
  // not split or removed).
  expect(parseInt((await row1.getAttribute('data-point-count')) ?? '0', 10)).toBe(4240);
  expect(parseInt((await row2.getAttribute('data-point-count')) ?? '0', 10)).toBe(3360);
});

// A REAL tree, not the toy above: LeWoS tree 1 (tropical, hand-labeled,
// decimated to 50k points), shared with the backend's accuracy gates. The
// benchmark held it out of the model's training (backend-api/research/ml/
// corpus.py), so this is the shipped model on a tree it has never seen.
// Ground truth: 8188 wood / 41812 leaf. The model predicts ~6700 wood (OA
// 0.96); the bounds allow for seed-to-seed variation between model versions
// but fail a model that has lost the trunk (too little wood) or flooded the
// crown (too much).
const LEWOS_FIXTURE = join(repoRoot, 'backend-api', 'tests', 'fixtures', 'leafwood', 'lewos_tropical_small.xyz');

test('machine-learning method splits a real tree close to its hand labels', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', LEWOS_FIXTURE);
  await completeImportWizard(page);
  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="lewos_tropical_small"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(50000);

  await page.getByTestId('tool-wood-segment').click();
  await expect(page.getByTestId('wood-segment-panel')).toBeVisible();
  await page.getByTestId('wood-method').selectOption('ml');

  // The ML method has no geometric knobs, and reports where it will run: the
  // pill's device is torch's own answer, fetched from the live backend.
  await expect(page.getByTestId('wood-ml-controls')).toBeVisible();
  await expect(page.getByTestId('wood-bias')).toHaveCount(0);
  await expect(page.getByTestId('wood-kmax')).toHaveCount(0);
  const pill = page.getByTestId('wood-ml-device');
  await expect(pill).toBeVisible({ timeout: 60_000 });
  expect(['cuda', 'mps', 'cpu']).toContain(await pill.getAttribute('data-device'));

  await page.getByTestId('wood-mode').selectOption('split');
  await page.getByTestId('wood-segment-run-button').click();

  const woodRow = page.locator('[data-testid="scan-row"][data-scan-name="lewos_tropical_small (wood)"]');
  const leafRow = page.locator('[data-testid="scan-row"][data-scan-name="lewos_tropical_small (leaf)"]');
  await expect(woodRow).toBeVisible({ timeout: 180_000 });
  await expect(leafRow).toBeVisible({ timeout: 60_000 });
  const woodN = parseInt((await woodRow.getAttribute('data-point-count')) ?? '0', 10);
  const leafN = parseInt((await leafRow.getAttribute('data-point-count')) ?? '0', 10);
  expect(woodN + leafN).toBe(50000);
  expect(woodN).toBeGreaterThan(5500);
  expect(woodN).toBeLessThan(9500);
});

test('re-running the segmentation retires hand corrections to wood_class', async () => {
  // A re-run overwrites the whole column. Hand corrections still pending on it
  // were painted over the OLD result: the overlay kept drawing them over the
  // new one, and Undo reverse-applied their deltas onto the fresh labels.
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf"]');
  await expect(cloudRow).toHaveAttribute('data-point-count', '4240', { timeout: 20_000 });

  const segment = async () => {
    await page.getByTestId('tool-wood-segment').click();
    await expect(page.getByTestId('wood-segment-panel')).toBeVisible();
    await page.getByTestId('wood-method').selectOption('sota');
    await page.getByTestId('wood-mode').selectOption('label');
    await page.getByTestId('wood-segment-run-button').click();
    await expect(page.getByTestId('class-legend'))
      .toHaveAttribute('data-legend-attribute', 'wood_class', { timeout: 60_000 });
  };
  await segment();

  // Hand-correct: paint the WHOLE cloud as leaf on wood_class.
  await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
  await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));
  await page.getByTestId('tool-label').click();
  const panel = page.getByTestId('label-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('label-column-select').selectOption('wood_class');
  await expect(panel).toHaveAttribute('data-label-slug', 'wood_class');
  await panel.getByTestId('label-class-2').click();
  const overlay = page.getByTestId('crop-polygon-overlay');
  await expect(overlay.locator('circle')).toHaveCount(0, { timeout: 10_000 });
  const box = (await overlay.boundingBox())!;
  for (const [fx, fy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    await page.mouse.click(box.x + 8 + fx * (box.width - 16), box.y + 8 + fy * (box.height - 16));
  }
  await page.keyboard.press('Enter');
  await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 15_000 });
  const counts = async () => JSON.parse(
    (await panel.getAttribute('data-label-counts')) ?? '{}') as Record<string, number>;
  await expect.poll(async () => (await counts())['1'] ?? 0, { timeout: 15_000 }).toBe(0);
  await panel.getByRole('button', { name: 'Close' }).click();

  await segment();

  await page.getByTestId('tool-label').click();
  await expect(panel).toBeVisible();
  await page.getByTestId('label-column-select').selectOption('wood_class');
  await expect(panel).toHaveAttribute('data-label-slug', 'wood_class');
  // The stale correction is gone, and nothing on this column is undoable.
  await expect(panel).toHaveAttribute('data-pending-strokes', '0');
  await expect(page.getByTestId('label-undo')).toBeDisabled();
  // The counts are the NEW segmentation's: wood is back, a real minority.
  await expect.poll(async () => (await counts())['1'] ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(700);
});
