import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tent_normals.xyz');

// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).
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

// tent_normals.xyz is a synthetic "tent": two planar faces meeting along a
// ridge at x=0, each tilted exactly 30° from horizontal (3000 points).
//
// The fixture is chosen so the ANSWER is known analytically rather than merely
// self-consistent, which is what lets these assertions be about correctness
// instead of about not throwing:
//   * verticality is exactly 30° everywhere on both faces (measured p5..p95 =
//     30.00..30.00), so the colorbar's domain is a hard number;
//   * curvature is ~0 on the faces and non-zero only along the ridge (measured
//     ratio ~7e5), so a curvature colouring must show a real, non-degenerate
//     range;
//   * both faces slope the same way, so orientation='up' gives every normal a
//     positive Z and any sign error is visible.

test('computes normals and colours the cloud by curvature', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tent_normals"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(3000);
  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-compute-normals').click();
  const panel = page.getByTestId('compute-normals-panel');
  await expect(panel).toBeVisible();

  // A first run on a cloud with no normals offers "Compute", not "Recompute",
  // and shows no staleness advisory.
  const runButton = page.getByTestId('compute-normals-run-button');
  await expect(runButton).toContainText('Compute Normals');
  await expect(page.getByTestId('compute-normals-stale-warning')).toHaveCount(0);

  // Exercise a non-default option: 24 neighbours rather than the default 30.
  const neighbors = page.getByTestId('compute-normals-neighbors');
  await neighbors.fill('24');
  await neighbors.blur();
  await page.getByTestId('compute-normals-orientation').selectOption('up');

  await runButton.click();

  // The panel closes on success and the cloud is recoloured by curvature.
  await expect(panel).toHaveCount(0, { timeout: 120_000 });

  const colorbar = page.getByTestId('colorbar');
  await expect(colorbar).toBeVisible({ timeout: 60_000 });
  await expect(colorbar).toHaveAttribute('data-colorbar-label', 'Curvature');
  // A real, non-degenerate range — not the [0,1] default that would appear if
  // the colouring fell back to intensity.
  const cMin = parseFloat((await colorbar.getAttribute('data-colorbar-min')) ?? 'NaN');
  const cMax = parseFloat((await colorbar.getAttribute('data-colorbar-max')) ?? 'NaN');
  expect(Number.isFinite(cMin) && Number.isFinite(cMax)).toBe(true);
  expect(cMin).toBeGreaterThanOrEqual(0);
  expect(cMax).toBeGreaterThan(cMin);
  // Curvature is a surface-variation ratio λ0/Σλ, so it cannot exceed 1/3.
  expect(cMax).toBeLessThanOrEqual(0.34);
});

test('writes all five normal columns, and verticality carries the true 30° slope', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  await expect(page.locator('[data-testid="scan-row"][data-scan-name="tent_normals"]'))
    .toBeVisible({ timeout: 20_000 });

  await page.getByTestId('tool-compute-normals').click();
  await page.getByTestId('compute-normals-orientation').selectOption('up');
  await page.getByTestId('compute-normals-run-button').click();
  await expect(page.getByTestId('compute-normals-panel')).toHaveCount(0, { timeout: 120_000 });

  // All five columns must reach the renderer as selectable scalar fields —
  // proving they survived the octree rebuild, not merely the backend.
  await page.getByRole('button', { name: 'Display' }).click();
  const colorMode = page.getByTestId('display-color-mode');
  await expect(colorMode).toBeVisible();
  const optionValues = await colorMode
    .locator('optgroup[label="Scalar fields"] option')
    .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
  for (const slug of ['nx', 'ny', 'nz', 'curvature', 'verticality']) {
    expect(optionValues).toContain(`scalar:${slug}`);
  }

  // Verticality is the load-bearing number: both faces are tilted exactly 30°,
  // so the colorbar's upper bound must land on 30, not on a plausible-looking
  // arbitrary value. This is the assertion that would catch a wrong axis
  // convention, a radians/degrees slip, or a fold applied to the wrong term.
  await colorMode.selectOption('scalar:verticality');
  const colorbar = page.getByTestId('colorbar');
  await expect(colorbar).toHaveAttribute('data-colorbar-label', 'Verticality');
  const vMax = parseFloat((await colorbar.getAttribute('data-colorbar-max')) ?? 'NaN');
  expect(vMax).toBeGreaterThan(29.0);
  expect(vMax).toBeLessThan(31.0);

  // With orientation='up' every normal faces up, so nz spans a narrow positive
  // band (cos 30° ≈ 0.866) and never goes negative.
  await colorMode.selectOption('scalar:nz');
  const nzMin = parseFloat((await colorbar.getAttribute('data-colorbar-min')) ?? 'NaN');
  expect(nzMin).toBeGreaterThan(0);
});

test('warns that normals are out of date after the cloud is edited', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tent_normals"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('tool-compute-normals').click();
  await page.getByTestId('compute-normals-run-button').click();
  await expect(page.getByTestId('compute-normals-panel')).toHaveCount(0, { timeout: 120_000 });

  // Reopening straight away: normals exist and are current, so the button
  // offers a recompute but nothing warns.
  await page.getByTestId('tool-compute-normals').click();
  await expect(page.getByTestId('compute-normals-run-button')).toContainText('Recompute', { timeout: 20_000 });
  await expect(page.getByTestId('compute-normals-stale-warning')).toHaveCount(0);
  await page.getByTestId('tool-compute-normals').click();   // close

  // Delete part of the cloud. A normal is a neighbourhood statistic, so the cut
  // changes the right answer for every surviving point beside it.
  await page.getByTestId('tool-crop').click();
  const cropPanel = page.getByTestId('crop-panel');
  await expect(cropPanel).toBeVisible({ timeout: 20_000 });

  async function setNumber(testId: string, value: number) {
    const input = page.getByTestId(testId);
    await input.click();
    await input.fill(String(value));
    await input.press('Tab');
  }
  // Keep a slab around the ridge: the tent spans x ∈ [-2, 2], so this drops
  // roughly the outer half of both faces.
  await setNumber('crop-dim-x', 2.0);
  await setNumber('crop-center-x', 0);
  await setNumber('crop-dim-y', 10.0);
  await setNumber('crop-center-y', 0);
  await setNumber('crop-dim-z', 10.0);
  await setNumber('crop-center-z', 0);

  await page.getByTestId('crop-apply').click();
  await expect(cropPanel).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 60_000 });
  // The crop must actually have removed points, or there is nothing to go stale.
  await expect(cloudRow).not.toHaveAttribute('data-point-count', '3000', { timeout: 30_000 });

  // Now the panel must say so — and must NOT have thrown the columns away.
  await page.getByTestId('tool-compute-normals').click();
  await expect(page.getByTestId('compute-normals-stale-warning')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('compute-normals-run-button')).toContainText('Recompute');
});
