import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const FIXTURES = join(repoRoot, 'tests', 'e2e', 'fixtures');

// The import wizard intercepts every path-backed point-cloud import. These tests
// drive its real DOM: preview table, per-column controls, the multi-scan
// stepper, and the categorical mark — then assert the imported cloud reflects
// the choices (categorical legend vs. continuous colorbar, expected counts).
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

test('wizard previews columns and imports with auto-detect', async () => {
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', join(FIXTURES, 'scalars.xyz'));

  // The wizard appears with a column-mapping table. scalars.xyz has 6
  // columns (X, Y, Z, Timestamp, Deviation, Target Index).
  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout: 30_000 });
  const cols = page.getByTestId('import-wizard-column');
  await expect(cols).toHaveCount(6, { timeout: 30_000 });

  // CloudCompare-style layout: each file column is a header with a role
  // dropdown, and the file's first rows preview underneath. scalars.xyz has
  // 60 data rows; the wizard shows the first 10.
  await expect(page.getByTestId('import-wizard-preview-row')).toHaveCount(10);

  // X/Y/Z auto-detected → Import enables.
  const importBtn = page.getByTestId('import-wizard-import');
  await expect(importBtn).toBeEnabled();
  await importBtn.click();
  await expect(wizard).toBeHidden();

  const row = page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);
});

test('marking a column as a Label in the wizard yields a class legend', async () => {
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', join(FIXTURES, 'scalars.xyz'));

  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout: 30_000 });

  // Column index 5 is "Target Index[]" — a small-integer class column. It
  // defaults to the 'Scalar' role (continuous); set it to 'Label' so it
  // colours as discrete classes.
  const targetCol = page.locator('[data-testid="import-wizard-column"][data-col-index="5"]');
  await expect(targetCol).toBeVisible();
  const role = targetCol.getByTestId('import-wizard-role');
  await role.selectOption('label');
  await expect(role).toHaveValue('label');

  await page.getByTestId('import-wizard-import').click();
  await expect(wizard).toBeHidden();

  const row = page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(row).toHaveAttribute('data-selected', 'true');

  await page.getByRole('button', { name: 'Display' }).click();
  const colorMode = page.getByTestId('display-color-mode');
  await expect(colorMode).toBeVisible();

  // Color by the marked categorical field. "Target Index[]" is a RECOGNISED
  // multi-return column, so it canonicalises to the slug `target_index` (see
  // _CANONICAL_NAME_ALIASES) rather than keeping a header-derived spelling —
  // that is what makes it visible to Backfill Misses and LAD. The other specs
  // (export-scalar-columns, backfill-misses) already assert the canonical
  // slug; this one was missed when the vocabulary was consolidated.
  await colorMode.selectOption('scalar:target_index');
  await expect(colorMode).toHaveValue('scalar:target_index');

  // A categorical field shows the discrete class legend, NOT the continuous
  // colorbar — this is the wizard's categorical mark taking effect end-to-end.
  const legend = page.getByTestId('class-legend');
  await expect(legend).toBeVisible();
  await expect(legend).toHaveAttribute('data-legend-attribute', 'target_index');
  await expect(page.getByTestId('colorbar')).toBeHidden();
});

test('mapping columns to Scan Row/Column Index carries the raster grid', async () => {
  // raster-grid.xyz is a 3x3 rasterised scan whose last two columns (idx_a,
  // idx_b) are the integer (row, column) position within the scanner grid. Their
  // headers don't auto-detect as grid roles, so the user must pick "Scan Row
  // Index" / "Scan Column Index" from the dropdown. After import those columns
  // must be carried under the CANONICAL slugs (row_index/column_index) so the
  // gap-filling miss-recovery path finds the raster by name — we assert that by
  // colouring the scan by each slug.
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', join(FIXTURES, 'raster-grid.xyz'));

  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout: 30_000 });

  const roleAt = (colIndex: number) =>
    page.locator(`[data-testid="import-wizard-column"][data-col-index="${colIndex}"]`)
      .getByTestId('import-wizard-role');
  // idx_a (col 3) and idx_b (col 4) default to the generic Scalar role; map
  // them to the dedicated grid-index roles via the dropdown.
  await roleAt(3).selectOption('row_index');
  await expect(roleAt(3)).toHaveValue('row_index');
  await roleAt(4).selectOption('column_index');
  await expect(roleAt(4)).toHaveValue('column_index');

  await page.getByTestId('import-wizard-import').click();
  await expect(wizard).toBeHidden();

  const row = page.locator('[data-testid="scan-row"][data-scan-name="raster-grid.xyz"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(9);

  // Both grid fields are colourable under their canonical slug + label — proof
  // the dropdown roles pinned the slugs the recovery path looks up by name.
  await page.getByRole('button', { name: 'Display' }).click();
  const colorMode = page.getByTestId('display-color-mode');
  await expect(colorMode).toBeVisible();
  await colorMode.selectOption('scalar:row_index');
  await expect(colorMode).toHaveValue('scalar:row_index');
  await colorMode.selectOption('scalar:column_index');
  await expect(colorMode).toHaveValue('scalar:column_index');
});

test('unticking Import drops an ASCII column from the imported cloud', async () => {
  // scalars.xyz carries Timestamp (col 3), Deviation (col 4) and Target Index
  // (col 5). Untick Deviation: the points must all still import, but the field
  // must be GONE from the Color-by menu — the ASCII skip travels as role 'skip'
  // inside the column plan, and the backend never materialises the column.
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', join(FIXTURES, 'scalars.xyz'));

  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout: 30_000 });

  const colAt = (i: number) =>
    page.locator(`[data-testid="import-wizard-column"][data-col-index="${i}"]`);
  // X/Y/Z are mandatory, so they carry no checkbox at all.
  await expect(colAt(0).getByTestId('import-wizard-include')).toHaveCount(0);
  await expect(colAt(1).getByTestId('import-wizard-include')).toHaveCount(0);
  await expect(colAt(2).getByTestId('import-wizard-include')).toHaveCount(0);

  const deviationBox = colAt(4).getByTestId('import-wizard-include');
  await expect(deviationBox).toBeChecked();
  await deviationBox.uncheck();
  // The role select follows the checkbox, so the two controls never disagree.
  await expect(colAt(4).getByTestId('import-wizard-role')).toHaveValue('skip');

  await page.getByTestId('import-wizard-import').click();
  await expect(wizard).toBeHidden();

  const row = page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  // Dropping a COLUMN must not drop any POINT.
  expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);

  await page.getByRole('button', { name: 'Display' }).click();
  const colorMode = page.getByTestId('display-color-mode');
  await expect(colorMode).toBeVisible();
  const options = await colorMode.locator('option').evaluateAll(
    (els) => els.map((e) => (e as HTMLOptionElement).value));
  // The dropped field is gone…
  expect(options).not.toContain('scalar:Deviation');
  // …while its neighbours, which stayed ticked, survived. Without this the test
  // would also pass if the import had silently carried no scalars at all.
  // (Target Index is pinned to its canonical lower-case slug by the backend.)
  expect(options).toContain('scalar:target_index');
  expect(options).toContain('scalar:timestamp');
});

test('unticking Import drops a field from an in-file format (PLY)', async () => {
  // The half with no mechanism before this change: an in-file format fixes its
  // layout, so there is no column position to skip. The choice travels as a slug
  // list (drop_slugs) and the backend filters the session's extras by name.
  // tiny-scalars.ply carries x/y/z plus two carried scalars (deviation,
  // tree_id) — tiny.ply's lone `reflectance` is consumed as the intensity
  // channel by the PLY reader, so it never becomes a droppable extra dim.
  const { app, page } = session;
  // The Display button TOGGLES the panel, so clicking it unconditionally would
  // close an already-open panel and leave us reading a stale/absent select.
  const readOptions = async () => {
    const colorMode = page.getByTestId('display-color-mode');
    if (!(await colorMode.isVisible())) {
      await page.getByRole('button', { name: 'Display' }).click();
    }
    await expect(colorMode).toBeVisible();
    return colorMode.locator('option').evaluateAll(
      (els) => els.map((e) => (e as HTMLOptionElement).value));
  };

  // Control run: import untouched, and confirm reflectance IS offered. Without
  // this half, a bug that dropped every scalar would pass the assertion below.
  await importFiles(app, page, 'import-point-cloud', join(FIXTURES, 'tiny-scalars.ply'));
  await expect(page.getByTestId('import-wizard')).toBeVisible({ timeout: 30_000 });
  await completeImportWizard(page);
  await expect(page.locator('[data-testid="scan-row"]').first())
    .toBeVisible({ timeout: 20_000 });
  const before = await readOptions();
  expect(before).toContain('scalar:deviation');
  expect(before).toContain('scalar:tree_id');

  // Same file again, this time unticking reflectance.
  await resetToFreshScene(session.app, session.page);
  await importFiles(app, page, 'import-point-cloud', join(FIXTURES, 'tiny-scalars.ply'));
  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout: 30_000 });

  const reflCol = page.locator('[data-testid="import-wizard-column"]')
    .filter({ hasText: 'deviation' }).first();
  // The file fixes the layout, so this column can't be REMAPPED — its dropdown
  // offers only the Scalar/Label colouring choice. Membership is nonetheless
  // the user's call now, which is exactly what the checkbox adds.
  const roleOptions = await reflCol.getByTestId('import-wizard-role')
    .locator('option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(roleOptions).not.toContain('x');
  const box = reflCol.getByTestId('import-wizard-include');
  await expect(box).toBeChecked();
  await box.uncheck();

  await completeImportWizard(page);
  const row = page.locator('[data-testid="scan-row"]').first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  // Dropping a column must not drop any point.
  expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);
  const after = await readOptions();
  expect(after).not.toContain('scalar:deviation');
  // The sibling scalar, left ticked, still made it — so this is a targeted
  // drop, not a wholesale loss of the file's scalars.
  expect(after).toContain('scalar:tree_id');
});

test('E57 fixed columns display their real roles, not a Scalar fallback', async () => {
  // Regression: an in-file format (E57) fixes its layout, so the role dropdowns
  // are non-editable. They must still SHOW each column's actual role (X / Y / Z /
  // Intensity) — previously the non-remappable dropdown was filtered to only
  // Scalar/Label options, so x/y/z fell back to displaying the first option
  // ("Scalar"). structured-scan.e57 carries x/y/z + intensity.
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', join(FIXTURES, 'structured-scan.e57'));

  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout: 30_000 });

  // Columns are x, y, z, intensity (in order). Each column's role select shows
  // its own role, and is disabled (the file fixes the layout).
  const roleAt = (colIndex: number) =>
    page.locator(`[data-testid="import-wizard-column"][data-col-index="${colIndex}"]`)
      .getByTestId('import-wizard-role');
  await expect(roleAt(0)).toHaveValue('x');
  await expect(roleAt(1)).toHaveValue('y');
  await expect(roleAt(2)).toHaveValue('z');
  await expect(roleAt(3)).toHaveValue('intensity');
  await expect(roleAt(0)).toBeDisabled();

  // None of the fixed columns render as the Scalar fallback.
  const roles = page.getByTestId('import-wizard-role');
  const count = await roles.count();
  for (let i = 0; i < count; i++) {
    await expect(roles.nth(i)).not.toHaveValue('extra');
  }

  await completeImportWizard(page);
  await expect(page.locator('[data-testid="scan-row"]').first())
    .toBeVisible({ timeout: 20_000 });
});

test('E57 with colour shows RGB columns but hides the 0-255/0-1 toggle', async () => {
  // The RGB range toggle is for ASCII files, where the wizard can't tell 8-bit
  // ints from floats. An in-file format (E57) records the colour encoding, so
  // the converter already normalises it — the toggle would be misleading dead UI
  // (buildColumnPlan returns null for non-remappable scans, so it has no effect).
  // structured-scan-color.e57 carries x/y/z + intensity + RGB.
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', join(FIXTURES, 'structured-scan-color.e57'));

  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout: 30_000 });

  // The colour columns are present (red/green/blue), proving the toggle's
  // absence is the deliberate suppression, not just "no RGB here".
  const roleAt = (colIndex: number) =>
    page.locator(`[data-testid="import-wizard-column"][data-col-index="${colIndex}"]`)
      .getByTestId('import-wizard-role');
  await expect(roleAt(4)).toHaveValue('r');
  await expect(roleAt(5)).toHaveValue('g');
  await expect(roleAt(6)).toHaveValue('b');

  // The 0-255 / 0-1 toggle is hidden for this in-file format.
  await expect(page.getByTestId('import-wizard-rgb-255')).toHaveCount(0);
  await expect(page.getByTestId('import-wizard-rgb-01')).toHaveCount(0);

  await completeImportWizard(page);
  await expect(page.locator('[data-testid="scan-row"]').first())
    .toBeVisible({ timeout: 20_000 });
});

test('wizard steps through a multi-file import', async () => {
  const { app, page } = session;
  // Two distinct point clouds at once → one wizard stepping through both.
  await importFiles(app, page, 'import-point-cloud', [join(FIXTURES, 'tiny.xyz'), join(FIXTURES, 'scalars.xyz')]);

  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout: 30_000 });
  // Stepper shows "scan 1 of 2".
  await expect(page.getByTestId('import-wizard-step')).toContainText('1 of 2');

  // On scan 1 of 2 the user hasn't seen the later scan(s) and hasn't opted to
  // apply settings to all, so Import is gated even though both previews are
  // ready — a hint explains why.
  const importBtn = page.getByTestId('import-wizard-import');
  await expect(importBtn).toBeDisabled();
  await expect(page.getByTestId('import-wizard-review-hint')).toBeVisible();

  // Advance to the second (last) scan → the user has now reviewed every scan,
  // so Import enables and the hint disappears.
  await page.getByTestId('import-wizard-next').click();
  await expect(page.getByTestId('import-wizard-step')).toContainText('2 of 2');
  await expect(importBtn).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId('import-wizard-review-hint')).toBeHidden();
  await importBtn.click();
  await expect(wizard).toBeHidden();

  await expect(page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]')).toBeVisible({ timeout: 20_000 });
});

test('apply-to-all enables import without stepping through every scan', async () => {
  const { app, page } = session;
  // Two clouds with the SAME column layout so "apply to all" is meaningful.
  await importFiles(app, page, 'import-point-cloud', [join(FIXTURES, 'scalars.xyz'), join(FIXTURES, 'scalars.xyz')]);

  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('import-wizard-step')).toContainText('1 of 2');

  // Still on scan 1 — Import is gated.
  const importBtn = page.getByTestId('import-wizard-import');
  await expect(importBtn).toBeDisabled();

  // Checking "apply to all" tells the wizard the user's choices cover every
  // scan, so Import enables without visiting the later scan(s).
  await page.getByTestId('import-wizard-apply-all').check();
  await expect(importBtn).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId('import-wizard-review-hint')).toBeHidden();

  // Shared-session hygiene: this test never imports, so dismiss the wizard —
  // its full-screen modal (which swallows Escape) would otherwise block the
  // File → New reset before the next test.
  await wizard.getByRole('button', { name: 'Cancel' }).last().click();
  await expect(wizard).toBeHidden();
});

test('mesh import does not open the wizard', async () => {
  const { app, page } = session;
  await importFiles(app, page, 'import-mesh', join(FIXTURES, 'quad.obj'));
  // The wizard must NOT appear for a mesh import.
  await expect(page.getByTestId('import-wizard')).toBeHidden();
  // The mesh loads directly.
  await expect(page.locator('canvas').first()).toBeAttached();
});

test('a params-less import still expands to show its fields and extent', async () => {
  // THE GAP: the expand chevron used to be gated on the scan carrying scan
  // PARAMETERS, which only a .riproject/.PROJ/E57/XML import produces. A plain
  // .xyz/.laz import therefore had no way to answer "which scalar columns
  // actually came through?" — the one question the wizard's own choices make
  // most pressing — because the Color-by dropdown hides constant and builtin
  // columns and so cannot distinguish "dropped" from "kept but flat".
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', join(FIXTURES, 'scalars.xyz'));

  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('import-wizard-import').click();
  await expect(wizard).toBeHidden();

  const row = page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  // Precondition: this really is a scan with NO parameters — the case that
  // previously had no chevron at all.
  await expect(row).toHaveAttribute('data-has-params', 'false');

  const scanId = await row.getAttribute('data-scan-id');
  expect(scanId).not.toBeNull();
  await page.getByTestId(`scan-expand-${scanId}`).click();

  // Cloud provenance: point count and the hits-only extent. scalars.xyz spans
  // 0–2.0 m in X (11 columns at 0.2 m) — assert the real number, not merely
  // that some text appeared.
  const info = page.getByTestId(`scan-cloud-info-${scanId}`);
  await expect(info).toBeVisible();
  await expect(info).toContainText('points: 60');
  await expect(info).toContainText('extent:');
  await expect(info).toContainText('source: scalars.xyz');

  // Fields: the file's three non-geometry columns, under the DISPLAY labels the
  // wizard gave them (the same names the Color-by picker uses).
  const cols = page.getByTestId(`scan-columns-${scanId}`);
  await expect(cols).toBeVisible();
  const listed = ((await cols.locator('[data-columns]').getAttribute('data-columns')) ?? '').split(',');
  expect(listed).toContain('Timestamp');
  expect(listed).toContain('Deviation');
  expect(listed).toContain('Target Index');
  // Each exactly once. `gps-time` and `timestamp` are two buffer keys for one
  // quantity and both label "Timestamp"; deduping on the raw key printed it
  // twice and read as two separate fields.
  expect(listed.filter((c) => c === 'Timestamp')).toHaveLength(1);
  // Geometry is not a scalar field.
  expect(listed).not.toContain('position');

  // The LAS schema dimensions PotreeConverter writes for EVERY source — none of
  // which are in this 6-column ASCII file — are listed separately as empty
  // rather than mixed in, which is what buried the three real columns.
  const empty = ((await cols.locator('[data-empty-columns]').getAttribute('data-empty-columns')) ?? '').split(',');
  expect(empty).toContain('user data');
  expect(empty).toContain('point source id');
  expect(empty).toContain('scan angle rank');
  for (const real of ['Timestamp', 'Deviation', 'Target Index']) {
    expect(empty).not.toContain(real);
  }

  // Collapsing hides both blocks again.
  await page.getByTestId(`scan-expand-${scanId}`).click();
  await expect(info).toBeHidden();
  await expect(cols).toBeHidden();
});

// Error text in a dialog must be SELECTABLE so the user can copy it into a bug
// report. The app root sets `select-none` (right for the 3D viewport, where a
// drag would otherwise smear a selection across the UI), and that inherits into
// every dialog — so the one string a user most needs to copy was the one string
// they could not. Toasts had opted back in with `select-text`; the ~30 popups,
// dialogs and panels that render inline errors had not.
//
// Asserted against the REAL rendered element via getComputedStyle, not by
// grepping for a class: what matters is the value the browser actually resolves
// after the cascade, since an inherited `select-none` beats a rule that never
// matched.
test('wizard warning text is selectable so it can be copied', async () => {
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', join(FIXTURES, 'scalars.xyz'));

  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout: 30_000 });

  // Untick Target Index (col 5) — a PROTECTED slug, so the wizard raises its
  // real inline warning. This is the genuine UI path, not an injected string.
  const targetIdx = page
    .locator('[data-testid="import-wizard-column"][data-col-index="5"]')
    .getByTestId('import-wizard-include');
  await expect(targetIdx).toBeChecked();
  await targetIdx.uncheck();

  const warn = page.getByTestId('import-wizard-drop-warning');
  await expect(warn).toBeVisible();

  // The element that actually holds the text resolves to `user-select: text`
  // despite the ancestor `select-none`. Asserted on the COMPUTED value, not on
  // the presence of a class: an inherited `select-none` silently beats a rule
  // that never matched, and only the resolved value proves the cascade won.
  const warnSelect = await warn.evaluate((el) => getComputedStyle(el).userSelect);
  expect(warnSelect).toBe('text');
  expect((await warn.innerText()).trim().length).toBeGreaterThan(10);

  // The fix must stay scoped: ordinary chrome is still unselectable, so a drag
  // in the viewport can't smear a selection across the UI.
  const rootSelect = await page
    .getByTestId('app-root')
    .evaluate((el) => getComputedStyle(el).userSelect);
  expect(rootSelect).toBe('none');
});
