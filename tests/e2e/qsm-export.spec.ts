import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { stubSaveDialog, getSaveDialogCalls } from './helpers/stubSaveDialog';

const TREE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// The SimpleForest-compatible header the CSV export must emit verbatim.
const CSV_HEADER =
  'ID,parentID,branchID,branchOrder,segmentID,parentSegmentID,' +
  'startX,startY,startZ,endX,endY,endZ,' +
  'axisX,axisY,axisZ,radius,length,surfaceCoverage,meanAbsDeviation';

// Build a QSM through the real UI, then export it via the export dialog. Drives
// the LIVE backend (no mocks) and reads the WRITTEN FILE back off disk to assert
// the contents are correct — not merely that a file appeared. The only thing
// stubbed is the native Save dialog, redirected to a tmp dir (we can't click an
// OS-native dialog; the rest of the flow is real). The stub also captures the
// options the renderer passed, which is how we assert the dialog offers an
// editable default filename rather than naming the file behind the user's back.
test('exports a built QSM to CSV and OBJ via the export dialog', async () => {
  const { app, page, close } = await launchApp();
  const outDir = mkdtempSync(join(tmpdir(), 'qsm-export-'));

  try {
    await expect(page.getByTestId('backend-splash')).toHaveCount(0, { timeout: 60_000 });

    // Import a tree and build a QSM through the real UI. The import uses the
    // `dialog:open` picker; the export below uses `dialog:save`, stubbed
    // separately once we get there.
    await importFiles(app, page, 'import-point-cloud', [TREE]);
    await completeImportWizard(page);

    const treeRow = page.locator('[data-testid="scan-row"][data-scan-name="tree"]');
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

    // --- Export CSV, accepting the suggested filename ---
    // Redirect the native Save dialog to a path inside our tmp dir. The returned
    // path stands in for what the user would confirm in the dialog; the options
    // the renderer passed are recorded so we can check the suggested default.
    const csvPath = join(outDir, 'suggested.csv');
    await stubSaveDialog(app, csvPath);

    await page.getByTestId('qsm-export-open').click();
    await expect(page.getByTestId('qsm-export-panel')).toBeVisible();
    // The dialog lists the built QSM with a checkbox (pre-selected).
    const checkbox = page.locator('[data-testid^="qsm-export-checkbox-"]');
    await expect(checkbox).toHaveCount(1);
    await expect(checkbox.first()).toBeChecked();

    await page.getByTestId('qsm-export-format-csv').click();
    await page.getByTestId('qsm-export-confirm').click();
    await expect(page.getByTestId('qsm-export-panel')).toHaveCount(0, { timeout: 30_000 });

    // The Save dialog fired, and it offered an editable default name derived
    // from the QSM's source scan — not a name chosen silently by the exporter.
    const csvCalls = (await getSaveDialogCalls(app)) as { defaultPath?: string }[];
    expect(csvCalls).toHaveLength(1);
    expect(csvCalls[0].defaultPath).toBe('tree.csv');

    const csvFiles = readdirSync(outDir).filter(f => f.endsWith('.csv'));
    expect(csvFiles).toEqual(['suggested.csv']);
    const csv = readFileSync(csvPath, 'utf-8');
    const csvLines = csv.trim().split('\n');
    // Header is exactly the SimpleForest layout.
    expect(csvLines[0]).toBe(CSV_HEADER);
    // One row per cylinder, matching the count shown in the panel.
    expect(csvLines.length - 1).toBe(cylinderCount);
    // A root cylinder (parentID = -1) exists.
    const dataRows = csvLines.slice(1).map(l => l.split(','));
    expect(dataRows.some(r => r[1] === '-1')).toBe(true);

    // --- Export OBJ under a name the "user" typed instead of the suggestion ---
    const renamedObj = join(outDir, 'my-custom-name.obj');
    await stubSaveDialog(app, renamedObj);

    await page.getByTestId('qsm-export-open').click();
    await expect(page.getByTestId('qsm-export-panel')).toBeVisible();
    await page.getByTestId('qsm-export-format-obj').click();
    await page.getByTestId('qsm-export-confirm').click();
    await expect(page.getByTestId('qsm-export-panel')).toHaveCount(0, { timeout: 30_000 });

    const objCalls = (await getSaveDialogCalls(app)) as { defaultPath?: string }[];
    expect(objCalls).toHaveLength(1);
    // Suggestion tracks the chosen format's extension...
    expect(objCalls[0].defaultPath).toBe('tree.obj');
    // ...but the file lands at the name the user chose, not the suggestion.
    const objFiles = readdirSync(outDir).filter(f => f.endsWith('.obj'));
    expect(objFiles).toEqual(['my-custom-name.obj']);
    const obj = readFileSync(renamedObj, 'utf-8');
    expect(obj).toMatch(/^v /m); // has vertex lines
    expect(obj).toMatch(/^f /m); // has face lines

    // An OBJ carries no colour of its own, so the sibling .mtl has to land on
    // disk beside it -- without it the tree opens in Blender as untextured grey
    // and the viewport's rank palette is lost. Named from the stem the USER
    // typed, since that's what the OBJ's mtllib line references.
    expect(obj).toContain('mtllib my-custom-name.mtl');
    expect(readdirSync(outDir).filter(f => f.endsWith('.mtl'))).toEqual([
      'my-custom-name.mtl',
    ]);
    const mtl = readFileSync(join(outDir, 'my-custom-name.mtl'), 'utf-8');
    // Every material the OBJ references must be declared in the library, or the
    // reader falls back to grey for the ones it can't resolve.
    const used = [...obj.matchAll(/^usemtl (\S+)$/gm)].map(m => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of new Set(used)) {
      expect(mtl).toContain(`newmtl ${name}`);
    }
    // Default rank mode -> the trunk material carries the palette's wood tan
    // (sRGB 0xb0/0x8d/0x57), not a placeholder grey.
    expect(mtl).toContain('newmtl rank_0');
    expect(mtl).toMatch(/Kd 0\.690196 0\.552941 0\.341176/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    await close();
  }
});
