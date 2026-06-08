import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

// The import wizard now intercepts every path-backed point-cloud import. For
// tests that just want the file imported with auto-detected columns, this
// helper waits for the wizard, lets each step's preview load, and clicks Import.
//
// For a multi-file import the Import button is gated until the user has reviewed
// every scan: either by stepping Next to the last one, or by checking "apply to
// all". This helper steps through any remaining scans first, so it works for
// both single- and multi-file imports without the caller needing to know which.
export async function completeImportWizard(page: Page, opts: { timeout?: number } = {}): Promise<void> {
  const timeout = opts.timeout ?? 30_000;
  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout });

  // Step to the last scan so the review gate is satisfied. The Next button is
  // only present for multi-scan imports and disables on the final step.
  const next = page.getByTestId('import-wizard-next');
  while (await next.isVisible() && await next.isEnabled()) {
    await next.click();
  }

  const importBtn = page.getByTestId('import-wizard-import');
  // Import enables once all previews have loaded and x/y/z are assigned (true
  // for any auto-detected fixture). Poll until enabled, then click.
  await expect(importBtn).toBeEnabled({ timeout });
  await importBtn.click();
  await expect(wizard).toBeHidden({ timeout });
}
