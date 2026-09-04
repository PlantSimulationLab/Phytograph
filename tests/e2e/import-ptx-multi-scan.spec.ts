import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// A PTX file is complete scan blocks concatenated back to back — one per scanner
// setup, each with its own header, dimensions and registered pose. A scan is
// DEFINED by its pose, so each block becomes its own Phytograph scan. Merging
// them (the old behaviour, still E57's until this change) left a single origin
// standing in for all of them, which silently breaks the LAD inversion (it takes
// one scanner origin), centres the sky/miss display shell on the wrong point,
// and makes the per-block row/column rasters collide.
//
// The fixture holds two positions with DIFFERENT dimensions and origins, which is
// the shape of the real UC Botanical dataset (3 positions, 5964x3333 / 5952x3333
// / 5959x3332) in miniature:
//   position 1 — 12 x 8 grid, 72 hits + 24 sky, scanner at (2, -1, 1.5)
//   position 2 — 10 x 7 grid, 60 hits + 10 sky, scanner at (9, 4, 1.25)
const PTX = join(repoRoot, 'tests', 'e2e', 'fixtures', 'structured-scan-multi.ptx');

test('splits a multi-position PTX into one scan per scanner setup', async () => {
  const { app, page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await importFiles(app, page, 'import-auto', PTX);
    await completeImportWizard(page);

    // ONE file, TWO scans.
    const rows = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(2, { timeout: 40_000 });

    // Each row carries only its own position's hits — not the merged 132.
    await expect(rows.nth(0)).toHaveAttribute('data-point-count', '72');
    await expect(rows.nth(1)).toHaveAttribute('data-point-count', '60');

    // Distinguishable labels, or the rows are indistinguishable in the panel.
    const names = await page.getByTestId('scan-row-name').allTextContents();
    expect(names[0]).not.toBe(names[1]);
    expect(names[0]).toContain('scan 1');
    expect(names[1]).toContain('scan 2');

    // ...and distinguishable SWATCHES, following the same convention two
    // separately-imported files get. The regression: the single-file import
    // passed a stateless colour picker that recomputed from the committed scan
    // list, which doesn't change until the whole import commits — so every
    // position in one file came out the same colour. "Per-scan colour" is the
    // default colour mode, so this is how the positions read in the viewer too.
    const colors = await rows.evaluateAll(
      (els) => els.map((e) => (e as HTMLElement).dataset.scanColor!));
    expect(colors[0]).toBe('#3b82f6');   // first free palette entry
    expect(colors[1]).toBe('#22c55e');   // the NEXT one, not blue again
    expect(new Set(colors).size).toBe(2);

    // The point of the split: each scan gets ITS OWN pose and grid. Before this,
    // both would have reported position 1's origin and its 12 x 8 grid.
    const ids = await rows.evaluateAll(
      (els) => els.map((e) => (e as HTMLElement).dataset.scanId!));
    const expected = [
      { grid: ['8', '12'], origin: ['2', '-1', '1.5'] },
      { grid: ['7', '10'], origin: ['9', '4', '1.25'] },
    ];
    for (let i = 0; i < 2; i++) {
      await page.getByTestId(`scan-edit-${ids[i]}`).click();
      const popup = page.getByTestId('scan-parameters-popup');
      await expect(popup).toBeVisible();
      await expect(page.getByTestId('scan-zenith-points')).toHaveValue(expected[i].grid[0]);
      await expect(page.getByTestId('scan-azimuth-points')).toHaveValue(expected[i].grid[1]);
      await expect(page.getByTestId('scan-origin-x')).toHaveValue(expected[i].origin[0]);
      await expect(page.getByTestId('scan-origin-y')).toHaveValue(expected[i].origin[1]);
      await expect(page.getByTestId('scan-origin-z')).toHaveValue(expected[i].origin[2]);
      await popup.getByRole('button', { name: 'Close' }).click();
      await expect(popup).not.toBeVisible();
    }

    // Both positions carry their own recovered sky/miss points.
    for (const id of ids) {
      await expect(page.getByTestId(`scan-toggle-misses-${id}`)).toBeVisible();
    }

    // One undo removes the whole import, not just the last position — the two
    // scans were added in a single transaction.
    await page.keyboard.press('Meta+z');
    await expect(rows).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await close();
  }
});
