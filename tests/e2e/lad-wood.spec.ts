import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// The leaf/wood split of the LAD inversion, end to end through the real UI
// against the live backend.
//
// The fixture is a synthetic scan of a 1 m box holding BOTH randomly-oriented
// leaf patches AND vertical wooden tubes, with an exact `wood_class` column
// derived from the known tube geometry (see
// backend-api/tests/fixtures/generate_lad_woodcube.py). Using a cloud that
// ALREADY carries the classification is deliberate: this spec is about the
// INVERSION's split, and routing through the wood segmenter first would put a
// classifier's accuracy between the fixture and the assertions — so a change in
// segmentation would move numbers this spec attributes to LAD.
//
// Known truth in the file: leaf 2.2500 m^2 one-sided, wood 0.7787 m^2 surface.
// The recovered densities are NOT asserted against those, because this fixture
// is deliberately the segregated stress case (all wood in solid tubes); what is
// asserted is that the split HAPPENED, is self-consistent, and reaches every
// surface the user reads it from.
//
// One app for the file (the shared-session rule): the LAD run is the expensive
// part, so it happens once in beforeAll.

let ctx: Awaited<ReturnType<typeof launchApp>>;

async function setField(page: Page, testId: string, value: string) {
  const input = page.getByTestId(testId);
  await input.click();
  await input.selectText();
  await input.fill(value);
  await input.press('Enter');
}

test.beforeAll(async () => {
  ctx = await launchApp();
  const { app, page } = ctx;

  const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'lad-woodcube', 'woodcube.xml');
  await stubOpenDialog(app, xmlFixture);

  await page.getByTestId('tool-add-scan').click();
  const popup = page.getByTestId('scan-parameters-popup');
  await expect(popup).toBeVisible();
  await page.getByTestId('scan-import-xml').click();
  await expect(popup).not.toBeVisible({ timeout: 20_000 });
  await completeImportWizard(page);

  const scanRows = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
  await expect(scanRows).toHaveCount(1, { timeout: 20_000 });

  // The box spans z in [0,1], so lift the default voxel box to center z=0.5.
  await page.getByTestId('tool-create-voxel').click();
  await expect(page.getByTestId('mesh-pos-z')).toBeVisible();
  await setField(page, 'mesh-pos-z', '0.5');
  await setField(page, 'voxel-grid-x', '1');
  await setField(page, 'voxel-grid-y', '1');
  await setField(page, 'voxel-grid-z', '1');

  await scanRows.nth(0).getByTestId('scan-row-name').click();
  await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-compute-lad').click();
  await expect(page.getByTestId('lad-popup')).toBeVisible();
  await page.getByTestId('lad-input-lmax').fill('0.06');
  await page.getByTestId('lad-input-aspect').fill('10');
  await page.getByTestId('lad-input-min-hits').fill('1');
  await page.getByTestId('lad-compute-button').click();

  const ladRow = page.getByTestId('lad-row').first();
  await expect(ladRow).toBeVisible({ timeout: 180_000 });
  await ladRow.click();
});

test.afterAll(async () => {
  await ctx?.close();
});

test('reports leaf and wood area, and says how G(theta) was obtained', async () => {
  const { page } = ctx;
  const summary = page.getByTestId('lad-wood-summary');
  await expect(summary).toBeVisible();

  // The split must be REPORTED as measured or assumed — never silently assumed.
  const source = await summary.getAttribute('data-wood-gtheta-source');
  expect(['pooled', 'default']).toContain(source);

  // Both media present, stated in m^2. A split that collapsed to leaf-only
  // would render this box with a wood total of 0 and fail here.
  const text = (await summary.textContent()) ?? '';
  expect(text).toMatch(/Wood\s+[\d.]+\s*m²/);
  expect(text).toMatch(/Leaf\s+[\d.]+\s*m²/);
  const wood = parseFloat(text.match(/Wood\s+([\d.]+)\s*m²/)![1]);
  const leaf = parseFloat(text.match(/Leaf\s+([\d.]+)\s*m²/)![1]);
  expect(wood).toBeGreaterThan(0);
  expect(leaf).toBeGreaterThan(0);
  // Wood is the minority component in this fixture (true ratio 0.35).
  expect(wood).toBeLessThan(leaf);
});

test('the profile window reports WAI and PAI, and PAI = LAI + WAI', async () => {
  const { page } = ctx;
  await page.getByTestId('lad-show-profile').click();
  const popup = page.getByTestId('lad-profile-popup');
  await expect(popup).toBeVisible();

  const bulk = page.getByTestId('lad-bulk-lai');
  const lai = parseFloat((await bulk.getAttribute('data-lai'))!);
  const wai = parseFloat((await bulk.getAttribute('data-wai'))!);
  const pai = parseFloat((await bulk.getAttribute('data-pai'))!);

  expect(lai).toBeGreaterThan(0);
  expect(wai).toBeGreaterThan(0);
  // The identity the two conventions exist to preserve. If leaf were reported
  // two-sided, or wood as a silhouette, this would not close.
  expect(pai).toBeCloseTo(lai + wai, 5);
  await expect(popup).toContainText('WAI');
  await expect(popup).toContainText('PAI');

  await page.keyboard.press('Escape');
});

test('the voxels can be coloured by wood, and the legend follows', async () => {
  const { page } = ctx;
  const picker = page.getByTestId('lad-display-field');
  await expect(picker).toBeVisible();

  // Default is leaf — the pre-wood behaviour, so an existing user sees no change.
  await expect(picker).toHaveValue('lad');
  const legend = page.getByTestId('lad-colorbar');
  await expect(legend).toHaveAttribute('data-colorbar-label', 'LAD [m²/m³]');

  // Switching must relabel the colorbar AND rescale it: a bar reading "LAD"
  // over a wood ramp is a wrong label on a real number, and a bar keeping the
  // leaf domain would misstate every wood value under it.
  const leafMax = parseFloat((await legend.getAttribute('data-colorbar-max'))!);
  expect(leafMax).toBeGreaterThan(0);

  await picker.selectOption('wad');
  await expect(legend).toHaveAttribute('data-colorbar-label', 'WAD [m²/m³]');
  // The domain must follow the field. Wood density here is well below leaf, so
  // a colorbar still carrying the leaf maximum would wash the wood ramp out.
  await expect.poll(async () =>
    parseFloat((await legend.getAttribute('data-colorbar-max'))!),
  ).toBeLessThan(leafMax);

  await picker.selectOption('pad');
  await expect(legend).toHaveAttribute('data-colorbar-label', 'PAD [m²/m³]');

  await picker.selectOption('lad');
  await expect(legend).toHaveAttribute('data-colorbar-label', 'LAD [m²/m³]');
});

test('wood variables are offered for export only because this result has them', async () => {
  const { page } = ctx;
  await expect(page.getByTestId('lad-export-var-wad')).toBeVisible();
  await expect(page.getByTestId('lad-export-var-pad')).toBeVisible();
  await expect(page.getByTestId('lad-export-var-wood_fraction')).toBeVisible();
  // The leaf variables are still there — the wood set extends, never replaces.
  await expect(page.getByTestId('lad-export-var-lad')).toBeVisible();
});
