import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'scalars.xyz');

/**
 * Filtering & segmenting an octree-backed cloud by an imported scalar attribute.
 *
 * scalars.xyz imports through convert_to_octree (the renderer never holds the
 * points), so its scalar columns live as octree extra-dimension attributes —
 * NOT in data.scalarFields. The Filter panel exposes those imported scalars
 * (Timestamp_s, Deviation, Target_Index) alongside X/Y/Z. There is no live
 * preview for octrees: setting a range and clicking a commit button re-converts
 * the cloud on the backend.
 *
 * Two commit actions (no Apply button):
 *   - Filter (remove points)  → keeps in-range, drops the rest. (filter-remove)
 *   - Segment (split clouds)  → keeps in-range on the original AND adds the
 *     out-of-range points as a second cloud. (filter-segment)
 *
 * Fixture facts (60 data points, header row skipped):
 *   - Deviation cycles 0,1,2,3,4 → each value appears 12 times.
 *   - Deviation in [0, 2] keeps 36; the complement is 24. 36 + 24 == 60.
 */

async function importAndSelect(page: import('@playwright/test').Page) {
  await page.getByTestId('import-menu-button').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('import-menu-pointcloud').click(),
  ]);
  await chooser.setFiles(FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  await cloudRow.click();
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');
  return cloudRow;
}

test('filters an octree-backed cloud by an imported scalar attribute', async () => {
  const { page, close } = await launchApp();
  try {
    const cloudRow = await importAndSelect(page);
    expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);

    await page.getByTestId('tool-filter').click();
    const fieldSelect = page.getByTestId('filter-field-select');
    await expect(fieldSelect).toBeVisible();

    // The imported scalar must be an option (the bug this feature fixed: octree
    // clouds previously listed only X/Y/Z). Builtin LAS attrs must not leak in.
    const optionValues = await fieldSelect
      .locator('option')
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    expect(optionValues).toContain('scalar:Deviation');
    for (const v of optionValues) {
      expect(v.toLowerCase()).not.toContain('source id');
      expect(v.toLowerCase()).not.toContain('gps');
    }

    // Keep only Deviation in [0, 2] → 36 of 60 survive. No Apply button — the
    // range commits live; "Filter (remove points)" performs the removal.
    await fieldSelect.selectOption('scalar:Deviation');
    await page.getByTestId('filter-min-input').fill('0');
    await page.getByTestId('filter-max-input').fill('2');
    await page.getByTestId('filter-remove').click();

    await expect(async () => {
      const n = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
      expect(n).toBe(36);
    }).toPass({ timeout: 30_000 });
  } finally {
    await close();
  }
});

test('segments an octree cloud into in-range + out-of-range clouds', async () => {
  const { page, close } = await launchApp();
  try {
    const cloudRow = await importAndSelect(page);

    await page.getByTestId('tool-filter').click();
    const fieldSelect = page.getByTestId('filter-field-select');
    await expect(fieldSelect).toBeVisible();
    await fieldSelect.selectOption('scalar:Deviation');
    await page.getByTestId('filter-min-input').fill('0');
    await page.getByTestId('filter-max-input').fill('2');

    // Segment: original keeps the in-range 36; a second cloud holds the 24
    // out-of-range points. Nothing is lost — the counts sum to the original 60.
    await page.getByTestId('filter-segment').click();

    const allRows = page.locator('[data-testid="scan-row"]');
    await expect(async () => {
      expect(await allRows.count()).toBe(2);
    }).toPass({ timeout: 30_000 });

    await expect(async () => {
      const counts = await allRows.evaluateAll((rows) =>
        rows.map((r) => parseInt(r.getAttribute('data-point-count') ?? '0', 10)),
      );
      counts.sort((a, b) => a - b);
      expect(counts).toEqual([24, 36]);
    }).toPass({ timeout: 30_000 });

    // The leftover cloud is named "<original> (filtered out)".
    await expect(
      page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz (filtered out)"]'),
    ).toBeVisible();
  } finally {
    await close();
  }
});

test('a second filter composes on the first result, not the original source', async () => {
  // Regression: octree ops used to re-read the ORIGINAL source, so a second
  // filter/crop discarded the first (previously-removed points reappeared). Now
  // each op persists its kept points and the next op chains from them.
  //
  // Keep Deviation in [0,1] (24 pts), THEN filter that result to Deviation in
  // [3,4]. Those two windows are disjoint, so a correctly-chained second filter
  // keeps NOTHING (→ delete dialog). If it re-read the original it would wrongly
  // keep the 24 points with dev∈{3,4}.
  const { page, close } = await launchApp();
  try {
    const cloudRow = await importAndSelect(page);

    await page.getByTestId('tool-filter').click();
    const fieldSelect = page.getByTestId('filter-field-select');
    await expect(fieldSelect).toBeVisible();
    await fieldSelect.selectOption('scalar:Deviation');
    await page.getByTestId('filter-min-input').fill('0');
    await page.getByTestId('filter-max-input').fill('1');
    await page.getByTestId('filter-remove').click();

    await expect(async () => {
      const n = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
      expect(n).toBe(24);
    }).toPass({ timeout: 30_000 });

    // Second filter on the now-24-point cloud: dev in [3,4] → empty (the 24 kept
    // points are all dev∈{0,1}). An empty result raises the delete dialog.
    await page.getByTestId('tool-filter').click();
    const fieldSelect2 = page.getByTestId('filter-field-select');
    await expect(fieldSelect2).toBeVisible();
    await fieldSelect2.selectOption('scalar:Deviation');
    await page.getByTestId('filter-min-input').fill('3');
    await page.getByTestId('filter-max-input').fill('4');
    await page.getByTestId('filter-remove').click();

    await expect(page.getByTestId('confirm-delete')).toBeVisible({ timeout: 30_000 });
    // The cloud still shows its 24 points (the empty filter wasn't applied) —
    // proving the second filter saw only the first result, not the original 60.
    expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(24);
  } finally {
    await close();
  }
});

test('offers to delete when a scalar filter excludes every point', async () => {
  const { page, close } = await launchApp();
  try {
    const cloudRow = await importAndSelect(page);

    await page.getByTestId('tool-filter').click();
    const fieldSelect = page.getByTestId('filter-field-select');
    await expect(fieldSelect).toBeVisible();
    await fieldSelect.selectOption('scalar:Deviation');

    // Deviation maxes out at 4 — this window matches nothing.
    await page.getByTestId('filter-min-input').fill('1000');
    await page.getByTestId('filter-max-input').fill('2000');
    await page.getByTestId('filter-remove').click();

    // Empty result → delete-confirmation dialog, not a silent empty cloud.
    await expect(page.getByTestId('confirm-delete')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Delete cloud?')).toBeVisible();
    expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);
  } finally {
    await close();
  }
});
