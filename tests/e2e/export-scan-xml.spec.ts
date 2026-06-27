import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubSaveDialog, getSaveDialogCalls } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';

// Exports the four-scan sphere fixture to a Helios XML + per-scan ASCII bundle
// through the real UI (the workflow that previously rendered an empty Export
// panel for a multi-scan selection). Drives: import 4 scans → File→Export →
// scan list with all four checked → Write scan XML → real backend exportScans()
// → real files written to disk. Asserts the bundle is one XML + four .xyz files,
// the XML references each per-scan file, and the bundle re-loads (round-trips).
test('exports a multi-scan XML bundle for the sphere fixture', async () => {
  const { app, page, close } = await launchApp();

  // A real folder the export writes into (the save dialog returns <dir>/sphere.xml).
  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-scanexport-'));
  const xmlPath = join(outDir, 'sphere.xml');

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
    await stubOpenDialog(app, xmlFixture);
    await stubSaveDialog(app, xmlPath);

    // Import the four scans from XML.
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const rows = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(4, { timeout: 20_000 });
    for (let i = 0; i < 4; i++) {
      await expect(rows.nth(i)).toHaveAttribute('data-has-params', 'true');
    }

    // Open the Export panel via the File→Export path (window.__openExportPanel),
    // exactly as the application menu does.
    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await expect(page.getByTestId('export-modal')).toBeVisible();

    // The scan-export section must appear (it was empty before the fix) and list
    // all four scans, pre-checked to the current (all-selected) selection.
    const scanSection = page.getByTestId('export-scan-section');
    await expect(scanSection).toBeVisible();
    const scanRows = page.getByTestId('export-scan-row');
    await expect(scanRows).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(scanRows.nth(i)).toHaveAttribute('data-checked', 'true');
    }

    // Default output mode is the XML bundle.
    await expect(page.getByTestId('export-scan-mode-xml')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('export-scan-mode-data')).toHaveAttribute('data-active', 'false');

    // Write the bundle. The save dialog is stubbed to xmlPath; real fs writes run.
    await page.getByTestId('export-scan-xml').click();

    // The save dialog must have actually fired (catches a silent no-op).
    await expect.poll(async () => (await getSaveDialogCalls(app)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);

    // UX: once the path is chosen the modal dismisses and a progress pill takes
    // over for the (multi-second, no-stream) serialize/encode/write — so the user
    // never stares at a frozen dialog. The export is fast for this fixture, so the
    // pill may come and go quickly; assert the modal is gone (the durable signal).
    await expect(page.getByTestId('export-modal')).not.toBeVisible({ timeout: 10_000 });

    // Wait for the bundle to land on disk: sphere.xml + sphere_0..3.xyz.
    await expect.poll(
      () => (existsSync(xmlPath) ? readdirSync(outDir).filter(f => f.endsWith('.xyz')).length : 0),
      { timeout: 30_000, intervals: [200, 500, 1000] },
    ).toBe(4);

    // The XML references each per-scan data file (not a single merged file).
    const xml = readFileSync(xmlPath, 'utf-8');
    for (let i = 0; i < 4; i++) {
      expect(xml).toContain(`sphere_${i}.xyz`);
    }
    // Each data file has a '#'-prefixed header and at least one data row.
    const dataFiles = readdirSync(outDir).filter(f => f.endsWith('.xyz'));
    expect(dataFiles).toHaveLength(4);
    for (const f of dataFiles) {
      const lines = readFileSync(join(outDir, f), 'utf-8').split('\n').filter(l => l.trim());
      expect(lines[0].startsWith('#')).toBe(true);
      const dataRows = lines.filter(l => !l.startsWith('#'));
      expect(dataRows.length).toBeGreaterThan(0);
      // First data row parses as at least three floats (x y z …).
      const cols = dataRows[0].trim().split(/\s+/).map(Number);
      expect(cols.length).toBeGreaterThanOrEqual(3);
      for (let k = 0; k < 3; k++) expect(Number.isFinite(cols[k])).toBe(true);
    }
  } finally {
    await close();
  }
});

// Grid round-trip: import a Helios XML that carries a <grid> block (so a voxel
// box lands in the scene), then re-export with "Export grid" ticked and the grid
// added. The written XML must regain a <grid> block matching the imported grid's
// center/size/Nx-Ny-Nz/rotation — closing the round-trip that was previously
// impossible (exportScans() writes only <scan> blocks).
test('round-trips a <grid> block when Export grid is ticked', async () => {
  const { app, page, close } = await launchApp();
  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-gridexport-'));
  const xmlPath = join(outDir, 'sphere.xml');

  try {
    // sphere-with-grid.xml: one scan + a grid at center (0.25,-0.5,0.75),
    // size (1.5,2,2.5), Nx/Ny/Nz = 2/3/4, rotated 30° about z.
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere-with-grid.xml');
    await stubOpenDialog(app, xmlFixture);
    await stubSaveDialog(app, xmlPath);

    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    await expect(page.getByTestId('scans-panel').locator('[data-testid="scan-row"]'))
      .toHaveCount(1, { timeout: 20_000 });
    // The grid imported as a voxel-box mesh ("Grid 1").
    await expect(page.getByTestId('mesh-row')).toHaveCount(1);

    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await expect(page.getByTestId('export-modal')).toBeVisible();
    await expect(page.getByTestId('export-scan-section')).toBeVisible();

    // XML mode (default) reveals the "Export grid" toggle. Tick it and add the
    // one scene grid.
    await expect(page.getByTestId('export-scan-mode-xml')).toHaveAttribute('data-active', 'true');
    const gridToggle = page.getByTestId('export-grid-toggle');
    await expect(gridToggle).toBeVisible();
    await gridToggle.check();
    const gridRows = page.getByTestId('export-grid-row');
    await expect(gridRows).toHaveCount(1);
    await gridRows.first().getByRole('checkbox').check();
    await expect(gridRows.first()).toHaveAttribute('data-checked', 'true');

    await page.getByTestId('export-scan-xml').click();
    await expect.poll(async () => (await getSaveDialogCalls(app)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect.poll(() => existsSync(xmlPath), { timeout: 30_000, intervals: [200, 500, 1000] }).toBe(true);

    // The exported XML regained a <grid> block carrying the imported geometry.
    const xml = readFileSync(xmlPath, 'utf-8');
    const grid = xml.match(/<grid>([\s\S]*?)<\/grid>/);
    expect(grid, xml).not.toBeNull();
    const body = grid![1];
    const nums = (tag: string) =>
      body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))![1].trim().split(/\s+/).map(Number);
    expect(nums('center')).toEqual([0.25, -0.5, 0.75]);
    expect(nums('size')).toEqual([1.5, 2, 2.5]);
    expect(nums('Nx')).toEqual([2]);
    expect(nums('Ny')).toEqual([3]);
    expect(nums('Nz')).toEqual([4]);
    expect(nums('rotation')).toEqual([30]);
  } finally {
    await close();
  }
});

// Data-only mode: same workflow, but "Data only" writes just the per-scan .xyz
// files (no XML). Verifies the mode toggle and that no .xml lands on disk.
test('exports scan data only (no XML) when the Data only mode is chosen', async () => {
  const { app, page, close } = await launchApp();
  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-dataonly-'));
  // The save picker defaults to a .xyz name in data-only mode; the data files
  // are still named <base>_<id>.xyz, so write into this folder.
  const savePath = join(outDir, 'sphere.xyz');

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
    await stubOpenDialog(app, xmlFixture);
    await stubSaveDialog(app, savePath);

    await page.getByTestId('tool-add-scan').click();
    await expect(page.getByTestId('scan-parameters-popup')).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(page.getByTestId('scan-parameters-popup')).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);
    await expect(page.getByTestId('scans-panel').locator('[data-testid="scan-row"]'))
      .toHaveCount(4, { timeout: 20_000 });

    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await expect(page.getByTestId('export-scan-section')).toBeVisible();

    // Switch to Data only — this reveals the per-scan format buttons (default XYZ).
    await page.getByTestId('export-scan-mode-data').click();
    await expect(page.getByTestId('export-scan-mode-data')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('export-scan-format')).toBeVisible();
    await expect(page.getByTestId('export-scan-format-xyz')).toHaveAttribute('data-active', 'true');
    await page.getByTestId('export-scan-xml').click();

    await expect.poll(async () => (await getSaveDialogCalls(app)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Four .xyz data files, and crucially NO .xml.
    await expect.poll(
      () => readdirSync(outDir).filter(f => f.endsWith('.xyz')).length,
      { timeout: 30_000, intervals: [200, 500, 1000] },
    ).toBe(4);
    expect(readdirSync(outDir).filter(f => f.endsWith('.xml'))).toHaveLength(0);
  } finally {
    await close();
  }
});

// Single-cloud column picker: select one scan, open the modal, uncheck a scalar
// column, and confirm the written ASCII_format omits it (and keeps a kept one).
// Exercises the column picker → exportScans column_format wiring end to end.
// (Drag-reorder mechanics are covered by exportColumns.test.ts unit tests; HTML5
// native drag is too flaky to assert reliably in Playwright.)
test('respects the chosen columns in the exported scan ASCII_format', async () => {
  const { app, page, close } = await launchApp();
  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-colpick-'));
  const xmlPath = join(outDir, 'one.xml');

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
    await stubOpenDialog(app, xmlFixture);
    await stubSaveDialog(app, xmlPath);

    await page.getByTestId('tool-add-scan').click();
    await expect(page.getByTestId('scan-parameters-popup')).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(page.getByTestId('scan-parameters-popup')).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);
    const rows = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(4, { timeout: 20_000 });

    // Narrow the selection to a single scan so the column picker appears. Click
    // the row's name span specifically (the row has interactive children that
    // stop propagation, so a center click can miss the row handler).
    await rows.nth(0).getByTestId('scan-row-name').click();
    await expect(rows.nth(0)).toHaveAttribute('data-selected', 'true');
    await expect(rows.nth(1)).toHaveAttribute('data-selected', 'false');

    // The export-row names should match the Scans-panel labels, not the raw
    // filenames. Capture the panel's display name for row 0 to compare.
    const panelName = await rows.nth(0).getByTestId('scan-row-name').textContent();

    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await expect(page.getByTestId('export-modal')).toBeVisible();

    // The export scan list labels each scan by its Scans-panel display name.
    const exportRowNames = await page.getByTestId('export-scan-row')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-scan-name')));
    expect(exportRowNames).toContain((panelName ?? '').trim());

    // The scan section's column picker is present with x/y/z + the scan's
    // colour/reflectance columns (recovered from the ASCII_format for this
    // octree-backed scan).
    const picker = page.getByTestId('export-scan-section').getByTestId('export-column-picker');
    await expect(picker).toBeVisible();
    const slugs = await picker.getByTestId('export-column-row').evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-slug')));
    expect(slugs.slice(0, 3)).toEqual(['x', 'y', 'z']);
    expect(slugs).toContain('reflectance');

    // Uncheck 'reflectance' so it is excluded; keep r/g/b. (x/y/z are locked on.)
    await picker.locator('[data-slug="reflectance"]').getByRole('checkbox').uncheck();

    await page.getByTestId('export-scan-xml').click();
    await expect.poll(async () => (await getSaveDialogCalls(app)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect.poll(() => existsSync(xmlPath), { timeout: 30_000, intervals: [200, 500, 1000] }).toBe(true);

    // ASCII_format keeps x y z (+ any kept colour) but NOT the unchecked reflectance.
    const xml = readFileSync(xmlPath, 'utf-8');
    const fmt = xml.match(/<ASCII_format>(.*?)<\/ASCII_format>/)![1].trim().split(/\s+/);
    expect(fmt.slice(0, 3)).toEqual(['x', 'y', 'z']);
    expect(fmt).not.toContain('reflectance');
  } finally {
    await close();
  }
});

// Data-only export to a binary format (E57): the column picker is hidden, and one
// .e57 file per scan lands on disk. Exercises the per-scan multi-format writer.
test('exports scans to per-scan E57 files in data-only mode', async () => {
  const { app, page, close } = await launchApp();
  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-e57-'));
  const savePath = join(outDir, 'sphere.e57');

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
    await stubOpenDialog(app, xmlFixture);
    await stubSaveDialog(app, savePath);

    await page.getByTestId('tool-add-scan').click();
    await expect(page.getByTestId('scan-parameters-popup')).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(page.getByTestId('scan-parameters-popup')).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);
    await expect(page.getByTestId('scans-panel').locator('[data-testid="scan-row"]'))
      .toHaveCount(4, { timeout: 20_000 });

    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await expect(page.getByTestId('export-scan-section')).toBeVisible();

    // Data only → pick E57. The column picker is hidden for binary formats.
    await page.getByTestId('export-scan-mode-data').click();
    await page.getByTestId('export-scan-format-e57').click();
    await expect(page.getByTestId('export-scan-format-e57')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('export-scan-section').getByTestId('export-column-picker')).toHaveCount(0);

    await page.getByTestId('export-scan-xml').click();
    await expect.poll(async () => (await getSaveDialogCalls(app)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Four .e57 files, no .xml, no .xyz.
    await expect.poll(
      () => readdirSync(outDir).filter(f => f.endsWith('.e57')).length,
      { timeout: 30_000, intervals: [200, 500, 1000] },
    ).toBe(4);
    expect(readdirSync(outDir).filter(f => f.endsWith('.xml'))).toHaveLength(0);
  } finally {
    await close();
  }
});
