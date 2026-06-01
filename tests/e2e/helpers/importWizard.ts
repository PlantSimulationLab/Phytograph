import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

// The import wizard now intercepts every path-backed point-cloud import. For
// tests that just want the file imported with auto-detected columns, this
// helper waits for the wizard, lets each step's preview load, and clicks Import.
//
// `expectedScans` is how many scans the wizard is stepping through (default 1);
// for a multi-file import the Import button only enables once every step's
// preview has loaded, but we don't need to visit each step — the button gates on
// all configs being ready, so we just wait for it to enable.
export async function completeImportWizard(page: Page, opts: { timeout?: number } = {}): Promise<void> {
  const timeout = opts.timeout ?? 30_000;
  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout });
  const importBtn = page.getByTestId('import-wizard-import');
  // Import enables once all previews have loaded and x/y/z are assigned (true
  // for any auto-detected fixture). Poll until enabled, then click.
  await expect(importBtn).toBeEnabled({ timeout });
  await importBtn.click();
  await expect(wizard).toBeHidden({ timeout });
}
