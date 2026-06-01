import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURES = join(repoRoot, 'tests', 'e2e', 'fixtures');

// The import wizard intercepts every path-backed point-cloud import. These tests
// drive its real DOM: preview table, per-column controls, the multi-scan
// stepper, and the categorical mark — then assert the imported cloud reflects
// the choices (categorical legend vs. continuous colorbar, expected counts).

test('wizard previews columns and imports with auto-detect', async () => {
  const { page, close } = await launchApp();
  try {
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-pointcloud').click(),
    ]);
    await chooser.setFiles(join(FIXTURES, 'scalars.xyz'));

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
  const { page, close } = await launchApp();
  try {
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-pointcloud').click(),
    ]);
    await chooser.setFiles(join(FIXTURES, 'scalars.xyz'));

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
    await row.click();

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

test('wizard steps through a multi-file import', async () => {
  const { page, close } = await launchApp();
  try {
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-pointcloud').click(),
    ]);
    // Two distinct point clouds at once → one wizard stepping through both.
    await chooser.setFiles([join(FIXTURES, 'tiny.xyz'), join(FIXTURES, 'scalars.xyz')]);

    const wizard = page.getByTestId('import-wizard');
    await expect(wizard).toBeVisible({ timeout: 30_000 });
    // Stepper shows "scan 1 of 2".
    await expect(page.getByTestId('import-wizard-step')).toContainText('1 of 2');
    // Advance to the second scan, then back.
    await page.getByTestId('import-wizard-next').click();
    await expect(page.getByTestId('import-wizard-step')).toContainText('2 of 2');

    // Import enables once both previews are ready (we previewed both up front).
    const importBtn = page.getByTestId('import-wizard-import');
    await expect(importBtn).toBeEnabled({ timeout: 30_000 });
    await importBtn.click();
    await expect(wizard).toBeHidden();

    await expect(page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]')).toBeVisible({ timeout: 20_000 });
  } finally {
    await close();
  }
});

test('mesh import does not open the wizard', async () => {
  const { page, close } = await launchApp();
  try {
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-mesh').click(),
    ]);
    await chooser.setFiles(join(FIXTURES, 'quad.obj'));
    // The wizard must NOT appear for a mesh import.
    await expect(page.getByTestId('import-wizard')).toBeHidden();
    // The mesh loads directly.
    await expect(page.locator('canvas').first()).toBeAttached();
  } finally {
    await close();
  }
});
