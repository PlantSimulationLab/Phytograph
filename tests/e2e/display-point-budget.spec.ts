import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Mirror of src/renderer/lib/displayPointBudget.ts.
const DEFAULT_POINT_BUDGET = 2_000_000;

// Settings → Performance → Display point budget drives potree's scene-wide
// point budget, which is what decides how much of a large cloud is resident
// and drawn per frame. The setting is in MILLIONS (what a person types) and
// takes effect when the dialog closes, without a restart or a re-import.
// Asserted through the real dialog and the renderer's own `__pointBudget`
// hook (the same one the crop-preview budget spec reads).
test('the display point budget setting drives the octree point budget on dialog close', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', TINY);
    await completeImportWizard(page);
    const row = page.locator('[data-testid="scan-row"]').first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toHaveAttribute('data-octree', 'true');

    const budget = () => page.evaluate(() => (window as { __pointBudget?: number }).__pointBudget);
    await expect.poll(budget, { timeout: 10_000 }).toBe(DEFAULT_POINT_BUDGET);

    const setBudget = async (millions: string) => {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send(
          'menu:command', { kind: 'nav', target: 'options' });
      });
      const dialog = page.getByTestId('settings-dialog');
      await expect(dialog).toBeVisible();
      await page.getByTestId('settings-point-budget').fill(millions);
      await page.getByTestId('settings-dialog-done').click();
      await expect(dialog).not.toBeVisible();
    };

    // A fraction of a million is honoured (0.5 → 500 k), so the field is a
    // real number, not an integer that silently floors.
    await setBudget('0.5');
    await expect.poll(budget, { timeout: 10_000 }).toBe(500_000);

    // The setting persists across a dialog reopen: the field shows what was
    // saved, and a raise applies the same way.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(
        'menu:command', { kind: 'nav', target: 'options' });
    });
    await expect(page.getByTestId('settings-point-budget')).toHaveValue('0.5');
    await page.getByTestId('settings-point-budget').fill('8');
    await page.getByTestId('settings-dialog-done').click();
    await expect.poll(budget, { timeout: 10_000 }).toBe(8_000_000);

    // Blank restores the default rather than storing 0.
    await setBudget('');
    await expect.poll(budget, { timeout: 10_000 }).toBe(DEFAULT_POINT_BUDGET);
  } finally {
    await close();
  }
});
