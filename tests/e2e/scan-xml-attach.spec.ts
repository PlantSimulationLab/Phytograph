import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// Helios XML carries an optional <filename> tag pointing to the recorded
// point-data file. When the importer can resolve that file (here: same
// directory as the XML), it loads the points and attaches them to the new
// scan automatically, so the resulting row carries both params AND data.
test('Helios XML import auto-attaches referenced point data', async () => {
  const { app, page, close } = await launchApp();

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny-scan.xml');
    // tiny-scan.xml references "tiny.xyz" alongside it — the resolver will
    // try `<xml-dir>/tiny.xyz` first and find it. No prompt happens.
    await stubOpenDialog(app, xmlFixture);


    const panel = page.getByTestId('scans-panel');
    await expect(panel).toBeVisible();
    const rows = panel.locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(0);

    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 15_000 });

    // The XML import runs through the same import wizard once its referenced
    // file (tiny.xyz) is resolved. Complete it with auto-detected columns.
    await completeImportWizard(page);

    // One row → params from XML, data attached from <filename>.
    await expect(rows).toHaveCount(1);
    const row = rows.first();
    await expect(row).toContainText('origin (0.50, -1.00, 0.25)');
    // tiny.xyz has 60 points (62 lines, two comment lines).
    await expect(row).toContainText('60 pts');
    // Both data and params present → no attach buttons.
    await expect(row.locator('[data-testid^="scan-attach-data-"]')).toHaveCount(0);
    await expect(row.locator('[data-testid^="scan-attach-params-"]')).toHaveCount(0);
    // data-attribute sanity check.
    await expect(row).toHaveAttribute('data-has-data', 'true');
    await expect(row).toHaveAttribute('data-has-params', 'true');
  } finally {
    await close();
  }
});
