import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { stubSaveDialog } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'colored-intensity.xyz');
const POINTS = 24;

/**
 * Exporting to .asc, .pts and .pcd — the three formats Phytograph could import
 * but never write, so a cloud brought in as `.pts` could not leave as one.
 *
 * The fixture carries BOTH colour and intensity on purpose. A geometry-only
 * cloud would pass these tests even if the columns were mis-ordered, and column
 * ORDER is the whole difficulty with PTS: the canonical layout is
 * `x y z intensity r g b`, intensity BEFORE colour, after a leading point-count
 * line. Getting that wrong produces a file that still parses and is read wrong
 * (a reader takes column 3 as red), which is exactly the failure a "didn't
 * throw" test cannot see.
 *
 * Each test asserts on the CONTENT of the file on disk, and the round-trip test
 * re-imports it through the real wizard — the proof that what we write, we can
 * read. Two importer bugs had to be fixed for that to hold (the count line read
 * as data; the intensity-before-colour layout unrecognised), both pinned in
 * backend-api/tests/test_export_pts_asc_pcd.py.
 *
 * Shared session: one app + backend for the whole file (see CLAUDE.md E2E rules).
 */

let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});

test.beforeEach(async () => {
  const { resetToFreshScene } = await import('./helpers/resetApp');
  await resetToFreshScene(session.app, session.page);
});

async function importAndOpenExport(outName: string) {
  const { app, page } = session;
  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-fmt-export-'));
  const savePath = join(outDir, outName);

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator(
    '[data-testid="scan-row"][data-scan-name="colored-intensity.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(POINTS);
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  await stubSaveDialog(app, savePath);
  await page.evaluate(() => (window as any).__openExportPanel?.());
  await expect(page.getByTestId('export-modal')).toBeVisible();
  return { savePath, page };
}

async function readExported(savePath: string): Promise<string> {
  await expect
    .poll(() => (existsSync(savePath) ? readFileSync(savePath, 'utf8').length : 0), {
      timeout: 30_000,
      intervals: [200, 500, 1000],
    })
    .toBeGreaterThan(0);
  await expect(
    session.page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }),
  ).toBeVisible({ timeout: 30_000 });
  return readFileSync(savePath, 'utf8');
}

const dataLines = (text: string) =>
  text.split('\n').filter((l) => l.trim().length > 0 && !l.trim().startsWith('#'));

test('exports PTS with a count line and intensity before colour', async () => {
  const { savePath, page } = await importAndOpenExport('cloud.pts');
  await page.getByTestId('export-format-pts').click();
  await page.getByTestId('export-cloud-go').click();

  const lines = dataLines(await readExported(savePath));
  // Canonical PTS opens with the point COUNT — this is what distinguishes it
  // from a bare column file for Cyclone / CloudCompare.
  expect(lines[0].trim()).toBe(String(POINTS));
  expect(lines).toHaveLength(POINTS + 1);

  // `x y z intensity r g b` — the ordering is the whole point. The fixture's
  // first point is (0.4, 0, 0) with rgb(0, 0, 255), so columns 4-6 must be that
  // colour and column 3 must be the intensity sitting BEFORE it.
  const first = lines[1].trim().split(/\s+/);
  expect(first).toHaveLength(7);
  expect(Number(first[0])).toBeCloseTo(0.4, 5);
  // rgb(0, 0, 255). Blue is checked with a ±1 tolerance for the PRE-EXISTING
  // LAS colour convention, not for slack here: LAS stores 8-bit colour as
  // `value * 256`, so 255 → 65280 reads back as 0.9961 and rounds to 254. The
  // shipped CSV/PLY writers emit the same 254 from the same cloud.
  expect([first[4], first[5]].map(Number)).toEqual([0, 0]);
  expect(Number(first[6])).toBeGreaterThanOrEqual(254);

  // Column 3 carries a real, varying intensity — not a colour channel and not a
  // constant. Its ABSOLUTE value is deliberately not asserted: importing through
  // the octree normalises intensity to the LAS uint16 range (see
  // `_intensity_to_uint16` — Helios reflectance is in dB, other exports use
  // 0..1, so a fixed scale would crush whole columns to zero), which legitimately
  // maps the fixture's minimum to 0. What must hold is that the column is
  // intensity-shaped: monotonic across a fixture whose intensity rises with the
  // point index, and never a 0-255 colour byte pattern.
  const col3 = lines.slice(1).map((l) => Number(l.trim().split(/\s+/)[3]));
  expect(new Set(col3).size).toBeGreaterThan(1);
  for (let i = 1; i < col3.length; i++) expect(col3[i]).toBeGreaterThan(col3[i - 1]);
});

test('PTS offers no column picker — its schema is fixed', async () => {
  const { page } = await importAndOpenExport('unused.pts');
  await page.getByTestId('export-format-pts').click();
  // A subset of a positional format would still parse and be read WRONG, so the
  // picker must not be offered at all.
  await expect(page.getByTestId('export-column-picker')).toBeHidden();
  await expect(page.getByTestId('export-fixed-schema-note')).toBeVisible();
});

test('exports ASC as bare positional ASCII with no header line', async () => {
  const { savePath, page } = await importAndOpenExport('cloud.asc');
  await page.getByTestId('export-format-asc').click();
  // ASC is xyz-family, so the picker DOES apply here.
  await expect(page.getByTestId('export-column-picker')).toBeVisible();
  await page.getByTestId('export-cloud-go').click();

  const text = await readExported(savePath);
  // No header at all — a legend line would be read back as a point.
  expect(text.split('\n')[0].trim().startsWith('#')).toBe(false);
  const lines = dataLines(text);
  expect(lines).toHaveLength(POINTS);
  const cols = lines[0].trim().split(/\s+/).map(Number);
  expect(cols.length).toBeGreaterThanOrEqual(3);
  for (const c of cols) expect(Number.isFinite(c)).toBe(true);
});

test('exports PCD with a valid header and packed RGB', async () => {
  const { savePath, page } = await importAndOpenExport('cloud.pcd');
  await page.getByTestId('export-format-pcd').click();
  // Fixed schema (position + colour): no picker.
  await expect(page.getByTestId('export-column-picker')).toBeHidden();
  await page.getByTestId('export-cloud-go').click();

  const text = await readExported(savePath);
  expect(text.startsWith('# .PCD v0.7')).toBe(true);
  expect(text).toContain('FIELDS x y z rgb');
  expect(text).toContain(`POINTS ${POINTS}`);
  expect(text).toContain('DATA ascii');

  const body = text.split('DATA ascii\n')[1].split('\n').filter((l) => l.trim());
  expect(body).toHaveLength(POINTS);
  // Colour is a float32 BIT PATTERN holding packed 24-bit RGB, not a number:
  // decode it the way a PCD reader does and check it against the fixture, whose
  // first point is rgb(0, 0, 255).
  //
  // The ±1 tolerance is a PRE-EXISTING round-trip quirk, not slack for this
  // writer: LAS stores 8-bit colour as `value * 256`, so 255 becomes 65280,
  // which reads back as 65280/65535 = 0.9961 and rounds to 254. The shipped CSV
  // and PLY writers produce exactly the same 254 from the same cloud — verified
  // directly — so this is the octree colour convention, not the PCD packing.
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = parseFloat(body[0].trim().split(/\s+/)[3]);
  const p = new Uint32Array(buf)[0];
  const [r, g, b] = [(p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff];
  expect(r).toBe(0);
  expect(g).toBe(0);
  expect(b).toBeGreaterThanOrEqual(254);   // 255 exactly, or 254 via the LAS *256 convention
});

test('a re-imported PTS export keeps its geometry, colour and intensity', async () => {
  // The round trip is the point of the feature: a format we can write but not
  // read back would be a gap, not a fix. Before the importer fixes, this cloud
  // came back with colour and intensity BOTH silently absent.
  const { savePath, page } = await importAndOpenExport('roundtrip.pts');
  await page.getByTestId('export-format-pts').click();
  await page.getByTestId('export-cloud-go').click();
  await readExported(savePath);

  const { resetToFreshScene } = await import('./helpers/resetApp');
  await resetToFreshScene(session.app, session.page);

  await importFiles(session.app, session.page, 'import-point-cloud', savePath);
  await completeImportWizard(session.page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="roundtrip.pts"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  // The count line must not cost a point, and must not become one.
  expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(POINTS);

  // Colour and intensity actually came back. The export column picker is the
  // user-visible list of fields the re-imported cloud HOLDS, so it is the
  // honest check: before the importer fixes it offered bare x/y/z, because both
  // groups had been silently dropped on read. (The Display panel's colour-mode
  // dropdown is not usable here — it lists rgb/intensity unconditionally,
  // whether or not the cloud carries either.)
  await page.evaluate(() => (window as any).__openExportPanel?.());
  await expect(page.getByTestId('export-modal')).toBeVisible();
  await page.getByTestId('export-format-csv').click();
  const picker = page.getByTestId('export-column-picker');
  await expect(picker).toBeVisible();
  const slugs = await page
    .locator('[data-testid="export-column-row"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-slug')));
  expect(slugs).toEqual(expect.arrayContaining(['x', 'y', 'z']));
  expect(slugs).toEqual(expect.arrayContaining(['r', 'g', 'b']));
  expect(slugs).toContain('intensity');
});
