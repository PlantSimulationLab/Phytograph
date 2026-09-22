import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'scalar-bands.xyz');

// scalar-bands.xyz is a 10x10x10 lattice (1000 points) carrying one extra
// column, `band`, which holds the integer 1..10 of the point's z level — 100
// points per value. Every statistic is therefore exact and hand-checkable:
//
//     band:   min 1, max 10, mean 5.5, median 5.5
//     band*2: min 2, max 20, mean 11
//
// That is the point of the fixture. A test that only asserted "a number
// appeared" would pass against a backend computing the wrong thing.

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

/** Import the fixture and leave its (auto-selected) row visible. */
async function importFixture(app: LaunchedApp['app'], page: LaunchedApp['page']) {
  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  const row = page.locator('[data-testid="scan-row"][data-scan-name="scalar-bands"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(1000);
  await expect(row).toHaveAttribute('data-selected', 'true');
  return row;
}

/** The numeric value a stats row is displaying, read from its data-value. */
async function statValue(page: LaunchedApp['page'], key: string): Promise<number> {
  const cell = page.locator(`[data-testid="scalar-stat-${key}"] td[data-value]`);
  await expect(cell).toBeVisible();
  return parseFloat((await cell.getAttribute('data-value')) ?? 'NaN');
}

async function openScalarPanel(page: LaunchedApp['page']) {
  await page.getByTestId('tool-scalar-fields').click();
  await expect(page.getByTestId('scalar-fields-panel')).toBeVisible();
}

test('reports exact statistics and draws a histogram for an imported field', async () => {
  const { app, page } = session;
  await importFixture(app, page);
  await openScalarPanel(page);

  // The imported column is listed and editable; x/y/z are listed but locked.
  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="band"]'))
    .toBeVisible();
  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="z"]'))
    .toHaveAttribute('data-editable', 'false');

  await page.getByTestId('scalar-fields-tab-stats').click();
  await page.getByTestId('scalar-stats-field').selectOption('band');
  await expect(page.getByTestId('scalar-stats')).toBeVisible({ timeout: 15_000 });

  // The whole reason for a hand-computable fixture.
  expect(await statValue(page, 'count')).toBe(1000);
  expect(await statValue(page, 'mean')).toBeCloseTo(5.5, 5);
  expect(await statValue(page, 'median')).toBeCloseTo(5.5, 5);
  expect(await statValue(page, 'min')).toBeCloseTo(1, 5);
  expect(await statValue(page, 'max')).toBeCloseTo(10, 5);

  // A real distribution, not an empty axis.
  const bars = page.locator('[data-testid="scalar-histogram-bar"]');
  expect(await bars.count()).toBeGreaterThan(1);
  // Every point is accounted for by the bars plus the out-of-range counts.
  const counts = await bars.evaluateAll(
    els => els.map(e => parseInt(e.getAttribute('data-count') ?? '0', 10)));
  expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
});

test('derives a field by formula and makes it a first-class scalar field', async () => {
  const { app, page } = session;
  await importFixture(app, page);
  await openScalarPanel(page);

  await page.getByTestId('scalar-fields-tab-compute').click();
  await page.getByTestId('scalar-compute-expression').fill('band * 2');
  await page.getByTestId('scalar-compute-slug').fill('doubled');
  await page.getByTestId('scalar-compute-run').click();

  // The panel switches to Stats on success and shows the new field's numbers.
  await expect(page.getByTestId('scalar-stats')).toBeVisible({ timeout: 60_000 });
  expect(await statValue(page, 'mean')).toBeCloseTo(11, 4);
  expect(await statValue(page, 'min')).toBeCloseTo(2, 4);
  expect(await statValue(page, 'max')).toBeCloseTo(20, 4);

  // ── The real test of "first-class": it must reach all three surfaces ──
  //
  // These are three independent consumers of the session's column list, and
  // each reads it through different machinery (the colour picker via octree
  // attribute metadata, the filter via filterFieldsFor, the export modal via
  // exportColumns). A derived field that only showed up in one of them would
  // be a second-class citizen, which is precisely what the design forbids.

  // 1. Colour-by dropdown. The Display section is collapsed by default.
  await page.getByRole('button', { name: 'Display' }).click();
  const colorMode = page.getByTestId('display-color-mode');
  await expect(colorMode).toBeVisible();
  await expect(colorMode.locator('option[value="scalar:doubled"]'))
    .toHaveCount(1, { timeout: 30_000 });
  // And the compute selected it, so the cloud is already painted by it.
  await expect(colorMode).toHaveValue('scalar:doubled');

  // 2. Filter panel's field list.
  await page.getByTestId('tool-filter').click();
  const filterField = page.getByTestId('filter-field-select');
  await expect(filterField).toBeVisible();
  await expect(filterField.locator('option[value="scalar:doubled"]')).toHaveCount(1);
  await page.getByTestId('tool-filter').click();

  // 3. Export modal's column picker. Export has no toolbar button (it is a
  // menu item), so the existing export specs open it through this bridge.
  await page.evaluate(
    () => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
  await expect(page.getByTestId('export-modal')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('export-column-check-doubled')).toHaveCount(1);
});

test('re-running a derived field replaces it, without deleting it first', async () => {
  const { app, page } = session;
  await importFixture(app, page);
  await openScalarPanel(page);

  await page.getByTestId('scalar-fields-tab-compute').click();
  await page.getByTestId('scalar-compute-expression').fill('band * 2');
  await page.getByTestId('scalar-compute-slug').fill('scaled');
  await page.getByTestId('scalar-compute-run').click();
  await expect(page.getByTestId('scalar-stats')).toBeVisible({ timeout: 60_000 });
  expect(await statValue(page, 'mean')).toBeCloseTo(11, 4);

  // Tweak the formula and re-run under the SAME name. This is the loop the
  // tool advertises; an earlier version blocked it client-side (every existing
  // name read as taken), so the only way to change a formula was to delete the
  // field and start again.
  await page.getByTestId('scalar-fields-tab-compute').click();
  await page.getByTestId('scalar-compute-expression').fill('band * 3');
  await page.getByTestId('scalar-compute-slug').fill('scaled');
  await expect(page.getByTestId('scalar-compute-replace-hint')).toBeVisible();
  const run = page.getByTestId('scalar-compute-run');
  await expect(run).toBeEnabled();
  await expect(run).toHaveText(/Recompute/);
  await run.click();

  // Replaced in place: new values, and still exactly one field by that name.
  await expect(page.getByTestId('scalar-stats')).toBeVisible({ timeout: 60_000 });
  expect(await statValue(page, 'mean')).toBeCloseTo(16.5, 4);   // 3 * 5.5
  await page.getByTestId('scalar-fields-tab-fields').click();
  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="scaled"]'))
    .toHaveCount(1);

  // An IMPORTED column is still protected — it is a measurement, and silently
  // replacing one would invalidate anything already computed from it.
  await page.getByTestId('scalar-fields-tab-compute').click();
  await page.getByTestId('scalar-compute-expression').fill('band * 4');
  await page.getByTestId('scalar-compute-slug').fill('band');
  await expect(page.getByTestId('scalar-compute-slug-hint')).toBeVisible();
  await expect(page.getByTestId('scalar-compute-run')).toBeDisabled();
});

test('renames a derived field and keeps the viewer colouring by it', async () => {
  const { app, page } = session;
  await importFixture(app, page);
  await openScalarPanel(page);

  await page.getByTestId('scalar-fields-tab-compute').click();
  await page.getByTestId('scalar-compute-expression').fill('band + 1');
  await page.getByTestId('scalar-compute-slug').fill('shifted');
  await page.getByTestId('scalar-compute-run').click();
  await expect(page.getByTestId('scalar-stats')).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Display' }).click();
  const colorMode = page.getByTestId('display-color-mode');
  await expect(colorMode).toBeVisible();
  await expect(colorMode).toHaveValue('scalar:shifted', { timeout: 30_000 });

  // Rename through the row menu's inline form — real DOM, no native dialog.
  await page.getByTestId('scalar-fields-tab-fields').click();
  await page.locator('[data-testid="scalar-field-row"][data-slug="shifted"]').hover();
  await page.getByTestId('scalar-field-menu-shifted').click();
  await page.getByTestId('scalar-field-rename-shifted').click();
  const nameInput = page.getByTestId('scalar-field-name-input-shifted');
  await expect(nameInput).toBeVisible();
  await nameInput.fill('renamed_field');
  await page.getByTestId('scalar-field-name-apply-shifted').click();

  // The row is renamed...
  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="renamed_field"]'))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="shifted"]'))
    .toHaveCount(0);

  // ...AND the viewer follows it. Without the slug migration the colour mode
  // would silently fall back to the default and the user would read the rename
  // as having broken their colouring.
  await expect(colorMode).toHaveValue('scalar:renamed_field', { timeout: 30_000 });
});

test('refuses to delete a field other tools read by name, and deletes an ordinary one', async () => {
  const { app, page } = session;
  await importFixture(app, page);
  await openScalarPanel(page);

  await page.getByTestId('scalar-fields-tab-compute').click();
  await page.getByTestId('scalar-compute-expression').fill('band * 3');
  await page.getByTestId('scalar-compute-slug').fill('tripled');
  await page.getByTestId('scalar-compute-run').click();
  await expect(page.getByTestId('scalar-stats')).toBeVisible({ timeout: 60_000 });

  await page.getByTestId('scalar-fields-tab-fields').click();

  // A coordinate offers no destructive menu at all.
  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="z"]'))
    .toHaveAttribute('data-editable', 'false');
  await expect(page.getByTestId('scalar-field-menu-z')).toHaveCount(0);

  // The derived field deletes, behind an inline confirmation.
  await page.locator('[data-testid="scalar-field-row"][data-slug="tripled"]').hover();
  await page.getByTestId('scalar-field-menu-tripled').click();
  await page.getByTestId('scalar-field-delete-tripled').click();
  await expect(page.getByTestId('scalar-field-delete-confirm-tripled')).toBeVisible();
  // Still there until the confirmation is answered.
  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="tripled"]'))
    .toHaveCount(1);
  await page.getByTestId('scalar-field-delete-apply-tripled').click();

  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="tripled"]'))
    .toHaveCount(0, { timeout: 60_000 });
  // And it leaves the colour picker too.
  await page.getByRole('button', { name: 'Display' }).click();
  await expect(page.getByTestId('display-color-mode')).toBeVisible();
  await expect(page.locator('[data-testid="display-color-mode"] option[value="scalar:tripled"]'))
    .toHaveCount(0, { timeout: 30_000 });
});

test('reports a bad expression without creating a field', async () => {
  const { app, page } = session;
  await importFixture(app, page);
  await openScalarPanel(page);
  await page.getByTestId('scalar-fields-tab-compute').click();

  // An unknown name is caught client-side, before any request.
  await page.getByTestId('scalar-compute-expression').fill('band + nosuchfield');
  await expect(page.getByTestId('scalar-compute-hint')).toBeVisible();
  await expect(page.getByTestId('scalar-compute-run')).toBeDisabled();

  // The offset is RENDERED as a caret under the offending token, not merely
  // carried as metadata — that is what the bespoke error plumbing exists for.
  const caret = page.getByTestId('scalar-compute-caret');
  await expect(caret).toBeVisible();
  await expect(caret).toHaveAttribute('data-col', String('band + '.length));

  // An expression the client accepts but the backend refuses reports the
  // backend's message rather than creating anything.
  await page.getByTestId('scalar-compute-expression').fill('band.__class__');
  await page.getByTestId('scalar-compute-slug').fill('evil');
  const run = page.getByTestId('scalar-compute-run');
  if (await run.isEnabled()) {
    await run.click();
    await expect(page.getByTestId('scalar-fields-error')).toBeVisible({ timeout: 30_000 });
  }
  await page.getByTestId('scalar-fields-tab-fields').click();
  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="evil"]'))
    .toHaveCount(0);
});

// ── Several clouds at once ──────────────────────────────────────────────────
//
// The tool used to be a silent dead click with 2+ scans selected: the toolbar
// button stayed enabled (`requires: 'cloud'` is satisfied by one selected
// cloud) while the panel's mount gated on `selectedIds.size === 1`, so clicking
// flipped the state and rendered nothing. It now acts on a SET of clouds it
// picks itself.
//
// scalar-bands-b.xyz is deliberately DIFFERENT from scalar-bands.xyz so the
// pooled numbers cannot coincidentally equal either cloud's own:
//
//     A (scalar-bands)    1000 pts, band 1..10, mean 5.5
//     B (scalar-bands-b)   500 pts, band 1..5,  mean 3.0
//     pooled              1500 pts,             mean 4.6667
//
// 4.6667 is reachable only by pooling. Returning A's stats (5.5), B's stats
// (3.0), or the mean-of-means (4.25) all fail.

const FIXTURE_B = join(repoRoot, 'tests', 'e2e', 'fixtures', 'scalar-bands-b.xyz');

/** Import both fixtures and leave BOTH scan rows selected in the viewport. */
async function importBoth(app: LaunchedApp['app'], page: LaunchedApp['page']) {
  await importFixture(app, page);
  await importFiles(app, page, 'import-point-cloud', FIXTURE_B);
  await completeImportWizard(page);

  const rowA = page.locator('[data-testid="scan-row"][data-scan-name="scalar-bands"]');
  const rowB = page.locator('[data-testid="scan-row"][data-scan-name="scalar-bands-b"]');
  await expect(rowB).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await rowB.getAttribute('data-point-count')) ?? '0', 10)).toBe(500);

  // Importing B auto-selects it; ctrl-click A to select both.
  await rowA.click({ modifiers: ['ControlOrMeta'] });
  await expect(rowA).toHaveAttribute('data-selected', 'true');
  await expect(rowB).toHaveAttribute('data-selected', 'true');
  return { rowA, rowB };
}

/** The picker row for one cloud, matched EXACTLY.
 *
 * Not `hasText`: "scalar-bands" is a prefix of "scalar-bands-b", so a substring
 * match resolves to both rows and unchecking picks whichever comes first. */
function pickerRow(page: LaunchedApp['page'], name: string) {
  return page.locator(`[data-testid="scalar-scan-row"][data-label="${name}"]`);
}

/** Uncheck one cloud in the panel's own picker (NOT the viewport selection). */
async function uncheckCloud(page: LaunchedApp['page'], name: string) {
  const row = pickerRow(page, name);
  await expect(row).toHaveCount(1);
  await row.locator('input[type="checkbox"]').uncheck();
}

async function checkCloud(page: LaunchedApp['page'], name: string) {
  const row = pickerRow(page, name);
  await expect(row).toHaveCount(1);
  await row.locator('input[type="checkbox"]').check();
}

/** Open the Stats tab on `slug` and wait for the numbers to land. */
async function readStats(page: LaunchedApp['page'], slug: string) {
  await page.getByTestId('scalar-fields-tab-stats').click();
  await page.getByTestId('scalar-stats-field').selectOption(slug);
  await expect(page.getByTestId('scalar-stats')).toBeVisible({ timeout: 30_000 });
}

test('opens and works with two clouds selected', async () => {
  const { app, page } = session;
  await importBoth(app, page);

  // The regression itself: the button must not be a dead click.
  await openScalarPanel(page);
  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="band"]'))
    .toBeVisible();

  // Both clouds arrived in the picker, checked, seeded from the selection.
  await expect(page.locator('[data-testid="scalar-scan-row"][data-checked="true"]'))
    .toHaveCount(2);
});

test('pools statistics across the checked clouds', async () => {
  const { app, page } = session;
  const { rowA, rowB } = await importBoth(app, page);
  await openScalarPanel(page);

  await readStats(page, 'band');
  // Only pooling produces these. A alone is 1000/5.5, B alone 500/3.0, and the
  // mean of the two means is 4.25.
  expect(await statValue(page, 'count')).toBe(1500);
  expect(await statValue(page, 'mean')).toBeCloseTo(4.6667, 3);
  expect(await statValue(page, 'min')).toBeCloseTo(1, 5);
  expect(await statValue(page, 'max')).toBeCloseTo(10, 5);
  await expect(page.getByTestId('scalar-stats-pooled'))
    .toHaveAttribute('data-scan-count', '2');

  // Unchecking B in the PICKER re-measures over A alone …
  await uncheckCloud(page, 'scalar-bands-b');
  await expect.poll(async () => statValue(page, 'count'), { timeout: 30_000 })
    .toBe(1000);
  expect(await statValue(page, 'mean')).toBeCloseTo(5.5, 4);

  // … and does NOT touch the viewport selection. The picker is the tool's own
  // input, not a second way to select things in the scene.
  await expect(rowA).toHaveAttribute('data-selected', 'true');
  await expect(rowB).toHaveAttribute('data-selected', 'true');
});

test('computes a derived field on every checked cloud', async () => {
  const { app, page } = session;
  await importBoth(app, page);
  await openScalarPanel(page);

  await page.getByTestId('scalar-fields-tab-compute').click();
  await page.getByTestId('scalar-compute-expression').fill('band * 2');
  await page.getByTestId('scalar-compute-slug').fill('twice');
  await page.getByTestId('scalar-compute-run').click();

  // Lands on the pooled stats for the new field: band*2 over both clouds.
  await expect(page.getByTestId('scalar-stats')).toBeVisible({ timeout: 90_000 });
  await expect.poll(async () => statValue(page, 'count'), { timeout: 30_000 })
    .toBe(1500);
  expect(await statValue(page, 'mean')).toBeCloseTo(9.3333, 3);

  // It really landed on BOTH, not just the first: read each cloud on its own
  // through the picker rather than reaching into window state.
  await uncheckCloud(page, 'scalar-bands-b');
  await expect.poll(async () => statValue(page, 'count'), { timeout: 30_000 })
    .toBe(1000);
  expect(await statValue(page, 'mean')).toBeCloseTo(11, 4);

  await checkCloud(page, 'scalar-bands-b');
  await uncheckCloud(page, 'scalar-bands');
  await expect.poll(async () => statValue(page, 'count'), { timeout: 30_000 })
    .toBe(500);
  expect(await statValue(page, 'mean')).toBeCloseTo(6, 4);
});

test('hides a field the other checked cloud does not carry', async () => {
  const { app, page } = session;
  await importBoth(app, page);
  await openScalarPanel(page);

  // Derive a field on A alone.
  await uncheckCloud(page, 'scalar-bands-b');
  await page.getByTestId('scalar-fields-tab-compute').click();
  await page.getByTestId('scalar-compute-expression').fill('band + 1');
  await page.getByTestId('scalar-compute-slug').fill('only_a');
  await page.getByTestId('scalar-compute-run').click();
  await expect(page.getByTestId('scalar-stats')).toBeVisible({ timeout: 90_000 });

  await page.getByTestId('scalar-fields-tab-fields').click();
  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="only_a"]'))
    .toHaveCount(1);

  // Re-check B: the field is not on every checked cloud, so it is not offered —
  // and the panel says how many it hid rather than leaving it a mystery.
  await checkCloud(page, 'scalar-bands-b');
  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="only_a"]'))
    .toHaveCount(0, { timeout: 30_000 });
  const note = page.getByTestId('scalar-omitted-note').first();
  await expect(note).toBeVisible();
  await expect(note).toHaveAttribute('data-count', '1');
});

test('refuses to pool coordinates across clouds, but measures them on one', async () => {
  const { app, page } = session;
  await importBoth(app, page);
  await openScalarPanel(page);

  // Each cloud stores z in its own frame, so a pooled z would average
  // positions that are not in the same frame.
  const zRow = page.locator('[data-testid="scalar-field-row"][data-slug="z"]');
  await expect(zRow).toHaveAttribute('data-blocked', 'true');

  // On a single cloud it is an ordinary measurable field again.
  await uncheckCloud(page, 'scalar-bands-b');
  await expect(zRow).not.toHaveAttribute('data-blocked', 'true', { timeout: 30_000 });
  await readStats(page, 'z');
  expect(await statValue(page, 'count')).toBe(1000);
});

test('renames a field on every checked cloud', async () => {
  const { app, page } = session;
  await importBoth(app, page);
  await openScalarPanel(page);

  // `band` is imported on both clouds, so a rename must reach both or the two
  // stop sharing a slug and the field drops out of the list entirely.
  await page.locator('[data-testid="scalar-field-row"][data-slug="band"]').hover();
  await page.getByTestId('scalar-field-menu-band').click();
  await page.getByTestId('scalar-field-rename-band').click();
  const nameInput = page.getByTestId('scalar-field-name-input-band');
  await expect(nameInput).toBeVisible();
  await nameInput.fill('level');
  await page.getByTestId('scalar-field-name-apply-band').click();

  const renamed = page.locator('[data-testid="scalar-field-row"][data-slug="level"]');
  await expect(renamed).toHaveCount(1, { timeout: 60_000 });
  // Still listed with BOTH clouds checked — which is only true if both were
  // renamed. A half-applied rename would leave neither name in the list.
  await expect(page.locator('[data-testid="scalar-scan-row"][data-checked="true"]'))
    .toHaveCount(2);
  await expect(page.locator('[data-testid="scalar-field-row"][data-slug="band"]'))
    .toHaveCount(0);

  await readStats(page, 'level');
  expect(await statValue(page, 'count')).toBe(1500);
  expect(await statValue(page, 'mean')).toBeCloseTo(4.6667, 3);
});
