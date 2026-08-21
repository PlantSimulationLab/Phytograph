import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubExportFolder } from './helpers/exportFolder';
import { completeImportWizard } from './helpers/importWizard';

// The export pill has to show REAL progress, not a spinner.
//
// /api/scan/export-xml used to be one buffered POST covering every checked
// object, so the pill could only say "Exporting…" for the whole run and its
// cancel X did nothing. It now streams PHP1 progress markers, and this asserts
// the renderer actually receives them: distinct backend stages naming each
// object, fractions that advance, and at least one strictly between 0 and 1 —
// which is what separates a determinate bar from an indeterminate one.
//
// Its own app instance: the recorder must be installed before the export starts
// and the assertions are about a single run's timeline.
test('the export pill reports real per-object progress from the backend', async () => {
  const { app, page, close } = await launchApp();

  try {
    const outDir = mkdtempSync(join(tmpdir(), 'phytograph-export-progress-'));

    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
    await stubOpenDialog(app, xmlFixture);

    await page.getByTestId('tool-add-scan').click();
    await expect(page.getByTestId('scan-parameters-popup')).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(page.getByTestId('scan-parameters-popup')).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    await expect(page.getByTestId('scans-panel').locator('[data-testid="scan-row"]'))
      .toHaveCount(4, { timeout: 30_000 });

    // Opt into the renderer's stage recorder (exportScanXmlBundle pushes each
    // backend marker here as it arrives). The pill's rendered text is a single
    // live value, so scraping it can miss stages React batches into one paint.
    await page.evaluate(() => {
      (window as unknown as { __exportStages: string[] }).__exportStages = [];
    });

    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await expect(page.getByTestId('export-modal')).toBeVisible();
    await page.getByTestId('export-scan-mode-data').click();
    await page.getByTestId('export-scan-format-xyz').click();
    // Re-stubs dialog:open (the fixture import above is already done) to the
    // destination folder; the base name defaults to "scans" for a batch.
    await stubExportFolder(app, page, outDir);
    await page.getByTestId('export-scan-xml').click();

    await expect(page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }))
      .toBeVisible({ timeout: 120_000 });

    const stages = await page.evaluate(
      () => (window as unknown as { __exportStages: string[] }).__exportStages);

    // Each entry is "<fraction>|<message>".
    const messages = stages.map(s => s.split('|').slice(1).join('|'));
    const fractions = stages
      .map(s => s.split('|')[0])
      .filter(f => f !== '')
      .map(Number);

    // Every scan is named as it is written — this is the per-object advance the
    // pill needs for a multi-object export.
    expect(messages.some(m => /\(1\/4\)/.test(m))).toBe(true);
    expect(messages.some(m => /\(4\/4\)/.test(m))).toBe(true);
    expect(new Set(messages).size).toBeGreaterThanOrEqual(3);

    // A determinate bar: monotonic, finishing at 1, and passing through the
    // middle rather than jumping 0 → 100.
    expect(fractions.length).toBeGreaterThanOrEqual(4);
    const sorted = [...fractions].sort((a, b) => a - b);
    expect(fractions).toEqual(sorted);
    expect(fractions.some(f => f > 0 && f < 1)).toBe(true);
    expect(fractions[fractions.length - 1]).toBeCloseTo(1, 5);

    // …and the run really did write the four files it was reporting on, each
    // named for the scan it holds (the Scans panel's own labels, slugged), not
    // by the order the scans happened to be added.
    const panelNames = await page.getByTestId('scans-panel')
      .locator('[data-testid="scan-row-name"]').allTextContents();
    expect(panelNames).toHaveLength(4);
    const expected = panelNames
      .map(n => `scans_${n.trim().replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/[^A-Za-z0-9._-]+/g, '_')}.xyz`)
      .sort();
    expect(readdirSync(outDir).sort()).toEqual(expected);
  } finally {
    await close();
  }
});
