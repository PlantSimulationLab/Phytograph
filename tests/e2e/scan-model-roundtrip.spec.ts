import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubSaveDialog, getSaveDialogCalls } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';

// Scanner-model round-trip through the Helios XML bundle, against the live backend.
//
// A scan's instrument identity (e.g. RIEGL VZ-400i) is renderer-side state that the
// XML had no home for, so it used to come back 'generic'. We now inject a
// <scannerModel> tag on export and read it back on import. This drives the real UI:
//   import the 4-scan sphere fixture (so each scan has point data to export) →
//   set scan 0's model to RIEGL VZ-400i via the params popup → export XML →
//   assert the bundle carries <scannerModel>riegl_vz400i</scannerModel> →
//   re-import that exported XML into a fresh window → assert the re-imported scan's
//   model select reads back 'riegl_vz400i' (NOT generic).
test('round-trips a scanner model (RIEGL VZ-400i) through XML export and re-import', async () => {
  const { app, page, close } = await launchApp();
  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-scanmodel-'));
  const xmlPath = join(outDir, 'sphere.xml');

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
    await stubOpenDialog(app, xmlFixture);
    await stubSaveDialog(app, xmlPath);

    // ── Import the 4 scans (each resolves its sibling .xyz → has data + params) ──
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const rows = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(4, { timeout: 20_000 });

    // ── Set scan 0's scanner model to RIEGL VZ-400i via the edit popup ──────────
    const scanId = await rows.nth(0).getAttribute('data-scan-id');
    await page.getByTestId(`scan-edit-${scanId}`).click();
    await expect(popup).toBeVisible();
    const modelSelect = page.getByTestId('scan-model-select');
    // Defaults to generic for an XML import (no model tag in the fixture).
    await expect(modelSelect).toHaveValue('generic');
    await modelSelect.selectOption('riegl_vz400i');
    await expect(modelSelect).toHaveValue('riegl_vz400i');
    await page.getByTestId('scan-submit').click();
    await expect(popup).not.toBeVisible();

    // ── Export the XML bundle ───────────────────────────────────────────────────
    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await expect(page.getByTestId('export-modal')).toBeVisible();
    await expect(page.getByTestId('export-scan-section')).toBeVisible();
    await expect(page.getByTestId('export-scan-mode-xml')).toHaveAttribute('data-active', 'true');
    await page.getByTestId('export-scan-xml').click();

    await expect.poll(async () => (await getSaveDialogCalls(app)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect.poll(() => existsSync(xmlPath), { timeout: 30_000, intervals: [200, 500, 1000] }).toBe(true);

    // The exported XML carries the model on exactly one scan; the others stay generic.
    const xml = readFileSync(xmlPath, 'utf-8');
    expect(xml).toContain('<scannerModel>riegl_vz400i</scannerModel>');
    expect((xml.match(/<scannerModel>/g) ?? []).length).toBe(1);
  } finally {
    await close();
  }

  // ── Re-import the exported XML into a FRESH window and assert the model came back.
  const { app: app2, page: page2, close: close2 } = await launchApp();
  try {
    await stubOpenDialog(app2, xmlPath);

    await page2.getByTestId('tool-add-scan').click();
    const popup2 = page2.getByTestId('scan-parameters-popup');
    await expect(popup2).toBeVisible();
    await page2.getByTestId('scan-import-xml').click();
    await expect(popup2).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page2);

    const rows2 = page2.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
    await expect(rows2).toHaveCount(4, { timeout: 20_000 });

    // Find the scan that re-imported as RIEGL: its expanded row shows the model line.
    // Exactly one of the four should carry it (the others round-trip as generic).
    let rieglScanId: string | null = null;
    for (let i = 0; i < 4; i++) {
      const id = await rows2.nth(i).getAttribute('data-scan-id');
      await page2.getByTestId(`scan-edit-${id}`).click();
      await expect(popup2).toBeVisible();
      const val = await page2.getByTestId('scan-model-select').inputValue();
      // Close the popup before moving on.
      await page2.getByTestId('scan-submit').click();
      await expect(popup2).not.toBeVisible();
      if (val === 'riegl_vz400i') rieglScanId = id;
    }
    // The instrument identity survived the round trip — exactly the scan we tagged.
    expect(rieglScanId, 'one re-imported scan must read back as riegl_vz400i').not.toBeNull();
  } finally {
    await close2();
  }
});
