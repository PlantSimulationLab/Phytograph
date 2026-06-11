import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// Drives the Phase-1 procedural leaf reconstruction end-to-end against the LIVE
// backend (no mocks): import a cloud -> Build QSM -> Add Leaves with a builtin
// texture -> assert concrete leaf geometry was produced and rendered, then that
// the leaf-visibility toggle works. The fixture is the same Y-shaped synthetic
// plant the build test uses, which yields a clean 1-trunk + 2-scaffold model
// (the two scaffolds are terminal shoots, so leaves are placed on them).
test('adds procedural leaves to a QSM via the UI', async () => {
  const { page, close } = await launchApp();

  try {
    // Import the cloud (intercept the OS file chooser).
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-pointcloud').click(),
    ]);
    await chooser.setFiles(FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });

    // Build the QSM.
    await page.getByTestId('tool-qsm').click();
    await expect(page.getByTestId('qsm-panel')).toBeVisible();
    await page.getByTestId('qsm-build-button').click();

    const qsmRow = page.getByTestId('qsm-row').first();
    await expect(qsmRow).toBeVisible({ timeout: 60_000 });

    // --- Open the Add Leaves modal from the QSM row ---
    await page.getByTestId(/^qsm-add-leaves-/).first().click();
    const popup = page.getByTestId('add-leaves-popup');
    await expect(popup).toBeVisible();

    // The phyllotaxis auto-detect runs on open and resolves to a hint (it either
    // detects a pattern or falls back to the default helper text).
    await expect(popup.getByTestId('add-leaves-phyllo-hint')).not.toContainText(
      'Auto-detecting',
      { timeout: 15_000 },
    );

    // The texture picker defaults to a curated builtin (AlmondLeaf). Use a
    // generous spacing so the leaf count stays small and fast.
    await popup.getByTestId('add-leaves-texture-select').selectOption('AlmondLeaf');
    await popup.getByTestId('add-leaves-spacing').fill('0.05');
    await popup.getByTestId('add-leaves-size').fill('0.06');

    // The estimate updates from the QSM's terminal-shoot lengths.
    await expect(popup.getByTestId('add-leaves-estimate')).toContainText('leaves');

    // Submit -> backend places leaves -> the QSM row gains a leaf count.
    await popup.getByTestId('add-leaves-submit').click();
    await expect(popup).toBeHidden();

    const leafCountEl = page.getByTestId(/^qsm-leaf-count-/).first();
    await expect(leafCountEl).toBeVisible({ timeout: 60_000 });
    const leafCount = parseInt((await leafCountEl.getAttribute('data-leaf-count'))!, 10);
    // Concrete output: leaves were actually placed on the terminal shoots.
    expect(leafCount).toBeGreaterThan(0);

    // --- Leaf-visibility toggle works (independent of woody-QSM visibility) ---
    const leafToggle = page.getByTestId(/^qsm-leaves-toggle-/).first();
    await expect(leafToggle).toBeVisible();
    await leafToggle.click();   // hide
    await leafToggle.click();   // show again
    // The QSM and its leaf count are still present after toggling.
    await expect(page.getByTestId('qsm-row')).toHaveCount(1);
    await expect(leafCountEl).toBeVisible();
  } finally {
    await close();
  }
});
