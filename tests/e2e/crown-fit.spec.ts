import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { stubSaveDialog, getSaveDialogCalls } from './helpers/stubSaveDialog';

// tree_wood_leaf.xyz is a synthetic single tree: a vertical trunk + two angled
// branches ("wood") and 11 leaf blobs ("leaf"), 4240 points. The workflow:
// import (→ octree/session) → run Wood/Leaf segmentation (real `wood_class`
// labels) → open Fit Crown & Metrics → fit an ellipsoid to the leaf points →
// assert a crown mesh appears with plausible per-crown metrics → export the
// metrics CSV and assert its contents. Drives the real DOM against the live
// backend end-to-end (no mocks), per the E2E rules in CLAUDE.md.
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree_wood_leaf.xyz');

test('fits a crown to leaf points and reports metrics + CSV', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // 1) Produce real wood_class labels so the crown fit can use leaf-only points.
    await page.getByTestId('tool-wood-segment').click();
    await expect(page.getByTestId('wood-segment-panel')).toBeVisible();
    await page.getByTestId('wood-segment-run-button').click();
    // Wait for the wood_class recolour (proof segmentation finished).
    const legend = page.getByTestId('class-legend');
    await expect(legend).toBeVisible({ timeout: 60_000 });
    await expect(legend).toHaveAttribute('data-legend-attribute', 'wood_class');

    // 2) Open Fit Crown & Metrics. The picker lists every cloud with data, so we
    // check the scan's row inside the modal rather than relying on the pre-open
    // viewport selection (which the segmentation may have cleared).
    await page.getByTestId('tool-fit-crown').click();
    const popup = page.getByTestId('crown-fit-popup');
    await expect(popup).toBeVisible();

    const pickerRow = popup.locator('[data-testid="picker-row"][data-object-id]').first();
    await expect(pickerRow).toBeVisible();
    const checkbox = pickerRow.locator('input[type="checkbox"]');
    if (!(await checkbox.isChecked())) await checkbox.check();
    await expect(checkbox).toBeChecked();

    // No ground / tree segmentation was run, so the ambiguity warning banner must
    // appear (we warn, never silently proceed) — while the fit stays enabled.
    await expect(page.getByTestId('crown-fit-warning')).toBeVisible();

    // Ellipsoid is the default; set an explicit strictness and enable CSV export.
    await page.getByTestId('crown-shape-select').selectOption('ellipsoid');
    await page.getByTestId('crown-strictness-input').fill('0.2');
    await page.getByTestId('crown-export-csv').check();

    // Route the CSV save dialog to a real temp file (real fs write, asserted below).
    const csvPath = join(tmpdir(), `crown_metrics_${Date.now()}.csv`);
    await stubSaveDialog(app, csvPath);

    // 3) Fit. A progress pill appears while the backend fits (so the user isn't
    // left wondering during the compute), then disappears when it completes.
    await page.getByTestId('crown-fit-run').click();
    const pill = page.getByTestId('crown-fit-running');
    // The pill is transient; it must show at least until the crown mesh lands.
    await expect(pill).toBeVisible({ timeout: 10_000 });

    // A crown mesh appears in the Meshes list. The row's compact summary shows
    // the headline height + volume.
    const crownRow = page.locator('[data-testid="mesh-row"][data-mesh-name*="crown (Ellipsoid)"]');
    await expect(crownRow).toBeVisible({ timeout: 120_000 });
    // …and the pill clears once the fit is done.
    await expect(pill).toBeHidden({ timeout: 30_000 });

    // With no tree segmentation, the crown gets an auto-assigned colour that is
    // distinct from its source scan (the scan is blue #3b82f6).
    const crownColor = await crownRow.getAttribute('data-mesh-color');
    expect(crownColor).toBeTruthy();
    expect(crownColor?.toLowerCase()).not.toBe('#3b82f6');
    await expect(crownRow.getByTestId('mesh-row-count')).toContainText('H ');
    await expect(crownRow.getByTestId('mesh-row-count')).toContainText('Vol ');

    // Expand the row to reveal the full per-crown metrics block.
    await crownRow.getByTestId('mesh-color-expand').click();
    const metrics = page.getByTestId('mesh-crown-metrics');
    await expect(metrics).toBeVisible();
    // The triangulation-oriented controls (color-by dropdown, leaf-angle plot)
    // are irrelevant to an analytic crown solid and must NOT appear in its panel.
    await expect(crownRow.getByTestId('mesh-color-mode')).toHaveCount(0);
    await expect(crownRow.getByTestId('mesh-leaf-angles')).toHaveCount(0);
    // The metrics block reports a plausible tree height and crown volume. The
    // leaf blobs span a few metres tall; assert a sane positive range rather than
    // an exact value (the fit is fuzzy).
    const text = (await metrics.innerText()).replace(/\s+/g, ' ');
    const height = Number(text.match(/Tree height:\s*([\d.]+)\s*m/)?.[1] ?? '0');
    const volume = Number(text.match(/Crown volume:\s*([\d.]+)\s*m/)?.[1] ?? '0');
    expect(height).toBeGreaterThan(0.05);
    expect(height).toBeLessThan(5);
    expect(volume).toBeGreaterThan(0);

    // 4) The CSV export fired and wrote a real file: one header + one data row.
    await expect(async () => {
      expect((await getSaveDialogCalls(app)).length).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000 });
    const csv = readFileSync(csvPath, 'utf8').trim().split('\n');
    expect(csv[0]).toContain('crown_volume_m3');
    expect(csv[0]).toContain('tree_height_m');
    expect(csv.length).toBe(2); // header + one crown
    const cols = csv[1].split(',');
    // shape column = ellipsoid; volume column > 0.
    expect(cols[2]).toBe('ellipsoid');
    expect(Number(cols[4])).toBeGreaterThan(0);
  } finally {
    await close();
  }
});
