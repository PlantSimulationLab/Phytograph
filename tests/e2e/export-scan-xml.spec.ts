import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubSaveDialog, getSaveDialogCalls } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';

// Exports the four-scan sphere fixture to a Helios XML + per-scan ASCII bundle
// through the real UI (the workflow that previously rendered an empty Export
// panel for a multi-scan selection). Drives: import 4 scans → File→Export →
// scan list with all four checked → Write scan XML → real backend exportScans()
// → real files written to disk. Asserts the bundle is one XML + four .xyz files,
// the XML references each per-scan file, and the bundle re-loads (round-trips).
test('exports a multi-scan XML bundle for the sphere fixture', async () => {
  const { app, page, close } = await launchApp();

  // A real folder the export writes into (the save dialog returns <dir>/sphere.xml).
  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-scanexport-'));
  const xmlPath = join(outDir, 'sphere.xml');

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
    await stubOpenDialog(app, xmlFixture);
    await stubSaveDialog(app, xmlPath);

    // Import the four scans from XML.
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const rows = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(4, { timeout: 20_000 });
    for (let i = 0; i < 4; i++) {
      await expect(rows.nth(i)).toHaveAttribute('data-has-params', 'true');
    }

    // Open the Export panel via the File→Export path (window.__openExportPanel),
    // exactly as the application menu does.
    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await expect(page.getByTestId('export-panel')).toBeVisible();

    // The scan-export section must appear (it was empty before the fix) and list
    // all four scans, pre-checked to the current (all-selected) selection.
    const scanSection = page.getByTestId('export-scan-section');
    await expect(scanSection).toBeVisible();
    const scanRows = page.getByTestId('export-scan-row');
    await expect(scanRows).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(scanRows.nth(i)).toHaveAttribute('data-checked', 'true');
    }

    // Write the bundle. The save dialog is stubbed to xmlPath; real fs writes run.
    await page.getByTestId('export-scan-xml').click();

    // The save dialog must have actually fired (catches a silent no-op).
    await expect.poll(async () => (await getSaveDialogCalls(app)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Wait for the bundle to land on disk: sphere.xml + sphere_0..3.xyz.
    await expect.poll(
      () => (existsSync(xmlPath) ? readdirSync(outDir).filter(f => f.endsWith('.xyz')).length : 0),
      { timeout: 30_000, intervals: [200, 500, 1000] },
    ).toBe(4);

    // The XML references each per-scan data file (not a single merged file).
    const xml = readFileSync(xmlPath, 'utf-8');
    for (let i = 0; i < 4; i++) {
      expect(xml).toContain(`sphere_${i}.xyz`);
    }
    // Each data file has a '#'-prefixed header and at least one data row.
    const dataFiles = readdirSync(outDir).filter(f => f.endsWith('.xyz'));
    expect(dataFiles).toHaveLength(4);
    for (const f of dataFiles) {
      const lines = readFileSync(join(outDir, f), 'utf-8').split('\n').filter(l => l.trim());
      expect(lines[0].startsWith('#')).toBe(true);
      const dataRows = lines.filter(l => !l.startsWith('#'));
      expect(dataRows.length).toBeGreaterThan(0);
      // First data row parses as at least three floats (x y z …).
      const cols = dataRows[0].trim().split(/\s+/).map(Number);
      expect(cols.length).toBeGreaterThanOrEqual(3);
      for (let k = 0; k < 3; k++) expect(Number.isFinite(cols[k])).toBe(true);
    }
  } finally {
    await close();
  }
});
