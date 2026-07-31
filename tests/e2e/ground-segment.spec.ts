import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'ground_plants.xyz');

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

// ground_plants.xyz is a synthetic close-range scan: a flat 40×40 ground grid
// (1600 pts at z≈0) plus a raised plant blob (600 pts, z 0.12–0.8), shuffled.
// CSF separates these cleanly. The 4th column is a ground-truth label but is
// irrelevant to the workflow under test — segmentation computes its own
// `ground_class` and that's what we colour by.
//
// Drives the real DOM against the live backend: import (→ octree) → select →
// open Ground Segmentation panel → run CSF → assert the cloud is re-coloured by
// the discrete `ground_class` attribute (legend overlay appears, picker selects
// it) and the optional split produces ground + plant child clouds.
test('segments ground vs plant and colours by the ground_class attribute', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="ground_plants.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(2200);

  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  // Open the Ground Segmentation panel via its toolbar button.
  await page.getByTestId('tool-ground-segment').click();
  const panel = page.getByTestId('ground-segment-panel');
  await expect(panel).toBeVisible();

  // Use a cloth resolution suited to this fixture's scale, enable split.
  await page.getByTestId('ground-cloth-resolution').fill('0.1');
  await page.getByTestId('ground-class-threshold').fill('0.05');
  await page.getByTestId('ground-split-clouds').check();

  // Run segmentation. The backend re-converts the octree carrying ground_class.
  await page.getByTestId('ground-segment-run-button').click();

  // The discrete class legend overlay appears once ground_class is the active
  // scalar — proves the cloud is coloured categorically (ground vs plant),
  // not by a continuous gradient or a solid colour.
  const legend = page.getByTestId('class-legend');
  await expect(legend).toBeVisible({ timeout: 60_000 });
  // The legend's attribute + class swatches prove the cloud is coloured by a
  // discrete ground_class scalar (not a gradient or solid colour).
  await expect(legend).toHaveAttribute('data-legend-attribute', 'ground_class');
  await expect(legend.getByText('Ground', { exact: true })).toBeVisible();
  await expect(legend.getByText('Non-ground', { exact: true })).toBeVisible();

  // The split checkbox produced two child clouds with the original points
  // partitioned (1600 ground + 600 plant). Assert both rows exist with their
  // expected point counts — concrete output, not "didn't error".
  const groundRow = page.locator('[data-testid="scan-row"][data-scan-name="ground_plants.xyz (ground)"]');
  const plantRow = page.locator('[data-testid="scan-row"][data-scan-name="ground_plants.xyz (non-ground)"]');
  // Each split sub-cloud is a separate backend re-conversion, so allow time.
  await expect(groundRow).toBeVisible({ timeout: 60_000 });
  await expect(plantRow).toBeVisible({ timeout: 60_000 });
  expect(parseInt((await groundRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(1600);
  expect(parseInt((await plantRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(600);
});

// "Measure from the scan" derives the ground tolerance from the settled cloth
// instead of the seeded value (which scales with the cloud's horizontal extent —
// a quantity unrelated to how thick the ground return band is). Drives the real
// checkbox against the live backend and asserts on the concrete outcome: the
// tolerance field is disabled while auto is on, the run reports the measured
// value back into the panel, and the split still partitions 1600/600 — i.e. the
// measured tolerance actually separates this fixture correctly.
test('measures the ground tolerance from the scan when asked', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="ground_plants.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-ground-segment').click();
  await page.getByTestId('ground-cloth-resolution').fill('0.1');
  // Seed a deliberately WRONG tolerance: 0.001 m would leave almost nothing as
  // ground. Auto mode must override it and still split cleanly.
  await page.getByTestId('ground-class-threshold').fill('0.001');
  await page.getByTestId('ground-auto-class-threshold').check();
  // With auto on, the manual field is not editable — the value comes from the scan.
  await expect(page.getByTestId('ground-class-threshold')).toBeDisabled();
  await page.getByTestId('ground-split-clouds').check();

  await page.getByTestId('ground-segment-run-button').click();
  await expect(page.getByTestId('class-legend')).toBeVisible({ timeout: 60_000 });

  // The split proves the measured tolerance separated the fixture correctly:
  // the plant blob starts at z≈0.12, so anything ≥0.12 would swallow it and
  // anything ≈0.001 would reject the ground. Only a measured value works.
  const groundRow = page.locator('[data-testid="scan-row"][data-scan-name="ground_plants.xyz (ground)"]');
  const plantRow = page.locator('[data-testid="scan-row"][data-scan-name="ground_plants.xyz (non-ground)"]');
  await expect(groundRow).toBeVisible({ timeout: 60_000 });
  await expect(plantRow).toBeVisible({ timeout: 60_000 });
  expect(parseInt((await groundRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(1600);
  expect(parseInt((await plantRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(600);

  // The measured value is reported back into the panel rather than left hidden,
  // and it is no longer the 0.001 the user seeded. Re-select the segmented
  // parent first — the split left one of the new child clouds selected, and the
  // measurement is deliberately keyed to the cloud it was measured on.
  if ((await cloudRow.getAttribute('data-selected')) !== 'true') {
    await cloudRow.click();
  }
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('tool-ground-segment').click();
  await expect(page.getByTestId('ground-segment-panel')).toBeVisible();
  const readout = page.getByTestId('ground-auto-class-threshold-result');
  await expect(readout).toBeVisible();
  const measured = parseFloat((await readout.textContent())?.match(/([\d.]+)\s*m/)?.[1] ?? '0');
  expect(measured).toBeGreaterThan(0.001);
  expect(measured).toBeLessThan(0.12);
});

// Regression: after an in-place ground classify, the cloud must be filterable by
// the baked `ground_class` attribute. This used to 400 — the filter re-read the
// original XYZ source (no ground_class column) instead of the segmented one. Also
// exercises the categorical class-checkbox filter UI (keep Non-ground only).
test('filters a segmented cloud by ground_class via class checkboxes', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="ground_plants.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  // Segment in place (no split) so the single cloud carries ground_class.
  await page.getByTestId('tool-ground-segment').click();
  await page.getByTestId('ground-cloth-resolution').fill('0.1');
  await page.getByTestId('ground-class-threshold').fill('0.05');
  await page.getByTestId('ground-segment-run-button').click();
  await expect(page.getByTestId('class-legend')).toBeVisible({ timeout: 60_000 });

  // Open Filter; ground_class is offered as a categorical scalar field.
  await page.getByTestId('tool-filter').click();
  const fieldSelect = page.getByTestId('filter-field-select');
  await expect(fieldSelect).toBeVisible();
  const optionValues = await fieldSelect
    .locator('option')
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  expect(optionValues).toContain('scalar:ground_class');

  // Selecting a categorical field shows class checkboxes (not min/max inputs),
  // seeded with all classes checked. Uncheck Ground (class 1) → keep only
  // Non-ground (class 2).
  await fieldSelect.selectOption('scalar:ground_class');
  await expect(page.getByTestId('filter-class-1')).toBeVisible();
  await expect(page.getByTestId('filter-min-input')).toHaveCount(0);
  await page.getByTestId('filter-class-1').uncheck();

  // Filter (remove points): the segment→filter flow must succeed (not 400) and
  // keep only the ~600 plant points (CSF matches the fixture's ground truth).
  await page.getByTestId('filter-remove').click();
  await expect(async () => {
    const n = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(n).toBe(600);
  }).toPass({ timeout: 60_000 });
});

// Regression: the Ground Class legend must disappear when the segmented scan is
// removed — it used to linger because its visibility wasn't tied to any cloud
// actually carrying the attribute.
test('hides the class legend after the segmented cloud is deleted', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="ground_plants.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  // Segment in place (no split) so exactly one cloud carries ground_class.
  await page.getByTestId('tool-ground-segment').click();
  await page.getByTestId('ground-class-threshold').fill('0.05');
  await page.getByTestId('ground-segment-run-button').click();

  const legend = page.getByTestId('class-legend');
  await expect(legend).toBeVisible({ timeout: 60_000 });

  // Delete the (only) cloud via its row trash button, then confirm.
  await cloudRow.locator('button[data-testid^="scan-delete-"]').click();
  await page.getByTestId('confirm-delete').click();

  // No cloud carries the attribute any more → the legend must be gone.
  await expect(cloudRow).toHaveCount(0);
  await expect(legend).toBeHidden();
});
