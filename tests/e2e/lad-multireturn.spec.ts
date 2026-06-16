import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// Multi-return (full-waveform) leaf area density through the UI against the live
// backend. The committed leafcube_multi fixture is a full-waveform synthetic
// scan of the LAI=2 leaf cube; each hit carries per-pulse
// timestamp/target_index/target_count, so the backend must detect multi-return,
// run gapfillMisses() + the equal-weighting inversion, and recover LAD near the
// true 2.0 m²/m³ for the 1×1×1 m voxel at (0,0,0.5).
//
// This exercises the FILE-IMPORT path: the multi-return columns travel from the
// imported file through to the LAD computation. The key assertion beyond "a
// result appeared" is data-return-mode = "multi" — proving the multi-return
// algorithm actually ran rather than silently falling back to single-return.
test('Computes multi-return leaf area density from an imported full-waveform scan', async () => {
  const { app, page, close } = await launchApp();

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'lad-leafcube-multi', 'leafcube_multi.xml');
    await stubOpenDialog(app, xmlFixture);

    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const scansPanel = page.getByTestId('scans-panel');
    const scanRows = scansPanel.locator('[data-testid="scan-row"]');
    // Importing the multi-return fixture runs PotreeConverter on the session;
    // allow generous headroom so a slow octree build doesn't flake the import.
    await expect(scanRows).toHaveCount(1, { timeout: 40_000 });
    await expect(scanRows.nth(0)).toHaveAttribute('data-has-data', 'true');
    await expect(scanRows.nth(0)).toHaveAttribute('data-has-params', 'true');

    // Miss auto-detection: this scan carries 2779 far-field sky/miss points
    // (target_index == 99) but NO is_miss column. The backend must recover them
    // at import — proven here by the per-scan "show misses" toggle, which only
    // renders when the cloud's session reports has_misses. (It also keeps those
    // 1001 m points out of the octree/bbox, fixing the ground-grid flicker.)
    const scanId = await scanRows.nth(0).getAttribute('data-scan-id');
    expect(scanId).toBeTruthy();
    await expect(page.getByTestId(`scan-toggle-misses-${scanId}`)).toBeVisible();
    // Octree (displayed cloud) is hits-only: ~6522 points, far below the 9301
    // total. A point count near 9301 would mean misses leaked into the cloud.
    const displayedPoints = parseInt((await scanRows.nth(0).getAttribute('data-point-count'))!, 10);
    expect(displayedPoints).toBeGreaterThan(5000);
    expect(displayedPoints).toBeLessThan(8000);

    // The imported scan's return type comes from the XML/params. Set it to
    // multi-return via the scan parameters popup so the LAD request marks it
    // multi (the backend still detects multi from the columns, but this matches
    // how a user would label a full-waveform scan).
    await scanRows.nth(0).locator('[data-testid^="scan-edit-"]').click();
    const paramsPopup = page.getByTestId('scan-parameters-popup');
    await expect(paramsPopup).toBeVisible();
    await page.getByTestId('scan-return-multi').click();
    await page.getByTestId('scan-submit').click();
    await expect(paramsPopup).not.toBeVisible();

    // Build the required voxel grid: a 1×1×1 m box raised to center z=0.5.
    await page.getByTestId('tool-create-voxel').click();
    const posZ = page.getByTestId('mesh-pos-z');
    await expect(posZ).toBeVisible();
    await posZ.fill('0.5');
    await posZ.press('Enter');

    // Creating a voxel box leaves a mixed selection (scan + box). Click the scan
    // row to refocus it: in mixed mode a plain click keeps the scan and clears
    // the box selection (it does NOT toggle the scan off — that only happens when
    // the scan is the entire selection). Then open the LAD tool, pick grid, run.
    // Click the row's NAME, not the row center: the row's right-side action
    // buttons stop propagation, so a center click can miss the select handler.
    await scanRows.nth(0).getByTestId('scan-row-name').click();
    await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('tool-compute-lad').click();
    const ladPopup = page.getByTestId('lad-popup');
    await expect(ladPopup).toBeVisible();
    await expect(page.getByTestId('lad-no-grid-warning')).toHaveCount(0);

    // The return-type summary should reflect the multi-return scan.
    await expect(page.getByTestId('lad-returntype-summary')).toContainText(/multi-return/i);

    await page.getByTestId('lad-input-lmax').fill('0.04');
    await page.getByTestId('lad-input-aspect').fill('10');
    await page.getByTestId('lad-input-min-hits').fill('1');
    await page.getByTestId('lad-compute-button').click();

    const ladRow = page.getByTestId('lad-row').first();
    await expect(ladRow).toBeVisible({ timeout: 120_000 });

    // The multi-return algorithm actually ran (not the single-return fallback).
    await expect(ladRow).toHaveAttribute('data-return-mode', 'multi');

    const voxelCount = parseInt((await ladRow.getAttribute('data-voxel-count'))!, 10);
    expect(voxelCount).toBeGreaterThanOrEqual(1);

    // Recovered LAD near the true 2.0 m²/m³ (wide band: point-cloud
    // multi-return recovery is noisier than the analytic value).
    const ladMax = parseFloat((await ladRow.getAttribute('data-lad-max'))!);
    expect(ladMax).toBeGreaterThan(1.4);
    expect(ladMax).toBeLessThan(2.8);

    const colorbar = page.getByTestId('lad-colorbar');
    await expect(colorbar).toBeVisible();
    await expect(colorbar).toHaveAttribute('data-colorbar-label', /LAD/);

    // The voxel grid box the LAD ran on is auto-hidden so its faces don't z-fight
    // the LAD voxel result that fills the same volume. The one mesh row (the box)
    // flips to data-visible="false".
    await expect(page.getByTestId('mesh-row').first())
      .toHaveAttribute('data-visible', 'false', { timeout: 10_000 });
  } finally {
    await close();
  }
});
