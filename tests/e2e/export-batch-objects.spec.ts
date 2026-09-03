import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubExportFolder } from './helpers/exportFolder';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// The Export window's object list covers the WHOLE scene.
//
// It used to list only clouds carrying scanner parameters, pre-checked to the
// Scans-panel selection — so a plain .xyz import never appeared there at all,
// and a batch export looked like it depended on what you had selected in the
// right-hand panel. Now every cloud is listed, the panel selection only decides
// what starts CHECKED, and a select-all checkbox covers the rows the chosen
// output can actually write.
//
// These drive that through the real UI against the live backend and assert on
// the files that land on disk.

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');       // 60 pts
const SPARSE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sparse.xyz');   // 30 pts
const SPHERE_XML = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');

let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});
test.beforeEach(async () => {
  await resetToFreshScene(session.app, session.page);
});

/** Data rows in an exported text cloud (the header rides a '#' comment). */
function dataRows(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#'));
}

test('exports several plain clouds in one batch, with select-all', async () => {
  const { app, page } = session;
  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-batch-plain-'));

  // Two plain clouds: no scanner parameters, so before this change neither was
  // listed in the export window and they could only go out one at a time.
  await importFiles(app, page, 'import-point-cloud', TINY);
  await completeImportWizard(page);
  await importFiles(app, page, 'import-point-cloud', SPARSE);
  await completeImportWizard(page);
  await expect(page.getByTestId('scans-panel').locator('[data-testid="scan-row"]'))
    .toHaveCount(2, { timeout: 20_000 });

  // Deselect everything in the panel: the list must still show both clouds.
  await page.getByTitle('Deselect All').click();

  await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
  await expect(page.getByTestId('export-modal')).toBeVisible();

  const rows = page.getByTestId('export-scan-row');
  await expect(rows).toHaveCount(2);
  const labels = await rows.evaluateAll(els => els.map(e => e.getAttribute('data-label')));
  expect(labels.sort()).toEqual(['sparse', 'tiny']);

  // With nothing selected in the panel, everything starts checked — and because
  // neither cloud is a scan, the Helios XML output stands down and says why.
  const selectAll = page.getByTestId('export-object-list-select-all');
  await expect(selectAll).toBeChecked();
  await expect(page.getByTestId('export-scan-mode-xml')).toBeDisabled();
  await expect(page.getByTestId('export-scan-mode-data')).toHaveAttribute('data-active', 'true');

  // Deselect all, then re-select all: the checkbox drives every row.
  await selectAll.click();
  await expect(rows.nth(0)).toHaveAttribute('data-checked', 'false');
  await expect(rows.nth(1)).toHaveAttribute('data-checked', 'false');
  await expect(page.getByTestId('export-scan-xml')).toBeDisabled();
  await selectAll.click();
  await expect(rows.nth(0)).toHaveAttribute('data-checked', 'true');
  await expect(rows.nth(1)).toHaveAttribute('data-checked', 'true');

  await page.getByTestId('export-scan-format-xyz').click();
  // A base name typed in the window + a folder chosen from the OS — the export
  // writes one file per object, so there is no single Save-As path to give.
  await stubExportFolder(app, page, outDir, 'clouds');
  await expect(page.getByTestId('export-file-preview')).toHaveAttribute('data-file-count', '2');
  await page.getByTestId('export-scan-xml').click();

  await expect(page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }))
    .toBeVisible({ timeout: 60_000 });

  // One file per object, each named for the object it holds — and the mapping is
  // the point of the naming: the file called after tiny.xyz has tiny's 60 points,
  // not whichever cloud happened to be added first.
  const written = readdirSync(outDir).sort();
  expect(written).toEqual(['clouds_sparse.xyz', 'clouds_tiny.xyz']);
  expect(dataRows(join(outDir, 'clouds_tiny.xyz')).length).toBe(60);
  expect(dataRows(join(outDir, 'clouds_sparse.xyz')).length).toBe(30);
});

test('lists plain clouds alongside scans and blocks them only where the format needs scan geometry', async () => {
  const { app, page } = session;
  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-batch-mixed-'));

  // Four scans (sphere.xml) + one plain cloud.
  await stubOpenDialog(app, SPHERE_XML);
  await page.getByTestId('tool-add-scan').click();
  await expect(page.getByTestId('scan-parameters-popup')).toBeVisible();
  await page.getByTestId('scan-import-xml').click();
  await expect(page.getByTestId('scan-parameters-popup')).not.toBeVisible({ timeout: 20_000 });
  await completeImportWizard(page);
  await importFiles(app, page, 'import-point-cloud', TINY);
  await completeImportWizard(page);

  const panelRows = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
  await expect(panelRows).toHaveCount(5, { timeout: 30_000 });

  // Select exactly ONE scan in the panel — the export list must still show all
  // five objects, with only that one checked.
  await page.getByTitle('Deselect All').click();
  await panelRows.nth(0).getByTestId('scan-row-name').click();
  await expect(panelRows.nth(0)).toHaveAttribute('data-selected', 'true');

  await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
  await expect(page.getByTestId('export-modal')).toBeVisible();

  const rows = page.getByTestId('export-scan-row');
  await expect(rows).toHaveCount(5);
  const checked = await rows.evaluateAll(
    els => els.filter(e => e.getAttribute('data-checked') === 'true').length);
  expect(checked).toBe(1);

  // XML mode: the plain cloud is the one row that can't be written, and the row
  // says why rather than silently disappearing.
  await page.getByTestId('export-scan-mode-xml').click();
  await expect(page.getByTestId('export-scan-mode-xml')).toHaveAttribute('data-active', 'true');
  const plainRow = page.locator('[data-testid="export-scan-row"][data-label="tiny"]');
  await expect(plainRow).toHaveAttribute('data-disabled', 'true');
  await expect(plainRow).toHaveAttribute('title', /scanner parameters/i);

  // Select-all in XML mode covers only the four scans.
  await page.getByTestId('export-object-list-select-all').click();
  await expect(page.getByTestId('export-object-list')).toContainText('(4/5 selected)');
  await expect(plainRow).toHaveAttribute('data-checked', 'false');

  // Switch to Data only: the plain cloud becomes writable again, and the
  // checkmarks the XML mode had to grey out come back rather than being lost.
  await page.getByTestId('export-scan-mode-data').click();
  await page.getByTestId('export-scan-format-xyz').click();
  await expect(plainRow).toHaveAttribute('data-disabled', 'false');
  await page.getByTestId('export-object-list-select-all').click();
  await expect(page.getByTestId('export-object-list')).toContainText('(5/5 selected)');

  await stubExportFolder(app, page, outDir, 'mixed');
  await page.getByTestId('export-scan-xml').click();
  await expect(page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }))
    .toBeVisible({ timeout: 120_000 });

  // Five objects → five data files, and the plain cloud's own 60 points are in
  // there (the batch writer took a cloud with no scan geometry at all).
  const written = readdirSync(outDir).sort();
  expect(written).toHaveLength(5);
  expect(written).toContain('mixed_tiny.xyz');
  expect(dataRows(join(outDir, 'mixed_tiny.xyz')).length).toBe(60);
});
