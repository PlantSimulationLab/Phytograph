import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';

// Regression test for the silent-empty-scan bug: when point data fails to load
// during a Helios XML import (backend down, referenced file missing, user
// cancels the locate-file prompt), the import must be ALL-OR-NOTHING — no scans
// may be committed to the project, and the user must be told to re-import.
// Previously the per-scan failure was swallowed and a data-less scan was added
// anyway, leaving the user with empty, useless rows.
//
// We import an XML whose two scans reference point-cloud files that don't exist
// on disk. The resolver falls through to the "Locate file" picker, which we
// stub to cancel (null). Every scan therefore fails to load its data.
test('Helios XML import aborts entirely when point data cannot load', async () => {
  const { app, page, close } = await launchApp();

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'missing-data-scan.xml');
    // First dialog:open call returns the XML (the import file picker). Every
    // subsequent call is the per-scan "Locate point-cloud file" prompt — we
    // return null to simulate the user cancelling, so no data can be attached.
    await stubOpenDialog(app, [xmlFixture, null]);

    const panel = page.getByTestId('scans-panel');
    await expect(panel).toBeVisible();
    const rows = panel.locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(0);

    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();

    // The import fails: a persistent error toast appears telling the user
    // nothing was imported and to fix-and-retry. (The failure toast uses
    // duration 0 so it doesn't flash away before the user reads it.)
    const errorToast = page.locator('[data-testid="toast-error"]');
    await expect(errorToast).toBeVisible({ timeout: 20_000 });
    await expect(errorToast.getByTestId('toast-title')).toContainText(/could not load point data/i);
    await expect(errorToast.getByTestId('toast-title')).toContainText(/no scans were imported/i);

    // The key correctness assertion: NO scans were created. A real user must
    // never end up with empty, data-less scan rows.
    await expect(rows).toHaveCount(0);

    // And no success toast leaked through.
    await expect(page.locator('[data-testid="toast-success"]')).toHaveCount(0);
  } finally {
    await close();
  }
});
