import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog, getOpenDialogCalls } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// Exercises the scan creation/edit/delete flow end-to-end via the unified
// Scans panel. A "scan" can be created with no point data attached; the
// scanner marker still renders at the configured origin.
test('add, edit, and delete a params-only scan through the UI', async () => {
  const { page, close } = await launchApp();

  try {

    const panel = page.getByTestId('scans-panel');
    await expect(panel).toBeVisible();

    // No scans yet → no rows.
    await expect(panel.locator('[data-testid="scan-row"]')).toHaveCount(0);

    // Toolbar Radio button opens the add popup directly.
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();

    // Non-default label + origin + sweep + multi-return beam params.
    await page.getByTestId('scan-label-input').fill('North Tripod');
    await page.getByTestId('scan-origin-x').fill('1.5');
    await page.getByTestId('scan-origin-y').fill('-2');
    await page.getByTestId('scan-origin-z').fill('0.75');
    await page.getByTestId('scan-zenith-points').fill('50');
    await page.getByTestId('scan-azimuth-points').fill('180');
    await page.getByTestId('scan-zenith-min').fill('30');

    // Regression guard: typing a multi-digit max one keystroke at a time must NOT
    // be clamped against the min mid-typing. Previously, with min=30, typing "130"
    // got clamped to 30 the instant "13" was parsed (13 < 30). Type it char by char
    // and confirm the field ends at 130, not snapped to the min.
    const zenithMax = page.getByTestId('scan-zenith-max');
    await zenithMax.click();
    await zenithMax.fill('');
    await zenithMax.pressSequentially('130', { delay: 30 });
    await zenithMax.blur();
    await expect(zenithMax).toHaveValue('130');

    await page.getByTestId('scan-azimuth-min').fill('45');
    await page.getByTestId('scan-azimuth-max').fill('315');

    await page.getByTestId('scan-return-multi').click();
    const beamFields = page.getByTestId('scan-beam-fields');
    await expect(beamFields).toBeVisible();
    await page.getByTestId('scan-beam-diameter').fill('0.02');
    await page.getByTestId('scan-beam-divergence').fill('1.2');

    await page.getByTestId('scan-submit').click();
    await expect(popup).not.toBeVisible();

    // One row in the unified panel.
    const rows = panel.locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(1);
    const firstRow = rows.first();
    await expect(firstRow).toContainText('North Tripod');
    await expect(firstRow).toContainText('origin (1.50, -2.00, 0.75)');
    // Params-only scan: data is missing, so the paperclip attach button is present.
    await expect(firstRow.locator('[data-testid^="scan-attach-data-"]')).toBeVisible();

    // Expand the row and verify the params block.
    const scanId = await firstRow.getAttribute('data-scan-id');
    expect(scanId).not.toBeNull();
    await page.getByTestId(`scan-expand-${scanId}`).click();
    const expanded = page.getByTestId(`scan-expanded-${scanId}`);
    await expect(expanded).toBeVisible();
    await expect(expanded).toContainText('50 × 180');
    await expect(expanded).toContainText('multi');

    // Edit via the row's edit button.
    await page.getByTestId(`scan-edit-${scanId}`).click();
    await expect(popup).toBeVisible();
    const label = page.getByTestId('scan-label-input');
    await expect(label).toHaveValue('North Tripod');
    // Multi-return state should round-trip and beam fields stay visible.
    await expect(beamFields).toBeVisible();
    await expect(page.getByTestId('scan-beam-diameter')).toHaveValue('0.02');
    await label.fill('North Tripod (renamed)');
    await page.getByTestId('scan-submit').click();
    await expect(popup).not.toBeVisible();
    await expect(rows.first()).toContainText('North Tripod (renamed)');

    // Delete the scan. The panel stays visible (always rendered) but the
    // rows count drops back to zero.
    await page.getByTestId(`scan-delete-${scanId}`).click();
    // Confirm dialog may appear — best-effort accept via the existing
    // confirm-delete button if shown.
    const confirm = page.getByTestId('confirm-delete');
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
    }
    await expect(rows).toHaveCount(0);
  } finally {
    await close();
  }
});

// Bulk-import from Helios XML, then round-trip a scan's parsed parameters
// through the edit form. Uses sphere-scan/sphere.xml, whose four <scan>
// entries reference sibling .xyz files that DO exist — so each scan resolves,
// runs through the import wizard, and lands with both params and point data.
// (The companion import-failure-aborts.spec.ts covers the all-or-nothing abort
// when referenced files can't be located.)
test('bulk-import scans from a Helios XML file and round-trips angular bounds', async () => {
  const { app, page, close } = await launchApp();

  try {
    const fixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
    await stubOpenDialog(app, fixture);

    const panel = page.getByTestId('scans-panel');
    await expect(panel).toBeVisible();
    const rows = panel.locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(0);

    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();

    await page.getByTestId('scan-import-xml').click();
    // Popup closes once the XML is parsed and files are resolved; the four
    // resolved scans then run through the import wizard.
    await expect(popup).not.toBeVisible({ timeout: 15_000 });
    await completeImportWizard(page);
    await expect(page.getByTestId('scan-import-error')).toHaveCount(0);

    const calls = await getOpenDialogCalls(app);
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // Four scans, one per <scan>. Origins are (-2,0,0.5), (0,-2,0.5),
    // (2,0,0.5), (0,2,0.5). Each resolved its sibling .xyz → has data + params.
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('(-2.00, 0.00, 0.50)');
    await expect(rows.nth(1)).toContainText('(0.00, -2.00, 0.50)');
    await expect(rows.nth(2)).toContainText('(2.00, 0.00, 0.50)');
    await expect(rows.nth(3)).toContainText('(0.00, 2.00, 0.50)');
    for (let i = 0; i < 4; i++) {
      await expect(rows.nth(i)).toHaveAttribute('data-has-data', 'true');
      await expect(rows.nth(i)).toHaveAttribute('data-has-params', 'true');
    }

    // Open scan 0 for edit and verify its angular bounds round-trip into the
    // form. sphere-scan/sphere.xml sets no theta/phi bounds, so the scan
    // covers the full sweep: zenith 0–180°, azimuth 0–360°.
    const firstId = await rows.nth(0).getAttribute('data-scan-id');
    await page.getByTestId(`scan-edit-${firstId}`).click();
    await expect(popup).toBeVisible();
    const zenithMin = await page.getByTestId('scan-zenith-min').inputValue();
    expect(Math.round(parseFloat(zenithMin))).toBe(0);
    const zenithMax = await page.getByTestId('scan-zenith-max').inputValue();
    expect(Math.round(parseFloat(zenithMax))).toBe(180);
    const azimuthMin = await page.getByTestId('scan-azimuth-min').inputValue();
    expect(Math.round(parseFloat(azimuthMin))).toBe(0);
    const azimuthMax = await page.getByTestId('scan-azimuth-max').inputValue();
    expect(Math.round(parseFloat(azimuthMax))).toBe(360);
    // The XML import button is hidden in edit mode (showBulkImport is only
    // true when creating a brand-new scan).
    await expect(page.getByTestId('scan-import-xml')).toHaveCount(0);
  } finally {
    await close();
  }
});
