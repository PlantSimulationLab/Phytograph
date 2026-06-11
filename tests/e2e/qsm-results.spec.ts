import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// Drives the per-QSM "View results" window end-to-end against the LIVE backend
// (no mocks): import a cloud -> Build QSM -> open the results window -> assert on
// the rendered detail charts/tables. The fixture is the same Y-shaped synthetic
// plant (stem + two branches, 900 points) the build test uses, which yields a
// 1-trunk + 2-scaffold model — so the window has real taper, rank, angle and
// fit-quality data to render, and we assert concrete structure, not "no error".
test('opens the QSM results window and renders detailed analytics', async () => {
  const { app, page, close } = await launchApp();

  try {
    // Import as point cloud (intercept the OS file chooser).
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });

    // Build the QSM.
    await page.getByTestId('tool-qsm').click();
    await expect(page.getByTestId('qsm-panel')).toBeVisible();
    await page.getByTestId('qsm-build-button').click();

    const qsmRow = page.getByTestId('qsm-row').first();
    await expect(qsmRow).toBeVisible({ timeout: 60_000 });

    // Pull the trunk diameter shown on the row so we can cross-check the window's
    // summary table against it.
    const rowTrunkO = await qsmRow.getByTestId('qsm-metrics').textContent();
    const trunkMatch = rowTrunkO?.match(/([\d.]+)\s*mm/);
    expect(trunkMatch).not.toBeNull();
    const rowTrunkMm = parseFloat(trunkMatch![1]);

    // --- Open the results window via the new per-QSM button ---
    await qsmRow.getByTestId(/^qsm-results-/).click();
    const popup = page.getByTestId('qsm-results-popup');
    await expect(popup).toBeVisible();
    await expect(popup).toContainText('QSM Results');

    // Scan-coverage badge present with a real grade. This is a COVERAGE
    // diagnostic (volume-weighted), not a fit pass/fail — low surf_cov is normal
    // on TLS, so the grade must be one of the coverage tiers and the badge frames
    // coverage, never "poor fit".
    const badge = page.getByTestId('qsm-qa-badge');
    await expect(badge).toBeVisible();
    const grade = await badge.getAttribute('data-grade');
    expect(['high', 'moderate', 'low']).toContain(grade);
    await expect(badge).toContainText('Scan coverage');
    await expect(badge).toContainText('well-covered');

    // Summary table echoes the same trunk diameter the row shows.
    const summary = page.getByTestId('qsm-summary-table');
    await expect(summary).toContainText(`${rowTrunkMm.toFixed(1)} mm`);
    await expect(summary).toContainText('Height');

    // All five charts rendered an SVG (recharts emits an <svg> once it has data).
    for (const id of ['qsm-taper-chart', 'qsm-rank-chart', 'qsm-angle-chart', 'qsm-profile-chart']) {
      await expect(page.getByTestId(id).locator('svg').first()).toBeVisible();
    }
    // QA panel has its two histograms.
    await expect(page.getByTestId('qsm-qa-charts').locator('svg')).toHaveCount(2);

    // Per-shoot table lists at least the trunk + the scaffolds (>= 3 rows on this
    // 1-trunk + 2-scaffold fixture).
    const shootRows = page.getByTestId('qsm-shoot-table').locator('tbody tr');
    expect(await shootRows.count()).toBeGreaterThanOrEqual(3);

    // --- Controls drive the charts live ---
    // Changing the branch-angle bin count re-renders without error.
    await page.getByTestId('qsm-angle-bins').selectOption('9');
    await expect(page.getByTestId('qsm-angle-bins')).toHaveValue('9');
    await expect(page.getByTestId('qsm-angle-chart').locator('svg').first()).toBeVisible();

    // Switch the branch-order metric to woody volume.
    await page.getByTestId('qsm-rank-metric').getByRole('radio', { name: 'Woody volume' }).check();
    await expect(page.getByTestId('qsm-rank-chart').locator('svg').first()).toBeVisible();

    // Sorting the shoot table by length toggles direction on a second click.
    const lengthHeader = page.getByTestId('qsm-shoot-table').getByRole('button', { name: /Length/ });
    await lengthHeader.click();
    await lengthHeader.click();
    await expect(shootRows.first()).toBeVisible();

    // --- Close paths ---
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();

    // Re-open then close via the X button.
    await qsmRow.getByTestId(/^qsm-results-/).click();
    await expect(popup).toBeVisible();
    await popup.getByRole('button').first().click();  // header X
    await expect(popup).toBeHidden();
  } finally {
    await close();
  }
});
