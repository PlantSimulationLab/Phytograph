import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'scalars.xyz');
// A second scan with the SAME columns but 40 points at a different X offset, so a
// multi-scan filter's per-cloud results are told apart by their counts.
const FIXTURE_B = join(repoRoot, 'tests', 'e2e', 'fixtures', 'scalars-b.xyz');

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
 *
 * Shared session: one app + backend for the whole file; File → New resets the
 * scene between tests (see helpers/resetApp.ts).
 */

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

async function importAndSelect(app: import('@playwright/test').ElectronApplication, page: import('@playwright/test').Page) {
  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');
  return cloudRow;
}

test('filters an octree-backed cloud by an imported scalar attribute', async () => {
  const { app, page } = session;
  const cloudRow = await importAndSelect(app, page);
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
});

test('segments an octree cloud into in-range + out-of-range clouds', async () => {
  const { app, page } = session;
  const cloudRow = await importAndSelect(app, page);

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
  const { app, page } = session;
  const cloudRow = await importAndSelect(app, page);

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
});

test('offers to delete when a scalar filter excludes every point', async () => {
  const { app, page } = session;
  const cloudRow = await importAndSelect(app, page);

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

  // This is the one commit path that leaves the panel OPEN (it returns before
  // `clearFilterStateForCloud`), so it is where the anti-double-click affordance
  // has to be checked: the run is over, so the progress pill must be gone and the
  // commit button must be usable again rather than stuck reading "Filtering…".
  // A button left disabled here would strand the user behind the dialog.
  await expect(page.getByTestId('filter-running')).toHaveCount(0);
  await expect(page.getByTestId('filter-remove')).toBeEnabled();
});

test('an untouched full-range field is not presented as an active filter', async () => {
  // Regression: `commitFilter` sets enabled:true on ANY keystroke, and the panel
  // gated its commit buttons on "any field enabled". So re-typing a field's own
  // full extent — or touching one field at all — revealed the buttons for every
  // field and listed the untouched field under "Active Filters", telling the
  // user a filter was about to run when nothing would be removed.
  const { app, page } = session;
  await importAndSelect(app, page);

  await page.getByTestId('tool-filter').click();
  const fieldSelect = page.getByTestId('filter-field-select');
  await expect(fieldSelect).toBeVisible();

  // Deviation spans [0,4]; committing exactly that removes nothing.
  await fieldSelect.selectOption('scalar:Deviation');
  await page.getByTestId('filter-min-input').fill('0');
  await page.getByTestId('filter-max-input').fill('4');

  // No commit buttons, no summary entry, no "(active)" marker: nothing is
  // narrowed, so the panel offers nothing to commit.
  await expect(page.getByTestId('filter-remove')).toHaveCount(0);
  await expect(page.getByTestId('filter-segment')).toHaveCount(0);
  await expect(page.getByText('Active Filters')).toHaveCount(0);
  const deviationOption = await fieldSelect
    .locator('option[value="scalar:Deviation"]')
    .textContent();
  expect(deviationOption).not.toContain('(active)');

  // Narrowing ONE field arms the commit buttons and lists exactly that field —
  // the other fields the user has not touched stay out of the summary.
  await page.getByTestId('filter-max-input').fill('2');
  await expect(page.getByTestId('filter-remove')).toBeVisible();
  const summary = page.locator('text=/Deviation: 0 - 2|Deviation: 0.00 - 2.00/');
  await expect(summary).toBeVisible();
  // Switching to an untouched field must not inherit the armed state: its own
  // "Remove this filter" is absent because IT narrows nothing.
  await fieldSelect.selectOption('z');
  await expect(page.getByRole('button', { name: 'Remove this filter' })).toHaveCount(0);
  const zOption = await fieldSelect.locator('option[value="z"]').textContent();
  expect(zOption).not.toContain('(active)');
});

test('shows an integer field as whole numbers, and filters on it', async () => {
  // target_index is the n-th return of a pulse — a fractional value is
  // meaningless — but it is stored float32, so the panel used to read
  // "Range: 1.00 to 8.00" with a free-decimal input.
  const { app, page } = session;
  const cloudRow = await importAndSelect(app, page);

  await page.getByTestId('tool-filter').click();
  const fieldSelect = page.getByTestId('filter-field-select');
  await expect(fieldSelect).toBeVisible();
  await fieldSelect.selectOption('scalar:target_index');

  // Whole-number range label, and a step=1 input rather than step="any".
  await expect(page.getByText('Range: 1 to 8')).toBeVisible();
  await expect(page.getByTestId('filter-min-input')).toHaveAttribute('step', '1');
  await expect(page.getByTestId('filter-max-input')).toHaveAttribute('step', '1');

  // Deviation, by contrast, keeps two decimals — the integer treatment is
  // per-field, not a blanket change to the panel.
  await fieldSelect.selectOption('scalar:Deviation');
  await expect(page.getByText('Range: 0.00 to 4.00')).toBeVisible();
  await expect(page.getByTestId('filter-min-input')).toHaveAttribute('step', 'any');

  // And it still filters correctly: keep first+second returns → 16 of 60.
  await fieldSelect.selectOption('scalar:target_index');
  await page.getByTestId('filter-min-input').fill('1');
  await page.getByTestId('filter-max-input').fill('2');
  await page.getByTestId('filter-remove').click();

  await expect(async () => {
    const n = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(n).toBe(16);
  }).toPass({ timeout: 30_000 });
});

test('filters every selected scan, not just the first', async () => {
  // Regression: the panel rendered for the first selection while both commit
  // handlers began `if (selectedIds.size !== 1) return`, so with two scans
  // selected the buttons were silently dead — nothing happened, no error.
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  await importFiles(app, page, 'import-point-cloud', FIXTURE_B);
  await completeImportWizard(page);

  const rowA = page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]');
  const rowB = page.locator('[data-testid="scan-row"][data-scan-name="scalars-b.xyz"]');
  await expect(rowA).toBeVisible({ timeout: 20_000 });
  await expect(rowB).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await rowA.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);
  expect(parseInt((await rowB.getAttribute('data-point-count')) ?? '0', 10)).toBe(40);

  // The second import is auto-selected; ctrl/cmd-click adds the first, exactly
  // as a user builds a multi-scan selection.
  await rowA.click({ modifiers: ['ControlOrMeta'] });
  await expect(rowA).toHaveAttribute('data-selected', 'true');
  await expect(rowB).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-filter').click();
  const fieldSelect = page.getByTestId('filter-field-select');
  await expect(fieldSelect).toBeVisible();
  // The panel says how many scans it will act on.
  await expect(page.getByTestId('filter-multi-scan-notice')).toContainText('2 scans');

  // Deviation in [0,2] keeps 3/5 of each scan: 36 of 60 and 24 of 40.
  await fieldSelect.selectOption('scalar:Deviation');
  await page.getByTestId('filter-min-input').fill('0');
  await page.getByTestId('filter-max-input').fill('2');
  await expect(page.getByTestId('filter-remove')).toContainText('2 scans');
  await page.getByTestId('filter-remove').click();

  await expect(async () => {
    const a = parseInt((await rowA.getAttribute('data-point-count')) ?? '0', 10);
    const b = parseInt((await rowB.getAttribute('data-point-count')) ?? '0', 10);
    expect({ a, b }).toEqual({ a: 36, b: 24 });
  }).toPass({ timeout: 60_000 });
});

test('segments every selected scan, keeping both halves of each', async () => {
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  await importFiles(app, page, 'import-point-cloud', FIXTURE_B);
  await completeImportWizard(page);

  const rowA = page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]');
  const rowB = page.locator('[data-testid="scan-row"][data-scan-name="scalars-b.xyz"]');
  await expect(rowA).toBeVisible({ timeout: 20_000 });
  await expect(rowB).toBeVisible({ timeout: 20_000 });
  await rowA.click({ modifiers: ['ControlOrMeta'] });

  await page.getByTestId('tool-filter').click();
  const fieldSelect = page.getByTestId('filter-field-select');
  await expect(fieldSelect).toBeVisible();
  await fieldSelect.selectOption('scalar:Deviation');
  await page.getByTestId('filter-min-input').fill('0');
  await page.getByTestId('filter-max-input').fill('2');
  await page.getByTestId('filter-segment').click();

  // Four clouds: each original keeps its in-range half and gains a leftover.
  // Nothing is lost — 36+24 == 60 and 24+16 == 40.
  const allRows = page.locator('[data-testid="scan-row"]');
  await expect(async () => {
    expect(await allRows.count()).toBe(4);
  }).toPass({ timeout: 60_000 });

  await expect(async () => {
    const counts = await allRows.evaluateAll((rows) =>
      rows.map((r) => parseInt(r.getAttribute('data-point-count') ?? '0', 10)),
    );
    counts.sort((a, b) => a - b);
    expect(counts).toEqual([16, 24, 24, 36]);
  }).toPass({ timeout: 30_000 });

  await expect(
    page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz (filtered out)"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="scan-row"][data-scan-name="scalars-b.xyz (filtered out)"]'),
  ).toBeVisible();
});

test('does not claim a removed-points filter can be cleared', async () => {
  // Regression: the panel offered "Clear All Filters" after a destructive
  // filter, which reads as an undo it never was — the points are permanently
  // deleted. The button now says what it does (resets the criteria) and the
  // panel states plainly which commit is destructive.
  const { app, page } = session;
  const cloudRow = await importAndSelect(app, page);

  await page.getByTestId('tool-filter').click();
  const fieldSelect = page.getByTestId('filter-field-select');
  await expect(fieldSelect).toBeVisible();
  await fieldSelect.selectOption('scalar:Deviation');
  await page.getByTestId('filter-min-input').fill('0');
  await page.getByTestId('filter-max-input').fill('2');

  // Before committing: the reset button is offered, and it does NOT promise to
  // restore anything. The old "Clear All Filters" wording is gone.
  await expect(page.getByTestId('filter-reset-criteria')).toBeVisible();
  await expect(page.getByText('Clear All Filters')).toHaveCount(0);
  await expect(
    page.getByText('Filter deletes the out-of-range points permanently'),
  ).toBeVisible();

  await page.getByTestId('filter-remove').click();
  await expect(async () => {
    const n = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(n).toBe(36);
  }).toPass({ timeout: 30_000 });

  // Re-opening the panel on the filtered cloud: the criteria were consumed, so
  // there is nothing to reset and no button implying the 24 points can return.
  await page.getByTestId('tool-filter').click();
  await expect(page.getByTestId('filter-field-select')).toBeVisible();
  await expect(page.getByTestId('filter-reset-criteria')).toHaveCount(0);
  await expect(page.getByTestId('filter-remove')).toHaveCount(0);
  expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(36);
});

test('a touched-but-unnarrowed X does not crop siblings to the first scan', async () => {
  // The most damaging shape of the "enabled means active" bug, once the commit
  // runs on several scans: the panel enables a field on the first keystroke, so
  // merely selecting X and re-typing scalars.xyz's own X range leaves X enabled
  // at that scan's extent. Carried onto scalars-b.xyz — which sits at x≈10..20,
  // entirely outside scalars.xyz's x≈0..12 — that becomes a real spatial crop
  // and deletes the whole second scan, while the user believes they filtered on
  // Deviation alone.
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  await importFiles(app, page, 'import-point-cloud', FIXTURE_B);
  await completeImportWizard(page);

  const rowA = page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]');
  const rowB = page.locator('[data-testid="scan-row"][data-scan-name="scalars-b.xyz"]');
  await expect(rowA).toBeVisible({ timeout: 20_000 });
  await expect(rowB).toBeVisible({ timeout: 20_000 });
  // scalars.xyz is the PRIMARY (first in the selection), so select it last-but-
  // ctrl-clicked: click A alone to make it the sole selection, then add B.
  await rowA.click();
  await expect(rowA).toHaveAttribute('data-selected', 'true');
  await rowB.click({ modifiers: ['ControlOrMeta'] });
  await expect(rowB).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-filter').click();
  const fieldSelect = page.getByTestId('filter-field-select');
  await expect(fieldSelect).toBeVisible();

  // Touch X and put back its own full range — a no-op the panel must not carry
  // over. Read the bounds off the panel rather than hardcoding them. The value
  // is nudged and restored because filling an input with the value it already
  // holds fires no change event, so X would never be enabled and the test would
  // pass for the wrong reason.
  await fieldSelect.selectOption('x');
  const minInput = page.getByTestId('filter-min-input');
  const maxInput = page.getByTestId('filter-max-input');
  const xMin = await minInput.inputValue();
  const xMax = await maxInput.inputValue();
  await minInput.fill(String(Number(xMin) + 0.5));
  await minInput.fill(xMin);
  await maxInput.fill(String(Number(xMax) - 0.5));
  await maxInput.fill(xMax);
  // X is now enabled at its own full extent — the exact no-op state. It must
  // NOT be marked active, and must not arm the commit buttons on its own.
  const xOption = await fieldSelect.locator('option[value="x"]').textContent();
  expect(xOption).not.toContain('(active)');
  await expect(page.getByTestId('filter-remove')).toHaveCount(0);

  // Now the criterion the user actually wants.
  await fieldSelect.selectOption('scalar:Deviation');
  await page.getByTestId('filter-min-input').fill('0');
  await page.getByTestId('filter-max-input').fill('2');
  await page.getByTestId('filter-remove').click();

  // Both scans keep their own Deviation 3/5: 36 of 60 and 24 of 40. If X had
  // carried over, scalars-b.xyz would have emptied (raising the delete dialog)
  // instead of keeping 24.
  await expect(async () => {
    const a = parseInt((await rowA.getAttribute('data-point-count')) ?? '0', 10);
    const b = parseInt((await rowB.getAttribute('data-point-count')) ?? '0', 10);
    expect({ a, b }).toEqual({ a: 36, b: 24 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByTestId('confirm-delete')).toHaveCount(0);
});
