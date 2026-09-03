import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'noisy-tree.xyz');
// The same tree, 5 m clear in X, with 9 flyers instead of 25 — so a two-scan
// detection's per-scan results can be told apart (see the multi-scan test).
const FIXTURE_B = join(repoRoot, 'tests', 'e2e', 'fixtures', 'noisy-tree-b.xyz');

/**
 * The Filter panel's Noise section: classify stray points, review them, remove
 * or split them.
 *
 * Detect does NOT remove anything. It writes a `noise_class` column (1=clean,
 * 2=noise), colours the cloud by it so the flagged points show red, and
 * pre-selects `scalar:noise_class` in the field dropdown with only "Clean"
 * checked — which arms the panel's EXISTING Filter/Segment buttons. That is why
 * the commits below are the same `filter-remove` / `filter-segment` buttons the
 * scalar-filter spec drives.
 *
 * Fixture facts (backend-api/tests/noisy_tree_fixture.py, 3543 points):
 *   - trunk  3150 points, dense cylinder shell at 1 cm spacing
 *   - twigs   360 points, 12 branches at 5 cm — the FINE STRUCTURE. Losing these
 *             is the failure mode this whole feature is designed around, so the
 *             tests assert on them directly rather than on a total alone.
 *   - flyers   25 isolated points, >= 1 m from anything. Genuine noise.
 *   - clump     8 points in a 2 cm ball, 1 m off the tree. Noise that supports
 *             itself, so the local density methods miss it by design.
 *
 * The twigs are the TOPMOST points in the cloud (the branches fan upward), so
 * "did the fine structure survive" is checkable from the cloud's own bounds.
 */

const TOTAL = 3543;
const FLYERS = 25;
const TOTAL_B = 3527;
const FLYERS_B = 9;

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

async function importAndSelect() {
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="noisy-tree"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');
  expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(TOTAL);
  return cloudRow;
}

/** Open the Filter panel with the Noise section expanded.
 *
 * Idempotent on purpose: a commit closes the panel but the section's
 * expanded/collapsed state survives, so a blind toggle-click on the second
 * open would COLLAPSE it. */
async function openNoiseSection() {
  const { page } = session;
  await page.getByTestId('tool-filter').click();
  await expect(page.getByTestId('filter-field-select')).toBeVisible();
  const detect = page.getByTestId('filter-noise-detect');
  if (!(await detect.isVisible())) {
    await page.getByTestId('filter-noise-toggle').click();
  }
  await expect(detect).toBeVisible();
}

/** Click Detect and wait for the result box, returning its reported numbers. */
async function detect() {
  const { page } = session;
  await page.getByTestId('filter-noise-detect').click();
  const result = page.getByTestId('filter-noise-result');
  await expect(result).toBeVisible({ timeout: 60_000 });
  return {
    flagged: parseInt((await result.getAttribute('data-flagged')) ?? '-1', 10),
    fraction: parseFloat((await result.getAttribute('data-fraction')) ?? '-1'),
    overRemoval: (await result.getAttribute('data-over-removal')) === 'true',
  };
}

test('detects the isolated flyers and arms the existing filter buttons', async () => {
  const { page } = session;
  await importAndSelect();
  await openNoiseSection();

  // Default method is "Isolated points" (ROR), NOT the conventional SOR — see
  // backend-api/denoise.py for why.
  await expect(page.getByTestId('filter-noise-method')).toHaveValue('ror');

  const { flagged, overRemoval } = await detect();
  expect(flagged).toBe(FLYERS);
  expect(overRemoval).toBe(false);

  // Detect pre-selected the noise field and checked only "Clean", so the panel's
  // own Remove/Segment buttons now mean exactly "act on the noise".
  await expect(page.getByTestId('filter-field-select')).toHaveValue('scalar:noise_class');
  await expect(page.getByTestId('filter-class-1')).toBeChecked();
  await expect(page.getByTestId('filter-class-2')).not.toBeChecked();
});

test('removing the flagged points takes exactly those points, and is stable', async () => {
  const { page } = session;
  const cloudRow = await importAndSelect();
  await openNoiseSection();
  expect((await detect()).flagged).toBe(FLYERS);

  await page.getByTestId('filter-remove').click();
  // EXACTLY 25 points go. That is the fine-structure assertion: if the method
  // had eaten twig tips the count would be lower, and the backend suite
  // (test_denoise.py) pins that those 25 are the flyers specifically.
  await expect(async () => {
    const n = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(n).toBe(TOTAL - FLYERS);
  }).toPass({ timeout: 60_000 });

  // Re-detecting on the cleaned cloud finds nothing. The default method is
  // idempotent by construction (it asks a purely local question), and this is
  // the property the statistical method LACKS — a second SOR pass collapses onto
  // the fine structure once the flyers that were holding its threshold up are
  // gone. See backend-api/denoise.py.
  // A commit clears the previous detection (its counts describe points that no
  // longer exist), so the result box below is genuinely the new run's.
  await openNoiseSection();
  await expect(page.getByTestId('filter-noise-result')).toBeHidden();
  expect((await detect()).flagged).toBe(0);
});

test('detects noise on every selected scan, not just the first', async () => {
  // Regression: handleDetectNoise began `if (selectedIds.size !== 1) return`
  // while the panel rendered for the primary selection, so with two scans
  // selected the Detect button did nothing at all — no result, no error, no
  // toast. The Filter/Segment commits had already been fixed for exactly this;
  // the Noise section landed on a parallel branch and kept the guard.
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  await importFiles(app, page, 'import-point-cloud', FIXTURE_B);
  await completeImportWizard(page);

  const rowA = page.locator('[data-testid="scan-row"][data-scan-name="noisy-tree"]');
  const rowB = page.locator('[data-testid="scan-row"][data-scan-name="noisy-tree-b"]');
  await expect(rowA).toBeVisible({ timeout: 20_000 });
  await expect(rowB).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await rowA.getAttribute('data-point-count')) ?? '0', 10)).toBe(TOTAL);
  expect(parseInt((await rowB.getAttribute('data-point-count')) ?? '0', 10)).toBe(TOTAL_B);

  // The second import is auto-selected; ctrl/cmd-click adds the first, exactly
  // as a user builds a multi-scan selection.
  await rowA.click({ modifiers: ['ControlOrMeta'] });
  await expect(rowA).toHaveAttribute('data-selected', 'true');
  await expect(rowB).toHaveAttribute('data-selected', 'true');

  await openNoiseSection();
  // The button says what it will act on, like the commit buttons below it.
  await expect(page.getByTestId('filter-noise-detect')).toContainText('2 scans');
  await detect();

  // Each scan carries its OWN detection, not a copy of the primary's. Selecting
  // one alone re-renders the result box against that cloud's stats, and the two
  // fixtures differ in flyer count precisely so this can tell them apart.
  await rowA.click();
  await expect(rowA).toHaveAttribute('data-selected', 'true');
  await expect(rowB).toHaveAttribute('data-selected', 'false');
  await expect(page.getByTestId('filter-noise-result'))
    .toHaveAttribute('data-flagged', String(FLYERS));

  await rowB.click();
  await expect(page.getByTestId('filter-noise-result'))
    .toHaveAttribute('data-flagged', String(FLYERS_B));

  // And the arming is real on both: re-select the pair and Remove, which is the
  // panel's own button acting through the noise_class criterion Detect set.
  // Each scan loses exactly its own flyers — nothing else, and nothing from the
  // scan that was not the primary.
  await rowA.click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('filter-field-select')).toHaveValue('scalar:noise_class');
  await page.getByTestId('filter-remove').click();
  await expect(async () => {
    const a = parseInt((await rowA.getAttribute('data-point-count')) ?? '0', 10);
    const b = parseInt((await rowB.getAttribute('data-point-count')) ?? '0', 10);
    expect({ a, b }).toEqual({ a: TOTAL - FLYERS, b: TOTAL_B - FLYERS_B });
  }).toPass({ timeout: 60_000 });
});

test('segmenting splits the noise into its own cloud, losing nothing', async () => {
  const { page } = session;
  await importAndSelect();
  await openNoiseSection();
  expect((await detect()).flagged).toBe(FLYERS);

  await page.getByTestId('filter-segment').click();

  const allRows = page.locator('[data-testid="scan-row"]');
  await expect(async () => {
    expect(await allRows.count()).toBe(2);
  }).toPass({ timeout: 60_000 });

  await expect(async () => {
    const counts = await allRows.evaluateAll((rows) =>
      rows.map((r) => parseInt(r.getAttribute('data-point-count') ?? '0', 10)),
    );
    counts.sort((a, b) => a - b);
    // Kept + removed == the original: nothing is discarded by a split.
    expect(counts).toEqual([FLYERS, TOTAL - FLYERS]);
  }).toPass({ timeout: 60_000 });

  await expect(
    page.locator('[data-testid="scan-row"][data-scan-name="noisy-tree (filtered out)"]'),
  ).toBeVisible();
});

test('the fast voxel method also finds the flyers, at a documented cost', async () => {
  // Exercises a non-default option (E2E rule 2) AND pins the tradeoff: the O(N)
  // voxel rule takes every flyer but also clips branch-end points whose voxel
  // holds only them. That is why it is offered for large clouds, not as default.
  const { page } = session;
  const cloudRow = await importAndSelect();
  await openNoiseSection();

  await page.getByTestId('filter-noise-method').selectOption('voxel_count');
  const { flagged } = await detect();
  expect(flagged).toBe(50);   // 25 flyers + 24 twig-end points + 1 of the clump

  await page.getByTestId('filter-remove').click();
  await expect(async () => {
    const n = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(n).toBe(TOTAL - 50);
  }).toPass({ timeout: 60_000 });
});

test('manual parameters override the auto-derived ones', async () => {
  const { page } = session;
  await importAndSelect();
  await openNoiseSection();

  // Auto resolves the radius from the cloud's own spacing; unchecking exposes
  // the field so the user can set a physical distance they can reason about.
  await page.getByTestId('filter-noise-auto').uncheck();
  const radius = page.getByTestId('filter-noise-radius');
  await expect(radius).toBeEnabled();
  await radius.fill('0.5');
  await radius.blur();

  // A generous radius is more forgiving, and still isolates exactly the flyers
  // (each is >= 1 m from anything). The 8-point clump stays clean: its members
  // support each other, which is the documented gap of every local density rule.
  const { flagged } = await detect();
  expect(flagged).toBe(FLYERS);
});

test('an over-aggressive result is flagged and gated behind a confirmation', async () => {
  // The safety property: a bad parameter choice must be visible BEFORE anything
  // is deleted, and must not be one click from destroying the cloud.
  const { page } = session;
  await importAndSelect();
  await openNoiseSection();

  await page.getByTestId('filter-noise-auto').uncheck();
  // Demanding 12 neighbours inside 2 cm is denser than even the trunk, so this
  // flags ~91% of the cloud — an obviously-wrong parameter choice that still
  // leaves points behind, so it is the noise guard under test here and not the
  // empty-result delete dialog.
  await page.getByTestId('filter-noise-radius').fill('0.02');
  await page.getByTestId('filter-noise-radius').blur();
  await page.getByTestId('filter-noise-nb_points').fill('12');
  await page.getByTestId('filter-noise-nb_points').blur();

  const { flagged, overRemoval } = await detect();
  expect(flagged).toBeGreaterThan(TOTAL * 0.5);
  expect(flagged).toBeLessThan(TOTAL);
  expect(overRemoval).toBe(true);

  // Remove does not act — it asks first.
  await page.getByTestId('filter-remove').click();
  await expect(page.getByTestId('noise-remove-confirm')).toBeVisible();
});
