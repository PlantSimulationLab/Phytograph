import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// End-to-end Backfill Misses → LAD workflow through the real UI against the live
// backend. The fixture is the leaf-cube full-waveform scan with its sky/miss
// returns REMOVED (every target_index==99 row dropped), so it carries per-pulse
// timestamps but NO recorded misses and NO miss sentinel — import auto-detects
// none, and the "Show misses" toggle is absent until Backfill Misses runs.
//
// Asserts the new hard contract: LAD's Compute is DISABLED with a backfill
// banner before misses exist; after Backfill Misses recovers them (from the
// timestamp grid), the toggle appears, the banner is gone, Compute is enabled,
// and LAD recovers the true ~2.0 m²/m³ for the 1×1×1 m voxel at (0,0,0.5).
test('Backfill Misses recovers sky points and unblocks LAD', async () => {
  const { app, page, close } = await launchApp();

  try {
    const xmlFixture = join(
      repoRoot, 'tests', 'e2e', 'fixtures', 'lad-leafcube-backfill', 'leafcube_backfill.xml');
    await stubOpenDialog(app, xmlFixture);

    // Import the timestamped scan (data + params from XML).
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const scansPanel = page.getByTestId('scans-panel');
    const scanRows = scansPanel.locator('[data-testid="scan-row"]');
    await expect(scanRows).toHaveCount(1, { timeout: 40_000 });
    await expect(scanRows.nth(0)).toHaveAttribute('data-has-data', 'true');
    await expect(scanRows.nth(0)).toHaveAttribute('data-has-params', 'true');

    const scanId = await scanRows.nth(0).getAttribute('data-scan-id');
    expect(scanId).toBeTruthy();

    // No misses yet: the scan stripped its miss returns, so the "Show misses"
    // toggle is absent (it renders only when the session reports has_misses).
    await expect(page.getByTestId(`scan-toggle-misses-${scanId}`)).toHaveCount(0);

    // Build the required 1×1×1 m voxel grid raised to center z=0.5.
    await page.getByTestId('tool-create-voxel').click();
    const posZ = page.getByTestId('mesh-pos-z');
    await expect(posZ).toBeVisible();
    await posZ.fill('0.5');
    await posZ.press('Enter');

    // Refocus the scan (creating the box left a mixed selection).
    await scanRows.nth(0).getByTestId('scan-row-name').click();
    await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');

    // --- LAD is BLOCKED before misses exist --------------------------------
    await page.getByTestId('tool-compute-lad').click();
    const ladPopup = page.getByTestId('lad-popup');
    await expect(ladPopup).toBeVisible();
    // The backfill banner is shown and Compute is disabled (hard requirement).
    await expect(page.getByTestId('lad-backfill-hint')).toBeVisible();
    await expect(page.getByTestId('lad-compute-button')).toBeDisabled();
    // Close LAD; we'll run backfill from its own modal (the canonical entry).
    await page.getByTestId('lad-close').click();
    await expect(ladPopup).not.toBeVisible();

    // --- Backfill Misses via its setup modal (toolbar → modal → run) --------
    // Ensure the scan is selected (it likely still is from the LAD step; clicking
    // again would toggle it off, so only click when not already selected).
    if ((await scanRows.nth(0).getAttribute('data-selected')) !== 'true') {
      await scanRows.nth(0).getByTestId('scan-row-name').click();
    }
    await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('tool-backfill-misses').click();

    const backfillPopup = page.getByTestId('backfill-popup');
    await expect(backfillPopup).toBeVisible();
    // The scan is auto-selected from the Scans-panel selection.
    const backfillRow = backfillPopup.getByTestId('backfill-scan-row').first();
    await expect(backfillRow).toHaveAttribute('data-selected', 'true');

    // Reopen reflects the CURRENT panel selection (regression guard: the modal
    // must re-seed from the live selection on every open, not carry over a prior
    // session's). Close via the backdrop (the modal swallows Escape), confirm the
    // scan is still selected in the panel, reopen, and check it's checked again.
    await page.mouse.click(5, 5);
    await expect(backfillPopup).not.toBeVisible();
    await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('tool-backfill-misses').click();
    await expect(backfillPopup).toBeVisible();
    await expect(backfillPopup.getByTestId('backfill-scan-row').first()).toHaveAttribute('data-selected', 'true');
    // The "Reconstructs from" column detects the ancillary data: this fixture
    // carries a timestamp (no row/col grid), so the timestamp badge is shown and
    // marked as the path that will be used.
    await expect(backfillRow).toHaveAttribute('data-recon', 'timestamp');
    const tsBadge = backfillRow.getByTestId('backfill-source-timestamp');
    await expect(tsBadge).toBeVisible();
    await expect(tsBadge).toHaveAttribute('data-used', 'true');
    await expect(backfillRow.getByTestId('backfill-source-rowcol')).toHaveCount(0);
    // The show-after toggle is present and enabled (this fixture has a scanner
    // origin from XML, so its misses are displayable).
    await expect(page.getByTestId('backfill-show-after')).toBeEnabled();
    await page.getByTestId('backfill-run-button').click();

    // The streamed StatusPill appears while the backend gap-fills.
    await expect(page.getByTestId('backfill-running')).toBeVisible();

    // Success toast reports recovered points, and the "Show misses" toggle now
    // appears (has_misses flipped) and is auto-enabled.
    const toast = page.locator('[data-testid="toast-success"]').last();
    await expect(toast.getByTestId('toast-title')).toContainText(/Recovered .* sky\/miss point/i, { timeout: 60_000 });
    await expect(page.getByTestId('backfill-running')).toHaveCount(0);
    const missToggle = page.getByTestId(`scan-toggle-misses-${scanId}`);
    await expect(missToggle).toBeVisible();
    await expect(missToggle).toHaveAttribute('title', 'Hide sky/miss points');

    // --- LAD is now UNBLOCKED ----------------------------------------------
    // Re-select the scan (single-select toggles off when the scan is the whole
    // selection, so click until the row reports selected).
    if ((await scanRows.nth(0).getAttribute('data-selected')) !== 'true') {
      await scanRows.nth(0).getByTestId('scan-row-name').click();
    }
    await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('tool-compute-lad').click();
    await expect(ladPopup).toBeVisible();
    // Banner gone, Compute enabled.
    await expect(page.getByTestId('lad-backfill-hint')).toHaveCount(0);
    await expect(page.getByTestId('lad-no-grid-warning')).toHaveCount(0);

    await page.getByTestId('lad-input-lmax').fill('0.04');
    await page.getByTestId('lad-input-aspect').fill('10');
    await page.getByTestId('lad-input-min-hits').fill('1');
    await expect(page.getByTestId('lad-compute-button')).toBeEnabled();
    await page.getByTestId('lad-compute-button').click();

    // LAD runs successfully against the misses recovered by Backfill.
    const ladRow = page.getByTestId('lad-row').first();
    await expect(ladRow).toBeVisible({ timeout: 120_000 });
    const voxelCount = parseInt((await ladRow.getAttribute('data-voxel-count'))!, 10);
    expect(voxelCount).toBeGreaterThanOrEqual(1);
    const ladMax = parseFloat((await ladRow.getAttribute('data-lad-max'))!);
    expect(ladMax).toBeGreaterThan(1.4);
    expect(ladMax).toBeLessThan(2.8);
  } finally {
    await close();
  }
});
