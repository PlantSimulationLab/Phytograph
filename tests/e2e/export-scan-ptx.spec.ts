import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { stubSaveDialog } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';

// PTX export writes a COMPLETE raster: `Ntheta x Nphi` data lines, one per grid
// cell, with a cell that has no return recorded as the all-zero sentinel. That
// completeness is the whole contract — it is what lets the file be re-imported
// with its sky/miss points recovered — so this asserts the file's STRUCTURE, not
// merely that something got written.
//
// Round-tripping the PTX fixture also proves both halves agree: what the
// importer recovered as 24 misses must come back out as 24 empty cells.
const PTX = join(repoRoot, 'tests', 'e2e', 'fixtures', 'structured-scan.ptx');

test('exports a scan as PTX with a complete grid and the misses as empty cells', async () => {
  const { app, page, close } = await launchApp();

  try {
    const outDir = mkdtempSync(join(tmpdir(), 'phytograph-ptxexport-'));
    await stubSaveDialog(app, join(outDir, 'scan.ptx'));

    // Import the PTX so the scan carries a real grid (row/column indices) and a
    // scanner pose — exactly the state PTX export needs.
    await importFiles(app, page, 'import-auto', PTX);
    await completeImportWizard(page);
    await expect(page.getByTestId('scan-row').first()).toBeVisible({ timeout: 30_000 });

    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await expect(page.getByTestId('export-modal')).toBeVisible();

    await page.getByTestId('export-scan-mode-data').click();
    await page.getByTestId('export-scan-format-ptx').click();
    await expect(page.getByTestId('export-scan-format-ptx')).toHaveAttribute('data-active', 'true');

    // PTX writes every cell either way, so the misses toggle is inert and says so
    // rather than sitting there looking live.
    await expect(page.getByTestId('export-scan-ptx-note')).toBeVisible();
    await expect(page.getByTestId('export-scan-include-misses')).toBeDisabled();
    // Fixed schema — no column picker, like E57.
    await expect(page.getByTestId('export-column-picker')).toHaveCount(0);

    await page.getByTestId('export-scan-xml').click();

    await expect.poll(
      () => readdirSync(outDir).filter(f => f.toLowerCase().endsWith('.ptx')).length,
      { timeout: 60_000 },
    ).toBeGreaterThan(0);

    const name = readdirSync(outDir).find(f => f.toLowerCase().endsWith('.ptx'))!;
    const lines = readFileSync(join(outDir, name), 'utf8').trimEnd().split('\n');

    // Header declares columns then rows, and the body is exactly that many cells.
    const cols = Number(lines[0]);
    const rows = Number(lines[1]);
    expect([cols, rows]).toEqual([12, 8]);
    expect(lines.length).toBe(10 + cols * rows);

    // Row-vector transform: translation in the LAST row, ending in 1.
    expect(lines[9].trim().split(/\s+/)).toEqual(
      ['2.000000', '-1.000000', '1.500000', '1.000000']);
    // Identity rotation, so the points are scanner-local.
    expect(lines[3].trim()).toBe('1.000000 0.000000 0.000000');

    const body = lines.slice(10);
    const empty = body.filter(l => l.startsWith('0.000000 0.000000 0.000000'));
    // The 24 cells the importer recovered as sky/miss come back as empty cells.
    expect(empty.length).toBe(24);
    expect(body.length - empty.length).toBe(72);
    // Every data line has the same fixed width (4 or 7 tokens, colour-dependent).
    const widths = new Set(body.map(l => l.trim().split(/\s+/).length));
    expect(widths.size).toBe(1);
  } finally {
    await close();
  }
});
