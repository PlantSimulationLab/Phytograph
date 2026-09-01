import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubSaveDialog, getSaveDialogCalls } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';

// Exporting a gridded LAD result, end to end through the real UI against the
// live backend.
//
// The fixture is the same leaf-cube used by lad.spec.ts — a synthetic scan of
// the LAI=2 spherical leaf cube whose 1x1x1 m voxel at (0,0,0.5) has a KNOWN
// true LAD of 2.0 m^2/m^3. That matters: it means these tests can assert the
// exported number is right, not merely that a file appeared with plausible
// shape. An exporter that writes zeros, or writes the wrong voxel, passes every
// "file exists and parses" check ever written.
//
// One app for the file (the shared-session rule); the LAD run is the expensive
// part, so it happens once in beforeAll and every format exports from it.

const LEAFCUBE_LAD = 2.0;

let ctx: Awaited<ReturnType<typeof launchApp>>;
let outDir: string;

test.beforeAll(async () => {
  ctx = await launchApp();
  outDir = mkdtempSync(join(tmpdir(), 'phytograph-lad-export-'));
  const { app, page } = ctx;

  const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'lad-leafcube', 'leafcube.xml');
  await stubOpenDialog(app, xmlFixture);

  await page.getByTestId('tool-add-scan').click();
  const popup = page.getByTestId('scan-parameters-popup');
  await expect(popup).toBeVisible();
  await page.getByTestId('scan-import-xml').click();
  await expect(popup).not.toBeVisible({ timeout: 20_000 });
  await completeImportWizard(page);

  const scanRows = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
  await expect(scanRows).toHaveCount(1, { timeout: 20_000 });

  // A fresh voxel box is a 1 m cube at the origin; the leaf cube sits at
  // z in [0,1], so lift it to center z=0.5.
  await page.getByTestId('tool-create-voxel').click();
  const posZ = page.getByTestId('mesh-pos-z');
  await expect(posZ).toBeVisible();
  await posZ.fill('0.5');
  await posZ.press('Enter');

  // Refocus the scan (creating the box leaves a mixed selection). Click the row
  // NAME — the row's right side packs buttons that stop propagation.
  await scanRows.nth(0).getByTestId('scan-row-name').click();
  await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-compute-lad').click();
  await expect(page.getByTestId('lad-popup')).toBeVisible();
  // Same self-test parameters lad.spec.ts uses: Lmax 0.04 keeps long triangles
  // from bridging the hollow cube and inflating G(theta).
  await page.getByTestId('lad-input-lmax').fill('0.04');
  await page.getByTestId('lad-input-aspect').fill('10');
  await page.getByTestId('lad-input-min-hits').fill('1');
  await page.getByTestId('lad-compute-button').click();

  const ladRow = page.getByTestId('lad-row').first();
  await expect(ladRow).toBeVisible({ timeout: 120_000 });
  // Sanity-check the inversion before trusting anything the export writes.
  const ladMax = parseFloat((await ladRow.getAttribute('data-lad-max'))!);
  expect(ladMax).toBeGreaterThan(1.5);
  expect(ladMax).toBeLessThan(2.7);

  // Expand the row so the export controls mount.
  await ladRow.click();
  await expect(page.getByTestId('lad-export')).toBeVisible();
});

test.afterAll(async () => {
  await ctx?.close();
});

/**
 * Wait for a file to have real content. `fs.writeBinary` creates the file
 * before the bytes flush, so existsSync can be true while the read is empty —
 * poll on the content itself (the trap generate-dem.spec.ts documents).
 */
async function readWhenWritten(path: string): Promise<string> {
  let text = '';
  await expect.poll(
    () => { text = existsSync(path) ? readFileSync(path, 'utf-8') : ''; return text.length; },
    { timeout: 20_000 },
  ).toBeGreaterThan(0);
  return text;
}

/**
 * Minimal TIFF IFD reader — enough to check tags and pull float32 samples back
 * out. Deliberately dependency-free: the point is to verify the bytes the app
 * actually wrote, and pulling in a TIFF library to do it would just move the
 * question to whether that library agrees with ours.
 */
function readTiffTags(buf: Buffer): Map<number, number> {
  const le = buf[0] === 0x49;
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = u32(4);
  const count = u16(ifd);
  const tags = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    // Value (or its offset) always sits in the last 4 bytes of the entry.
    tags.set(u16(entry), u16(entry + 2) === 3 ? u16(entry + 8) : u32(entry + 8));
  }
  return tags;
}

function readTiffFloats(buf: Buffer, tags: Map<number, number>): number[] {
  const le = buf[0] === 0x49;
  const offset = tags.get(273)!;          // StripOffsets
  const bytes = tags.get(279)!;           // StripByteCounts
  const out: number[] = [];
  for (let o = offset; o + 4 <= offset + bytes; o += 4) {
    out.push(le ? buf.readFloatLE(o) : buf.readFloatBE(o));
  }
  return out;
}

test('exports the voxel CSV with the known LAD value and a solved flag', async () => {
  const { app, page } = ctx;
  const csvPath = join(outDir, 'leafcube.csv');
  await stubSaveDialog(app, csvPath);

  await page.getByTestId('lad-export-csv').click();
  await expect.poll(async () => (await getSaveDialogCalls(app)).length,
    { timeout: 15_000 }).toBeGreaterThan(0);

  const csv = await readWhenWritten(csvPath);
  const lines = csv.trim().split('\n');
  const header = lines[0].split(',');

  // The frozen column contract downstream parsers bind to.
  expect(header.slice(0, 6)).toEqual(['i', 'j', 'k', 'x', 'y', 'z']);
  expect(header).toContain('lad');
  expect(header).toContain('solved');

  const rows = lines.slice(1).map(l => Object.fromEntries(
    l.split(',').map((v, i) => [header[i], v])));
  expect(rows.length).toBeGreaterThan(0);

  // The leaf cube's real LAD reaches the file — not a zero, not a placeholder.
  const lads = rows
    .filter(r => r.solved === 'true' && r.lad !== '')
    .map(r => parseFloat(r.lad));
  expect(lads.length).toBeGreaterThan(0);
  expect(Math.max(...lads)).toBeGreaterThan(LEAFCUBE_LAD * 0.75);
  expect(Math.max(...lads)).toBeLessThan(LEAFCUBE_LAD * 1.35);

  // Every row is a real lattice index, and solved is a strict boolean — an
  // occluded voxel must never smuggle a 0 into the lad column.
  for (const r of rows) {
    expect(Number.isInteger(parseInt(r.i, 10))).toBe(true);
    expect(['true', 'false']).toContain(r.solved);
    if (r.solved === 'false') expect(r.lad).toBe('');
  }
});

test('exports a multi-band GeoTIFF with georeferencing tags', async () => {
  const { app, page } = ctx;
  const tifPath = join(outDir, 'leafcube.tif');
  await stubSaveDialog(app, tifPath);

  // One variable checked (lad, the default) => a single file => Save dialog.
  await page.getByTestId('lad-export-tif').click();
  await expect.poll(async () => (await getSaveDialogCalls(app)).length,
    { timeout: 15_000 }).toBeGreaterThan(0);

  let bytes = Buffer.alloc(0);
  await expect.poll(
    () => { bytes = existsSync(tifPath) ? readFileSync(tifPath) : Buffer.alloc(0); return bytes.length; },
    { timeout: 20_000 },
  ).toBeGreaterThan(0);

  // TIFF magic: little- or big-endian.
  const magic = bytes.subarray(0, 4);
  const isTiff = (magic[0] === 0x49 && magic[1] === 0x49 && magic[2] === 0x2a && magic[3] === 0x00)
    || (magic[0] === 0x4d && magic[1] === 0x4d && magic[2] === 0x00 && magic[3] === 0x2a);
  expect(isTiff, `not a TIFF: ${magic.toString('hex')}`).toBe(true);

  // Read the pixels back, so this asserts the exported VALUE and not merely that
  // a TIFF-shaped file appeared. The leaf cube is a 1x1x1 grid, so the raster is
  // one float32 sample that must carry its known LAD.
  const tags = readTiffTags(bytes);
  expect(tags.get(258), 'bits per sample').toBe(32);       // float32
  expect(tags.get(256), 'width').toBeGreaterThan(0);
  // Georeferencing: ModelPixelScale (33550) and ModelTiepoint (33922) present.
  expect(tags.has(33550), 'ModelPixelScale missing').toBe(true);
  expect(tags.has(33922), 'ModelTiepoint missing').toBe(true);

  const samples = readTiffFloats(bytes, tags);
  expect(samples.length).toBeGreaterThan(0);
  const real = samples.filter(v => v > -9000);              // drop NoData
  expect(real.length, 'every pixel was NoData').toBeGreaterThan(0);
  expect(Math.max(...real)).toBeGreaterThan(LEAFCUBE_LAD * 0.75);
  expect(Math.max(...real)).toBeLessThan(LEAFCUBE_LAD * 1.35);
});

test('exports AMAPVox .vox with a parseable voxel-space header', async () => {
  const { app, page } = ctx;
  const voxPath = join(outDir, 'leafcube.vox');
  await stubSaveDialog(app, voxPath);

  await page.getByTestId('lad-export-vox').click();
  await expect.poll(async () => (await getSaveDialogCalls(app)).length,
    { timeout: 15_000 }).toBeGreaterThan(0);

  const text = await readWhenWritten(voxPath);
  const lines = text.trim().split('\n');
  expect(lines[0]).toBe('VOXEL SPACE');

  const header = Object.fromEntries(
    lines.filter(l => l.startsWith('#'))
      .map(l => [l.slice(1, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
  expect(header.split).toBeDefined();
  expect(header.min_corner.split(/\s+/)).toHaveLength(3);
  expect(parseFloat(header.res)).toBeGreaterThan(0);

  const cols = lines.find(l => l.startsWith('i j k'))!.split(/\s+/);
  const padIdx = cols.indexOf('PadBVTotal');
  expect(padIdx).toBeGreaterThan(0);

  const data = lines.filter(l => l && !l.startsWith('#') && !l.startsWith('V') && !l.startsWith('i j k'));
  expect(data.length).toBeGreaterThan(0);
  const pads = data.map(l => parseFloat(l.split(/\s+/)[padIdx]));
  expect(Math.max(...pads)).toBeGreaterThan(LEAFCUBE_LAD * 0.75);
});

test('exports a plain-text summary carrying LAI and occlusion', async () => {
  const { app, page } = ctx;
  const txtPath = join(outDir, 'leafcube_summary.txt');
  await stubSaveDialog(app, txtPath);

  await page.getByTestId('lad-export-txt').click();
  await expect.poll(async () => (await getSaveDialogCalls(app)).length,
    { timeout: 15_000 }).toBeGreaterThan(0);

  const text = await readWhenWritten(txtPath);
  expect(text).toContain('grid size: 1 1 1');
  expect(text).toContain('number of occluded voxels');

  // The leaf cube is one 1x1x1 m voxel of LAD ~2.0 over 1 m^2 of ground, so LAI
  // (leaf area / ground area) must land near 2.0 too. A real number with a known
  // answer — not just "the line is present".
  const lai = parseFloat(text.split('\n').find(l => l.startsWith('LAI'))!.split(/\s+/)[1]);
  expect(lai).toBeGreaterThan(LEAFCUBE_LAD * 0.75);
  expect(lai).toBeLessThan(LEAFCUBE_LAD * 1.35);
});
