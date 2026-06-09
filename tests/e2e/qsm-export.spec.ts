import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { completeImportWizard } from './helpers/importWizard';

const TREE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// The SimpleForest-compatible header the CSV export must emit verbatim.
const CSV_HEADER =
  'ID,parentID,branchID,branchOrder,segmentID,parentSegmentID,' +
  'startX,startY,startZ,endX,endY,endZ,' +
  'axisX,axisY,axisZ,radius,length,surfaceCoverage,meanAbsDeviation';

// Build a QSM through the real UI, then export it via the export dialog. Drives
// the LIVE backend (no mocks) and reads the WRITTEN FILE back off disk to assert
// the contents are correct — not merely that a file appeared. The only thing
// stubbed is the native folder-picker, redirected to a tmp dir (we can't click
// an OS-native dialog; the rest of the flow is real).
test('exports a built QSM to CSV and OBJ via the export dialog', async () => {
  const { app, page, close } = await launchApp();
  const outDir = mkdtempSync(join(tmpdir(), 'qsm-export-'));

  try {
    await expect(page.getByTestId('backend-splash')).toHaveCount(0, { timeout: 60_000 });

    // Redirect the main-process directory picker to our tmp dir. This is the
    // native dialog only — every other step (import, build, format choice,
    // write) runs for real.
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () =>
        ({ canceled: false, filePaths: [dir] }) as Electron.OpenDialogReturnValue;
    }, outDir);

    // Import a tree and build a QSM through the real UI.
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-pointcloud').click(),
    ]);
    await chooser.setFiles([TREE]);
    await completeImportWizard(page);

    const treeRow = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
    await expect(treeRow).toBeVisible({ timeout: 20_000 });
    // A single import auto-selects the new scan — don't click (that would toggle
    // it off); just confirm it's selected before building.
    await expect(treeRow).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('tool-qsm').click();
    await expect(page.getByTestId('qsm-panel')).toBeVisible();
    await page.getByTestId('qsm-build-button').click();

    const qsmRow = page.getByTestId('qsm-row');
    await expect(qsmRow).toHaveCount(1, { timeout: 120_000 });
    const cylinderCount = parseInt((await qsmRow.first().getAttribute('data-cylinder-count'))!, 10);
    expect(cylinderCount).toBeGreaterThan(10);

    // --- Open the export dialog ---
    await page.getByTestId('qsm-export-open').click();
    await expect(page.getByTestId('qsm-export-panel')).toBeVisible();
    // The dialog lists the built QSM with a checkbox (pre-selected).
    const checkbox = page.locator('[data-testid^="qsm-export-checkbox-"]');
    await expect(checkbox).toHaveCount(1);
    await expect(checkbox.first()).toBeChecked();

    // --- Export CSV ---
    await page.getByTestId('qsm-export-format-csv').click();
    await page.getByTestId('qsm-export-confirm').click();
    await expect(page.getByTestId('qsm-export-panel')).toHaveCount(0, { timeout: 30_000 });

    const csvFiles = readdirSync(outDir).filter(f => f.endsWith('.csv'));
    expect(csvFiles).toHaveLength(1);
    const csv = readFileSync(join(outDir, csvFiles[0]), 'utf-8');
    const csvLines = csv.trim().split('\n');
    // Header is exactly the SimpleForest layout.
    expect(csvLines[0]).toBe(CSV_HEADER);
    // One row per cylinder, matching the count shown in the panel.
    expect(csvLines.length - 1).toBe(cylinderCount);
    // A root cylinder (parentID = -1) exists.
    const dataRows = csvLines.slice(1).map(l => l.split(','));
    expect(dataRows.some(r => r[1] === '-1')).toBe(true);

    // --- Export OBJ (re-open the dialog) ---
    await page.getByTestId('qsm-export-open').click();
    await expect(page.getByTestId('qsm-export-panel')).toBeVisible();
    await page.getByTestId('qsm-export-format-obj').click();
    await page.getByTestId('qsm-export-confirm').click();
    await expect(page.getByTestId('qsm-export-panel')).toHaveCount(0, { timeout: 30_000 });

    const objFiles = readdirSync(outDir).filter(f => f.endsWith('.obj'));
    expect(objFiles).toHaveLength(1);
    const obj = readFileSync(join(outDir, objFiles[0]), 'utf-8');
    expect(obj).toMatch(/^v /m); // has vertex lines
    expect(obj).toMatch(/^f /m); // has face lines
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    await close();
  }
});
