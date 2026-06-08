import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// Drives the QSM build workflow end-to-end against the LIVE backend (no mocks):
// import a cloud -> Build QSM -> assert on the rendered results. The fixture is
// the same Y-shaped synthetic plant (stem + two branches, 900 points) the
// skeleton test uses; verified directly that the QSM pipeline produces a clean
// 1-trunk + 2-scaffold model on it, so we can assert concrete structure (a
// rank-0 trunk shoot, >=1 rank-1 shoot, plausible radii) rather than "no error".
test('builds a QSM with shoot ranks from a plant cloud via the UI', async () => {
  const { page, close } = await launchApp();

  try {
    // Import as point cloud (intercept the OS file chooser).
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-pointcloud').click(),
    ]);
    await chooser.setFiles(FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-point-count', '900');
    // Freshly imported scan is auto-selected.
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Open the QSM build panel and run the build.
    await page.getByTestId('tool-qsm').click();
    await expect(page.getByTestId('qsm-panel')).toBeVisible();
    await page.getByTestId('qsm-build-button').click();

    // A QSM row appears in the results panel within ~60s.
    const qsmRow = page.getByTestId('qsm-row').first();
    await expect(qsmRow).toBeVisible({ timeout: 60_000 });

    // --- Concrete structural assertions read off the rendered DOM ---
    const cylCount = parseInt((await qsmRow.getAttribute('data-cylinder-count'))!, 10);
    const shootCount = parseInt((await qsmRow.getAttribute('data-shoot-count'))!, 10);
    const trunkCount = parseInt((await qsmRow.getAttribute('data-trunk-count'))!, 10);
    const scaffoldCount = parseInt((await qsmRow.getAttribute('data-scaffold-count'))!, 10);
    const minRadius = parseFloat((await qsmRow.getAttribute('data-min-radius'))!);
    const maxRadius = parseFloat((await qsmRow.getAttribute('data-max-radius'))!);

    // Cylinders were produced.
    expect(cylCount).toBeGreaterThan(10);
    expect(cylCount).toBeLessThan(900);
    // The headline: exactly one rank-0 (trunk) shoot, and at least one scaffold.
    expect(trunkCount).toBe(1);
    expect(scaffoldCount).toBeGreaterThanOrEqual(1);
    expect(shootCount).toBeGreaterThanOrEqual(trunkCount + scaffoldCount);
    // Radii are physically plausible (sub-millimeter to ~decimeter), and the
    // trunk is fatter than the thinnest twig (a real fitted+tapered model).
    expect(minRadius).toBeGreaterThan(0.0003);
    expect(maxRadius).toBeLessThan(0.2);
    expect(maxRadius).toBeGreaterThan(minRadius);

    // A trunk shoot row is present and labelled.
    const trunkShoot = page.locator('[data-testid="qsm-shoot-row"][data-rank="0"]').first();
    await expect(trunkShoot).toBeVisible();
    await expect(trunkShoot).toContainText('Trunk');

    // Metrics block rendered with the trunk diameter.
    await expect(qsmRow.getByTestId('qsm-metrics')).toContainText('mm');

    // The color-mode control works (switch to per-shoot coloring).
    await page.getByTestId('qsm-color-mode').selectOption('shoot');
    await expect(page.getByTestId('qsm-color-mode')).toHaveValue('shoot');

    // Selecting a shoot highlights it (the row gains the selected style); just
    // assert the click is accepted and the row stays present.
    await trunkShoot.click();
    await expect(trunkShoot).toBeVisible();

    // --- Deleting the source scan must NOT bring back the import overlay ---
    // The QSM outlives its source scan; with the scan gone the scene is still
    // non-empty, so the empty-viewer hint must stay hidden.
    await expect(page.getByTestId('empty-viewer-hint')).toHaveCount(0);
    const scanId = await cloudRow.getAttribute('data-scan-id');
    await page.getByTestId(`scan-delete-${scanId}`).click();
    await expect(page.getByText('Delete cloud?', { exact: true })).toBeVisible();
    await page.getByTestId('confirm-delete').click();
    // Scan row gone, QSM row remains, and the import overlay does NOT appear.
    await expect(cloudRow).toHaveCount(0);
    await expect(page.getByTestId('qsm-row')).toHaveCount(1);
    await expect(page.getByTestId('empty-viewer-hint')).toHaveCount(0);

    // --- Delete requires confirmation (like scans/meshes/skeletons) ---
    // Click the QSM's delete (trash) button: a confirmation dialog must appear
    // rather than deleting immediately.
    await page.getByTestId(/^qsm-delete-/).first().click();
    const dialog = page.getByText('Delete QSM?', { exact: true });
    await expect(dialog).toBeVisible();
    // Cancel keeps the QSM.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('qsm-row')).toHaveCount(1);

    // Re-open the dialog and confirm: the QSM row is removed.
    await page.getByTestId(/^qsm-delete-/).first().click();
    await expect(page.getByText('Delete QSM?', { exact: true })).toBeVisible();
    await page.getByTestId('confirm-delete').click();
    await expect(page.getByTestId('qsm-row')).toHaveCount(0);
  } finally {
    await close();
  }
});
