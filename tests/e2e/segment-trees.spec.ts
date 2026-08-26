import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { treeInstanceColor, rgbToHex } from '../../src/renderer/lib/classification';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'multi_tree.xyz');

// multi_tree.xyz is a voxel-downsampled excerpt of TreeIso's MIT demo plot
// (plain "x y z" rows) — a handful of distinct trees standing apart. TreeIso
// (cut-pursuit) segments it into multiple individual trees. Imports become
// octree-backed, so this drives the real `/api/segment/trees/apply` path:
// import → select → open Tree Segmentation → run → assert the cloud is
// re-coloured by the discrete `tree_instance` attribute (no legend is shown for
// tree instances — see below), exercising the live backend end-to-end (no mocks).
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).
const EXPECTED_POINTS = readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l.trim().length > 0).length;

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

test('segments individual trees and colours by the tree_instance attribute', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="multi_tree.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(EXPECTED_POINTS);

  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  // Open the Tree Segmentation panel via its toolbar button.
  await page.getByTestId('tool-tree-segment').click();
  await expect(page.getByTestId('tree-segment-panel')).toBeVisible();

  // Run TreeIso. The backend re-converts the octree carrying tree_instance.
  await page.getByTestId('tree-segment-run-button').click();

  // The cloud becomes coloured by the tree_instance scalar — proof the
  // segmentation ran and its labels drive colour. We read the active scalar
  // from the always-present overlay container rather than the legend, because
  // tree_instance deliberately shows NO legend (one entry per tree would fill
  // the viewport; the ids are arbitrary nominal labels).
  const overlay = page.getByTestId('scalar-overlay');
  await expect(overlay).toHaveAttribute('data-active-scalar', 'tree_instance', { timeout: 120_000 });

  // And the per-tree legend is suppressed for tree_instance (the regression
  // this asserts: no full-height Tree 1…Tree N list, no colorbar).
  await expect(page.getByTestId('class-legend')).toHaveCount(0);
  await expect(page.getByTestId('colorbar')).toHaveCount(0);
});

test('"split into one cloud per tree" adds a separate cloud per detected tree', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="multi_tree.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-tree-segment').click();
  await expect(page.getByTestId('tree-segment-panel')).toBeVisible();

  // Enable the split option BEFORE running. This is the regression under test:
  // the octree-backed (session) path used to ignore this flag entirely, so the
  // scan list ended up with only the recoloured parent — no child clouds.
  await page.getByTestId('tree-split-clouds').check();
  await expect(page.getByTestId('tree-split-clouds')).toBeChecked();

  // The split runs AFTER the panel closes, so the status pill is the only thing
  // telling the user the backend is still building per-tree octrees. Arm the
  // waiter before clicking so the transition can't be missed.
  const splitPill = page.getByTestId('tree-split-running');
  const sawSplitPill = splitPill
    .waitFor({ state: 'visible', timeout: 120_000 })
    .then(() => true)
    .catch(() => false);

  await page.getByTestId('tree-segment-run-button').click();

  // The parent is still recoloured by tree_instance …
  const overlay = page.getByTestId('scalar-overlay');
  await expect(overlay).toHaveAttribute('data-active-scalar', 'tree_instance', { timeout: 120_000 });

  // … AND one "… (tree N)" child cloud is added per detected tree. The split is
  // one batched `sessionExtractByColumn` call whose per-child octree builds run
  // server-side, so the children arrive after the parent recolour — wait for at
  // least one to appear.
  const childRows = page.locator('[data-testid="scan-row"][data-scan-name*="(tree "]');
  await expect(async () => {
    expect(await childRows.count()).toBeGreaterThan(0);
  }).toPass({ timeout: 120_000 });

  // Each child is a real, non-empty cloud (proof the extract selected points,
  // not an empty recolour of the parent), and each holds strictly fewer points
  // than the parent (a per-tree subset, not a copy of the whole cloud).
  const childCount = await childRows.count();
  for (let i = 0; i < childCount; i++) {
    const pts = parseInt((await childRows.nth(i).getAttribute('data-point-count')) ?? '0', 10);
    expect(pts).toBeGreaterThan(0);
    expect(pts).toBeLessThan(EXPECTED_POINTS);
  }
  // The per-tree subsets partition the plant points, so their sum cannot exceed
  // the parent's total (ground/miss points at tree id 0 are never extracted).
  let sum = 0;
  for (let i = 0; i < childCount; i++) {
    sum += parseInt((await childRows.nth(i).getAttribute('data-point-count')) ?? '0', 10);
  }
  expect(sum).toBeLessThanOrEqual(EXPECTED_POINTS);

  // Each child carries ITS TREE's swatch colour, matching the tree_instance
  // colormap the parent is recoloured with. The regression: every child used to
  // get the same hardcoded green, so the scan list gave the user no way to tell
  // which row was which tree.
  const swatches: string[] = [];
  for (let i = 0; i < childCount; i++) {
    const row = childRows.nth(i);
    const name = (await row.getAttribute('data-scan-name')) ?? '';
    const color = (await row.getAttribute('data-scan-color')) ?? '';
    // Not the old hardcoded green.
    expect(color).not.toBe('#4caf50');
    // The colour is the one the viewer paints tree N — parsed from the row's
    // own "(tree N)" name, so this ties the swatch to the parent's colormap
    // rather than just asserting "some colour was assigned".
    const treeId = parseInt(name.match(/\(tree (\d+)\)/)?.[1] ?? '', 10);
    expect(Number.isFinite(treeId), `child "${name}" has no (tree N) suffix`).toBe(true);
    expect(color, `child "${name}" should carry tree ${treeId}'s colour`)
      .toBe(rgbToHex(treeInstanceColor(treeId)));
    swatches.push(color);
  }
  // All distinct — this is what actually proves per-tree colouring; a second
  // hardcoded colour would satisfy the "not green" check above but not this.
  expect(new Set(swatches).size, `swatches were not distinct: ${swatches.join(', ')}`)
    .toBe(childCount);

  // The pill was shown while the children were being built, and is gone now.
  expect(await sawSplitPill).toBe(true);
  await expect(splitPill).toHaveCount(0);
});

// --- Cost advisory: warns, then runs on confirmation ------------------------
// A workload above the node guideline must WARN rather than block: a user
// willing to wait has to be able to run it (Cancel stays available mid-run).
// The guideline is a post-decimation VOXEL count, so triggering it honestly
// would need a multi-million-point fixture; instead we pin
// PHYTOGRAPH_TREEISO_MAX_NODES low for a dedicated app so the committed fixture
// crosses it. Everything else is the real path — real backend, real UI clicks.
test('warns before an expensive run, then segments when confirmed', async () => {
  // Headroom above this test's longest internal wait (180 s). Without it the
  // per-test cap in playwright.config.ts (180 s) fires FIRST, so that wait can
  // never actually elapse and the test can only report an opaque "Test timeout
  // exceeded" instead of failing on its own assertion. Not a way to make a hang
  // pass — a way to make one fail as the assertion it belongs to.
  test.setTimeout(300_000);

  // Own app: the env override must not leak into the shared session above.
  const solo = await launchApp({ PHYTOGRAPH_TREEISO_MAX_NODES: '10' });
  try {
    const { app, page } = solo;
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="multi_tree.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('tool-tree-segment').click();
    await expect(page.getByTestId('tree-segment-panel')).toBeVisible();

    // First click: the advisory appears and NOTHING is segmented.
    await page.getByTestId('tree-segment-run-button').click();
    const warning = page.getByTestId('tree-segment-cost-warning');
    await expect(warning).toBeVisible({ timeout: 60_000 });
    // It states the real workload and that the run is interruptible.
    await expect(warning).toContainText('voxels');
    await expect(warning).toContainText(/cancel/i);
    // The button is now an explicit opt-in, and the panel stayed open.
    const runButton = page.getByTestId('tree-segment-run-button');
    await expect(runButton).toHaveText(/Segment Anyway/);
    // Not a failure: no error toast, and the cloud is NOT yet recoloured.
    await expect(page.getByTestId('scalar-overlay'))
      .not.toHaveAttribute('data-active-scalar', 'tree_instance');

    // Second click: the confirmed run actually segments.
    await runButton.click();
    await expect(page.getByTestId('scalar-overlay'))
      .toHaveAttribute('data-active-scalar', 'tree_instance', { timeout: 180_000 });
  } finally {
    await solo?.close();
  }
});
