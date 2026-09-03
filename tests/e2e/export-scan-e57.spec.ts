import { test, expect } from '@playwright/test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { stubExportFolder } from './helpers/exportFolder';
import { getOpenDialogCalls } from './helpers/stubOpenDialog';
import { resetToFreshScene } from './helpers/resetApp';

// E57 export -> import round trip, through the real UI both ways.
//
// The property under test is the one that used to be broken: our E57 writer
// emitted x/y/z + intensity + colour and nothing else, so an exported miss was
// an ordinary point parked ~1 km out with NOTHING marking it. Re-importing our
// own export therefore read the whole miss shell as genuine returns — the
// extent-inflation failure CLAUDE.md warns about. The writer now marks misses
// with E57's own `cartesianInvalidState` (the very field the importer reads) and
// writes rowIndex/columnIndex whenever the scan can be gridded.
//
// A file count proves none of that, so this spec reads the bytes it wrote. An
// E57 carries a plain-text XML section naming every per-point field it stores,
// which is exactly where the difference shows: the old writer's file lists only
// cartesianX/Y/Z (+ colour/intensity), the new one also lists
// cartesianInvalidState and rowIndex/columnIndex. The file is then re-imported
// through the real UI to confirm it still loads as a scan.
//
// Note the scan row's `data-point-count` is NOT a usable signal here — it tracks
// the octree/edit state rather than the freshly imported miss split, and reads
// the same whether or not misses were flagged.
const E57 = join(repoRoot, 'tests', 'e2e', 'fixtures', 'structured-scan.e57');

const HITS = 15;
const MISSES = 5;

// An E57 is binary, but it carries a plain-text XML section describing its
// contents — one node per per-point field. Reading it is how this spec asserts
// on what was actually written without pulling in a binary E57 parser.
//
// The file is paged: every 1024 bytes is 1020 of payload plus a 4-byte CRC, and
// those CRCs land INSIDE the XML text. Decoding the raw bytes therefore splices
// checksum noise into any field name unlucky enough to straddle a page boundary
// (`cartesianInvalidState` became `cartesianV\u0260MInvalidState`, so a naive
// `toContain` failed against a file that was perfectly correct). Strip the CRCs
// first and the XML reassembles exactly.
const E57_PAGE = 1024;
const E57_PAYLOAD = 1020;

function e57Xml(path: string): string {
  const buf = readFileSync(path);
  const pages: Buffer[] = [];
  for (let i = 0; i < buf.length; i += E57_PAGE) {
    pages.push(buf.subarray(i, Math.min(i + E57_PAYLOAD, buf.length)));
  }
  const payload = Buffer.concat(pages);
  const start = payload.indexOf(Buffer.from('<?xml'));
  expect(start).toBeGreaterThanOrEqual(0);
  return payload.subarray(start).toString('utf8');
}

function recordCount(xml: string): number {
  const m = xml.match(/recordCount="(\d+)"/);
  expect(m).not.toBeNull();
  return Number(m![1]);
}

test.describe('E57 scan export', () => {
  let session: Awaited<ReturnType<typeof launchApp>>;

  test.beforeAll(async () => {
    session = await launchApp();
  });

  test.afterAll(async () => {
    await session?.close();
  });

  test.beforeEach(async () => {
    await resetToFreshScene(session.app, session.page);
  });

  test('round-trips misses through an exported E57', async () => {
    const { app, page } = session;
    const outDir = mkdtempSync(join(tmpdir(), 'phytograph-e57-rt-'));

    // ---- Import the structured fixture: 15 hits in the octree, 5 misses held
    // back in the session.
    await importFiles(app, page, 'import-auto', E57);
    await completeImportWizard(page);
    const scanRow = page.getByTestId('scan-row').first();
    await expect(scanRow).toBeVisible({ timeout: 30_000 });
    await expect(scanRow).toHaveAttribute('data-point-count', String(HITS));

    // ---- Export it back out as E57, misses included (the default).
    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await expect(page.getByTestId('export-scan-section')).toBeVisible();
    await page.getByTestId('export-scan-mode-data').click();
    await page.getByTestId('export-scan-format-e57').click();
    await expect(page.getByTestId('export-scan-format-e57')).toHaveAttribute('data-active', 'true');

    // The toggle stays LIVE for E57 (unlike PTX, where every cell is written
    // regardless and the control is inert). It must be on for misses to survive.
    const missBox = page.getByTestId('export-scan-include-misses');
    await expect(missBox).toBeEnabled();
    await expect(missBox).toBeChecked();

    await stubExportFolder(app, page, outDir, 'roundtrip');
    await page.getByTestId('export-scan-xml').click();
    await expect.poll(async () => (await getOpenDialogCalls(app)).length, { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect.poll(
      () => readdirSync(outDir).filter(f => f.endsWith('.e57')).length,
      { timeout: 30_000, intervals: [200, 500, 1000] },
    ).toBe(1);

    // ---- Read what we wrote. The E57's XML section names each stored field.
    const written = readdirSync(outDir).filter(f => f.endsWith('.e57'))[0];
    const xml = e57Xml(join(outDir, written));

    // The flag that makes a miss a miss. Without it the exported miss shell
    // re-imports as ~1 km-out genuine returns — the whole point of the change.
    expect(xml).toContain('cartesianInvalidState');
    // Structured: the fixture is a real raster, so the grid travels with it.
    expect(xml).toContain('rowIndex');
    expect(xml).toContain('columnIndex');
    // Every cell was written, hits and misses alike.
    expect(recordCount(xml)).toBe(HITS + MISSES);

    // ---- And it still loads as a scan through the real import path.
    await resetToFreshScene(app, page);
    await importFiles(app, page, 'import-auto', join(outDir, written));
    await completeImportWizard(page);

    const reRow = page.getByTestId('scan-row').first();
    await expect(reRow).toBeVisible({ timeout: 30_000 });
    const scanId = await reRow.getAttribute('data-scan-id');
    expect(scanId).toBeTruthy();
    // Re-imported misses are recovered from the flag, so the overlay is offered.
    await expect(page.getByTestId(`scan-toggle-misses-${scanId}`)).toBeVisible();
  });

  test('excluding misses writes a hits-only file', async () => {
    const { app, page } = session;
    const outDir = mkdtempSync(join(tmpdir(), 'phytograph-e57-hits-'));

    await importFiles(app, page, 'import-auto', E57);
    await completeImportWizard(page);
    await expect(page.getByTestId('scan-row').first())
      .toHaveAttribute('data-point-count', String(HITS), { timeout: 30_000 });

    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await page.getByTestId('export-scan-mode-data').click();
    await page.getByTestId('export-scan-format-e57').click();

    // Untick: for E57 this genuinely drops the miss cells, where the same click
    // on a PTX would change nothing.
    await page.getByTestId('export-scan-include-misses').uncheck();

    await stubExportFolder(app, page, outDir, 'hitsonly');
    await page.getByTestId('export-scan-xml').click();
    await expect.poll(
      () => readdirSync(outDir).filter(f => f.endsWith('.e57')).length,
      { timeout: 30_000, intervals: [200, 500, 1000] },
    ).toBe(1);

    // The miss cells are gone: only the hits were written, and with nothing
    // left to flag there is no invalid-state field either. Contrast the PTX
    // writer, where the same click changes not one byte.
    const written = readdirSync(outDir).filter(f => f.endsWith('.e57'))[0];
    const xml = e57Xml(join(outDir, written));
    expect(recordCount(xml)).toBe(HITS);
    expect(xml).not.toContain('cartesianInvalidState');
    // The grid survives the drop — a sparse raster is still a raster.
    expect(xml).toContain('rowIndex');

    // It still loads, and offers no miss overlay because it carries none.
    await resetToFreshScene(app, page);
    await importFiles(app, page, 'import-auto', join(outDir, written));
    await completeImportWizard(page);
    const reRow = page.getByTestId('scan-row').first();
    await expect(reRow).toBeVisible({ timeout: 30_000 });
    const scanId = await reRow.getAttribute('data-scan-id');
    await expect(page.getByTestId(`scan-toggle-misses-${scanId}`)).toHaveCount(0);
  });
});
