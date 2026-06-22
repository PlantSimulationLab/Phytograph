import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// End-to-end import of a BINARY SBET trajectory through the real Scan Parameters
// popup against the LIVE backend. A .sbet is parsed server-side (POST
// /api/trajectory/parse → pyproj geographic→UTM + NED→ENU attitude) and mapped to a
// PoseStream by poseStreamFromWire — the whole binary path the CSV importer skips.
//
// The committed fixture is a tiny 5-record SBET (a short pass near Heidelberg). The
// assertion is that the trajectory IMPORTS AND ATTACHES — the popup shows the parsed
// pose count and time span read back from the backend — proving the file was decoded
// over HTTP, not merely that a dialog opened. (A geographic SBET is in UTM, not the
// synthetic leafcube's local frame, so this fixture tests the import path, not a
// downstream LAD value; lad-moving.spec.ts covers the LAD numerics via a local CSV.)
test('Imports a binary SBET trajectory through the live backend and attaches it', async () => {
  const { app, page, close } = await launchApp();

  try {
    const dir = join(repoRoot, 'tests', 'e2e', 'fixtures', 'lad-leafcube-moving');
    const xmlFixture = join(dir, 'leafcube_moving.xml');
    const sbetFixture = join(
      repoRoot, 'tests', 'e2e', 'fixtures', 'moving-scan', 'sample.sbet');
    // Two sequential dialogs: the scan XML, then the binary trajectory.
    await stubOpenDialog(app, [xmlFixture, sbetFixture]);

    // --- Import the scan from XML so there's a scan to attach a trajectory to ---
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const scansPanel = page.getByTestId('scans-panel');
    const scanRows = scansPanel.locator('[data-testid="scan-row"]');
    await expect(scanRows).toHaveCount(1, { timeout: 40_000 });
    const scanId = await scanRows.nth(0).getAttribute('data-scan-id');

    // --- Attach the SBET: edit the scan, import the binary trajectory ----------
    await page.getByTestId(`scan-edit-${scanId}`).click();
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-trajectory-import').click();

    // The summary appears once the backend parsed the SBET and the renderer mapped
    // the wire payload — the label is the .sbet filename and the 5-pose count proves
    // all five 136-byte records decoded end-to-end.
    const label = page.getByTestId('scan-trajectory-label');
    await expect(label).toBeVisible({ timeout: 30_000 });
    await expect(label).toHaveText(/sample\.sbet/);
    await expect(page.getByText(/5 poses/)).toBeVisible();

    // Persisting the scan with the attached trajectory closes the popup cleanly.
    await page.getByTestId('scan-submit').click();
    await expect(popup).not.toBeVisible();
  } finally {
    await close();
  }
});
