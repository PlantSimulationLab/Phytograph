import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURES = join(repoRoot, 'tests', 'e2e', 'fixtures');

// The import wizard intercepts every path-backed point-cloud import. These tests
// drive its real DOM: preview table, per-column controls, the multi-scan
// stepper, and the categorical mark — then assert the imported cloud reflects
// the choices (categorical legend vs. continuous colorbar, expected counts).

test('wizard previews columns and imports with auto-detect', async () => {
  const { app, page, close } = await launchApp();
  try {
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
  } finally {
    await close();
  }
});

test('marking a column as a Label in the wizard yields a class legend', async () => {
  const { app, page, close } = await launchApp();
  try {
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

    // Color by the marked categorical field. The slug is "Target_Index".
    await colorMode.selectOption('scalar:Target_Index');
    await expect(colorMode).toHaveValue('scalar:Target_Index');

    // A categorical field shows the discrete class legend, NOT the continuous
    // colorbar — this is the wizard's categorical mark taking effect end-to-end.
    const legend = page.getByTestId('class-legend');
    await expect(legend).toBeVisible();
    await expect(legend).toHaveAttribute('data-legend-attribute', 'Target_Index');
    await expect(page.getByTestId('colorbar')).toBeHidden();
  } finally {
    await close();
  }
});

test('mapping columns to Scan Row/Column Index carries the raster grid', async () => {
  // raster-grid.xyz is a 3x3 rasterised scan whose last two columns (idx_a,
  // idx_b) are the integer (row, column) position within the scanner grid. Their
  // headers don't auto-detect as grid roles, so the user must pick "Scan Row
  // Index" / "Scan Column Index" from the dropdown. After import those columns
  // must be carried under the CANONICAL slugs (row_index/column_index) so the
  // gap-filling miss-recovery path finds the raster by name — we assert that by
  // colouring the scan by each slug.
  const { app, page, close } = await launchApp();
  try {
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
  } finally {
    await close();
  }
});

test('E57 fixed columns display their real roles, not a Scalar fallback', async () => {
  // Regression: an in-file format (E57) fixes its layout, so the role dropdowns
  // are non-editable. They must still SHOW each column's actual role (X / Y / Z /
  // Intensity) — previously the non-remappable dropdown was filtered to only
  // Scalar/Label options, so x/y/z fell back to displaying the first option
  // ("Scalar"). structured-scan.e57 carries x/y/z + intensity.
  const { app, page, close } = await launchApp();
  try {
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
  } finally {
    await close();
  }
});

test('E57 with colour shows RGB columns but hides the 0-255/0-1 toggle', async () => {
  // The RGB range toggle is for ASCII files, where the wizard can't tell 8-bit
  // ints from floats. An in-file format (E57) records the colour encoding, so
  // the converter already normalises it — the toggle would be misleading dead UI
  // (buildColumnPlan returns null for non-remappable scans, so it has no effect).
  // structured-scan-color.e57 carries x/y/z + intensity + RGB.
  const { app, page, close } = await launchApp();
  try {
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
  } finally {
    await close();
  }
});

test('wizard steps through a multi-file import', async () => {
  const { app, page, close } = await launchApp();
  try {
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
  } finally {
    await close();
  }
});

test('apply-to-all enables import without stepping through every scan', async () => {
  const { app, page, close } = await launchApp();
  try {
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
  } finally {
    await close();
  }
});

test('mesh import does not open the wizard', async () => {
  const { app, page, close } = await launchApp();
  try {
    await importFiles(app, page, 'import-mesh', join(FIXTURES, 'quad.obj'));
    // The wizard must NOT appear for a mesh import.
    await expect(page.getByTestId('import-wizard')).toBeHidden();
    // The mesh loads directly.
    await expect(page.locator('canvas').first()).toBeAttached();
  } finally {
    await close();
  }
});
