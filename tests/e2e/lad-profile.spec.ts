import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubSaveDialog, getSaveDialogCalls } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';

// The vertical LAD profile and the bulk LAI, end to end through the real UI
// against the live backend.
//
// The fixture is the leaf cube lad.spec.ts and lad-export.spec.ts use: a
// synthetic scan of a spherical-leaf cube occupying z in [0,1] over 1 m^2 of
// ground, whose true LAD is 2.0 m^2/m^3 and whose true LAI is therefore also
// ~2.0. Having a known answer is the point — a profile window that renders a
// plausible-looking chart of the wrong numbers passes every "the popup opened"
// check ever written.
//
// The grid here is deliberately subdivided 1x1x4 rather than the single cell
// lad-export.spec.ts uses: a one-level grid has no profile to test, and cannot
// distinguish a profile that bins voxels correctly from one that dumps them all
// into level 0.
//
// One app for the file (the shared-session rule) — the LAD run is the expensive
// part, so it happens once in beforeAll and every test reads that one result.

const LEAFCUBE_LAD = 2.0;
const NZ = 4;

let ctx: Awaited<ReturnType<typeof launchApp>>;
let outDir: string;

// Commit a DebouncedNumberInput explicitly rather than relying on its 400 ms
// idle timer (the pattern voxel-grid-reframe.spec.ts uses).
async function setField(page: Page, testId: string, value: string) {
  const input = page.getByTestId(testId);
  await input.click();
  await input.selectText();
  await input.fill(value);
  await input.press('Enter');
}

test.beforeAll(async () => {
  ctx = await launchApp();
  outDir = mkdtempSync(join(tmpdir(), 'phytograph-lad-profile-'));
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
  // z in [0,1], so lift it to center z=0.5. Then split it into NZ vertical
  // levels so there is a real profile to read.
  await page.getByTestId('tool-create-voxel').click();
  await expect(page.getByTestId('mesh-pos-z')).toBeVisible();
  await setField(page, 'mesh-pos-z', '0.5');
  await setField(page, 'voxel-grid-x', '1');
  await setField(page, 'voxel-grid-y', '1');
  await setField(page, 'voxel-grid-z', String(NZ));

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
  // The grid really was subdivided — otherwise every profile assertion below
  // would be testing a one-level grid and quietly proving nothing.
  await expect(ladRow.getByTestId('lad-row-name')).toHaveText(`LAD 1×1×${NZ}`);

  // Expand the row so its controls mount.
  await ladRow.click();
  await expect(page.getByTestId('lad-show-profile')).toBeVisible();
});

test.afterAll(async () => {
  await ctx?.close();
});

/** Open the profile window, if it isn't already open. */
async function openProfile(page: Page) {
  const popup = page.getByTestId('lad-profile-popup');
  if (!(await popup.isVisible())) {
    await page.getByTestId('lad-show-profile').click();
    await expect(popup).toBeVisible();
  }
  return popup;
}

/**
 * Wait for a file to have real content. `fs.writeText` creates the file before
 * the bytes flush, so existsSync can be true while the read is empty — poll on
 * the content itself.
 */
async function readWhenWritten(path: string): Promise<string> {
  let text = '';
  await expect.poll(
    () => { text = existsSync(path) ? readFileSync(path, 'utf-8') : ''; return text.length; },
    { timeout: 20_000 },
  ).toBeGreaterThan(0);
  return text;
}

test('reports a bulk LAI matching the leaf cube it measured', async () => {
  const { page } = ctx;
  await openProfile(page);

  const lai = parseFloat((await page.getByTestId('lad-bulk-lai').getAttribute('data-lai'))!);
  // The cube is 1 m of canopy at LAD ~2.0 over 1 m^2 of ground, so LAI ~2.0.
  // Same band lad-export.spec.ts holds the exported summary to, because it has
  // to be the same number.
  expect(lai).toBeGreaterThan(LEAFCUBE_LAD * 0.75);
  expect(lai).toBeLessThan(LEAFCUBE_LAD * 1.35);

  // LAI = leaf area / footprint, and the footprint is the 1 m^2 grid — assert
  // the identity rather than trusting one displayed number in isolation.
  const leafArea = parseFloat(
    (await page.getByTestId('lad-bulk-lai').getAttribute('data-leaf-area'))!);
  const ground = parseFloat(
    (await page.getByTestId('lad-bulk-lai').getAttribute('data-ground-area'))!);
  expect(ground).toBeCloseTo(1.0, 3);
  expect(leafArea / ground).toBeCloseTo(lai, 6);

  // And it is on screen, not just in an attribute.
  await expect(page.getByTestId('lad-bulk-lai'))
    .toContainText(`LAI ${lai.toFixed(3)}`);
});

test('profiles one row per vertical level, with the leaf area in the canopy levels', async () => {
  const { page } = ctx;
  await openProfile(page);

  const rows = page.getByTestId('lad-profile-row');
  await expect(rows).toHaveCount(NZ);

  // Read every level's mean LAD, ordered by level (the table renders highest
  // first, so sort rather than assume the DOM order).
  const levels: { level: number; lad: number; measured: number }[] = [];
  for (let i = 0; i < NZ; i++) {
    const row = rows.nth(i);
    levels.push({
      level: parseInt((await row.getAttribute('data-level'))!, 10),
      lad: parseFloat((await row.getAttribute('data-mean-lad'))!),
      measured: parseInt((await row.getAttribute('data-measured'))!, 10),
    });
  }
  levels.sort((a, b) => a.level - b.level);
  expect(levels.map(l => l.level)).toEqual([0, 1, 2, 3]);

  // The cube fills the whole grid, so every level holds foliage — a profile
  // that dumped all voxels into level 0 would leave three levels at zero.
  for (const l of levels) {
    expect(l.measured).toBeGreaterThan(0);
    expect(l.lad).toBeGreaterThan(LEAFCUBE_LAD * 0.4);
    expect(l.lad).toBeLessThan(LEAFCUBE_LAD * 2.5);
  }

  // The cube is a uniform canopy, so the profile should be roughly flat: the
  // spread across levels must be small relative to the mean. This is what
  // distinguishes a correct per-level inversion from one that, say, credited
  // the whole cube's leaf area to a single slab.
  const mean = levels.reduce((a, l) => a + l.lad, 0) / levels.length;
  for (const l of levels) {
    expect(Math.abs(l.lad - mean) / mean).toBeLessThan(0.75);
  }
});

test('the displayed LAI equals the LAI the summary export writes', async () => {
  // The whole reason the LAI definition is a written-down contract
  // (src/shared/ladLai.contract.json): the viewer computes LAI in TypeScript,
  // the export writes it from Python, and an app that shows one number while
  // exporting another raises no error at all — the user just has two figures
  // and no way to know which to quote.
  const { app, page } = ctx;

  await openProfile(page);
  const shown = parseFloat(
    (await page.getByTestId('lad-bulk-lai').getAttribute('data-lai'))!);
  await page.getByTestId('lad-profile-close').click();
  await expect(page.getByTestId('lad-profile-popup')).not.toBeVisible();

  const txtPath = join(outDir, 'summary.txt');
  await stubSaveDialog(app, txtPath);
  await page.getByTestId('lad-export-txt').click();
  await expect.poll(async () => (await getSaveDialogCalls(app)).length,
    { timeout: 15_000 }).toBeGreaterThan(0);

  const text = await readWhenWritten(txtPath);
  const exported = parseFloat(
    text.split('\n').find(l => l.startsWith('LAI'))!.split(/\s+/)[1]);

  // The summary prints LAI to 3 dp, so that rounding is the only tolerance.
  expect(exported).toBeCloseTo(shown, 3);
});

test('exports a profile CSV whose per-level LAI contributions sum to the bulk LAI', async () => {
  const { app, page } = ctx;
  await openProfile(page);

  const shownLai = parseFloat(
    (await page.getByTestId('lad-bulk-lai').getAttribute('data-lai'))!);

  const csvPath = join(outDir, 'profile.csv');
  await stubSaveDialog(app, csvPath);
  await page.getByTestId('lad-profile-export-csv').click();
  await expect.poll(async () => (await getSaveDialogCalls(app)).length,
    { timeout: 15_000 }).toBeGreaterThan(0);

  const csv = await readWhenWritten(csvPath);
  const lines = csv.trim().split('\n');
  const header = lines[0].split(',');
  const iLevel = header.indexOf('level');
  const iLad = header.indexOf('mean_lad_m2_m3');
  const iContrib = header.indexOf('lai_contribution');
  expect(iLevel).toBe(0);
  expect(iLad).toBeGreaterThan(0);
  expect(iContrib).toBeGreaterThan(0);

  // One data row per level, then the commented bulk figures.
  const dataRows = lines.slice(1, 1 + NZ).map(l => l.split(','));
  expect(dataRows.map(r => r[iLevel])).toEqual(['0', '1', '2', '3']);

  // The identity that makes the plot and the headline the same measurement.
  const summed = dataRows.reduce((a, r) => a + parseFloat(r[iContrib]), 0);
  expect(summed).toBeCloseTo(shownLai, 5);

  // The file's own bulk-LAI line agrees with what the window showed.
  const laiLine = lines.find(l => l.startsWith('# bulk LAI'))!;
  expect(parseFloat(laiLine.split(',')[1])).toBeCloseTo(shownLai, 5);

  // And the per-level densities in the file are the ones the table showed.
  const rowLads = dataRows.map(r => parseFloat(r[iLad]));
  for (const lad of rowLads) {
    expect(lad).toBeGreaterThan(LEAFCUBE_LAD * 0.4);
  }
});

test('the spread band is opt-in and does not disturb the profile', async () => {
  const { page } = ctx;
  await openProfile(page);

  const spread = page.getByTestId('lad-profile-spread');
  await expect(spread).not.toBeChecked();

  const before = await page.getByTestId('lad-profile-row').first()
    .getAttribute('data-mean-lad');
  await spread.check();
  await expect(spread).toBeChecked();
  // Toggling a display option must not change the measurement it displays.
  expect(await page.getByTestId('lad-profile-row').first()
    .getAttribute('data-mean-lad')).toBe(before);
  await expect(page.getByTestId('lad-profile-chart')).toBeVisible();

  await spread.uncheck();
});

test('closes without disturbing the result, and reopens', async () => {
  const { page } = ctx;
  await openProfile(page);
  await page.getByTestId('lad-profile-close').click();
  await expect(page.getByTestId('lad-profile-popup')).not.toBeVisible();

  // The LAD result itself survives — the window reads it, never mutates it.
  await expect(page.getByTestId('lad-row').first()).toBeVisible();
  await page.getByTestId('lad-show-profile').click();
  await expect(page.getByTestId('lad-profile-popup')).toBeVisible();
  await expect(page.getByTestId('lad-profile-row')).toHaveCount(NZ);
  await page.getByTestId('lad-profile-close').click();
});

test('excludes occluded voxels from the LAI, and still agrees with the export', async () => {
  // Declared LAST on purpose: it computes a SECOND LAD result and leaves it in
  // the scene, which would shift `lad-row.first()` under every test above.
  // Playwright runs a file's tests in declaration order, so position is the
  // guarantee here.
  //
  // The leaf cube is well probed from every side, so the default screening
  // flags nothing — which means the tests above cannot tell an implementation
  // that excludes occluded voxels from one that counts them. Forcing an absurd
  // occlusion threshold makes the screen fire on real voxels, and that is the
  // condition under which the displayed and exported LAI could actually
  // diverge: they compute the same exclusion rule in two languages.
  const { app, page } = ctx;

  const scanRows = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
  await scanRows.nth(0).getByTestId('scan-row-name').click();
  await page.getByTestId('tool-compute-lad').click();
  await expect(page.getByTestId('lad-popup')).toBeVisible();
  // The first run left a triangulation behind, so this run defaults to reusing
  // it — and in reuse mode the Lmax/aspect inputs are absent, because no new
  // triangulation is built. That is what we want here: reusing the same mesh
  // holds G(theta) fixed, so the occlusion threshold below is the ONLY thing
  // that differs between the two results.
  await expect(page.getByTestId('lad-triangulation-select'))
    .toHaveValue(/.+/);
  await page.getByTestId('lad-input-min-hits').fill('1');
  // Far more beam path than any voxel of this small cube receives, so the
  // screen flags voxels that genuinely carry leaf area.
  await page.getByTestId('lad-input-occlusion-threshold').fill('10000');
  await page.getByTestId('lad-compute-button').click();

  // A new result is APPENDED to the list, so the screened one is last — not
  // `.first()`, which is still the well-probed result the tests above read.
  await expect(page.getByTestId('lad-row')).toHaveCount(2, { timeout: 120_000 });
  const newRow = page.getByTestId('lad-row').last();
  await newRow.click();
  await expect(newRow).toHaveAttribute('data-selected', 'true');

  // The screen really did fire — otherwise this test proves nothing.
  const occlusion = page.getByTestId('lad-occlusion-summary');
  await expect(occlusion).toBeVisible();
  const underSampled = parseInt(
    (await occlusion.getAttribute('data-under-sampled'))!, 10);
  expect(underSampled).toBeGreaterThan(0);

  await page.getByTestId('lad-show-profile').click();
  await expect(page.getByTestId('lad-profile-popup')).toBeVisible();
  const shown = parseFloat(
    (await page.getByTestId('lad-bulk-lai').getAttribute('data-lai'))!);

  // With every well-probed voxel screened out, the measured leaf area collapses
  // and LAI falls far below the cube's true ~2.0. That is the correct, honest
  // answer for a grid this screening rejected — and counting the occluded
  // voxels anyway would put it back near 2.0, which is the bug.
  expect(shown).toBeLessThan(LEAFCUBE_LAD * 0.5);
  await expect(page.getByTestId('lad-bulk-lai'))
    .toContainText(/voxels were occluded and\s+are excluded/);

  await page.getByTestId('lad-profile-close').click();
  await expect(page.getByTestId('lad-profile-popup')).not.toBeVisible();

  const txtPath = join(outDir, 'summary-occluded.txt');
  await stubSaveDialog(app, txtPath);
  await page.getByTestId('lad-export-txt').click();
  await expect.poll(async () => (await getSaveDialogCalls(app)).length,
    { timeout: 15_000 }).toBeGreaterThan(0);

  const text = await readWhenWritten(txtPath);
  const exported = parseFloat(
    text.split('\n').find(l => l.startsWith('LAI'))!.split(/\s+/)[1]);
  // The two languages must agree on the SCREENED total, not just the easy one.
  expect(exported).toBeCloseTo(shown, 3);
});
