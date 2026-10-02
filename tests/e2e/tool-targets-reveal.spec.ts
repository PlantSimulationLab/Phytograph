import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// A hidden object checked in a tool's picker is shown while it is checked.
//
// Crop, Erase, Filter and Transformation act on their picker's CHECKBOXES,
// visible or not, while their previews are drawn only on what is visible. So a
// hidden checked object used to be edited blind: the tool appeared to do
// nothing to the visible object beside it while one the user could not see was
// being cut. Checking a hidden scan or mesh now shows it; unchecking it, or
// closing the tool, hides it again. An object that was already visible is
// never touched.
//
// Fixtures: tiny.xyz (60 points) and strip-mesh.ply (20 triangles).
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).
const STRIP = join(repoRoot, 'tests', 'e2e', 'fixtures', 'strip-mesh.ply');
const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

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

const meshRow = () => session.page.locator('[data-testid="mesh-row"][data-mesh-name="strip-mesh"]');
const scanRow = () => session.page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');

/** Import the scan and the mesh, and hide both from their panes. */
async function importHidden() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);
  await expect(scanRow()).toHaveAttribute('data-point-count', '60', { timeout: 20_000 });
  await importFiles(app, page, 'import-auto', STRIP);
  await expect(meshRow()).toHaveAttribute('data-triangle-count', '20', { timeout: 30_000 });
  await meshRow().getByTitle('Hide', { exact: true }).click();
  await expect(meshRow()).toHaveAttribute('data-visible', 'false');
  await scanRow().getByTitle('Hide', { exact: true }).click();
  await expect(scanRow()).toHaveAttribute('data-visible', 'false');
}

async function expectUntouched() {
  await expect(meshRow()).toHaveAttribute('data-visible', 'false');
  await expect(scanRow()).toHaveAttribute('data-visible', 'false');
  await expect(meshRow()).toHaveAttribute('data-triangle-count', '20');
  await expect(scanRow()).toHaveAttribute('data-point-count', '60');
}

test('crop: checking a hidden mesh or scan shows it until it is unchecked or the panel closes', async () => {
  const { page } = session;
  await importHidden();
  await page.getByTestId('tool-crop').click();
  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();
  const meshBox = panel.locator('[data-testid="crop-mesh-target-row"][data-label="strip-mesh"]').locator('input');
  const scanBox = panel.locator('[data-testid="crop-target-row"][data-label="tiny"]').locator('input');
  // Freshly imported objects may open checked — start from a known state.
  // Unchecked and hidden stays hidden.
  await meshBox.uncheck();
  await scanBox.uncheck();
  await expect(meshRow()).toHaveAttribute('data-visible', 'false');
  await expect(scanRow()).toHaveAttribute('data-visible', 'false');

  await meshBox.check();
  await expect(meshRow()).toHaveAttribute('data-visible', 'true');
  await expect(scanRow()).toHaveAttribute('data-visible', 'false');
  await scanBox.check();
  await expect(scanRow()).toHaveAttribute('data-visible', 'true');
  // Now that the mesh is drawn, the region previews on it: refit to the
  // checked objects, the box holds every triangle.
  await panel.getByRole('button', { name: 'Reset Crop Box' }).click();
  await expect(panel).toHaveAttribute('data-mesh-preview-kept', '20');

  // Unchecking hides it again, and leaves the other one alone...
  await meshBox.uncheck();
  await expect(meshRow()).toHaveAttribute('data-visible', 'false');
  await expect(scanRow()).toHaveAttribute('data-visible', 'true');
  // ...and so does closing the panel, without cropping anything.
  await meshBox.check();
  await expect(meshRow()).toHaveAttribute('data-visible', 'true');
  await page.getByTestId('crop-close').click();
  await expect(panel).toHaveCount(0);
  await expectUntouched();
});

test('transformation: a checked hidden scan and mesh are shown, then hidden on close', async () => {
  const { page } = session;
  await importHidden();
  await page.getByTestId('tool-cloud-translate').click();
  const panel = page.getByTestId('translate-panel');
  await expect(panel).toBeVisible();
  const meshBox = panel.locator('[data-testid="transform-target-row"][data-label="strip-mesh"]').locator('input');
  const scanBox = panel.locator('[data-testid="transform-target-row"][data-label="tiny"]').locator('input');
  await meshBox.uncheck();
  await scanBox.uncheck();
  await expect(meshRow()).toHaveAttribute('data-visible', 'false');
  await expect(scanRow()).toHaveAttribute('data-visible', 'false');

  await meshBox.check();
  await expect(meshRow()).toHaveAttribute('data-visible', 'true');
  await expect(scanRow()).toHaveAttribute('data-visible', 'false');
  await scanBox.check();
  await expect(scanRow()).toHaveAttribute('data-visible', 'true');
  await scanBox.uncheck();
  await expect(scanRow()).toHaveAttribute('data-visible', 'false');
  await expect(meshRow()).toHaveAttribute('data-visible', 'true');

  // Nothing was moved, so the panel closes without a confirm.
  await page.getByTestId('translate-close').click();
  await expect(panel).toHaveCount(0);
  await expectUntouched();
});

test('erase: a checked hidden scan is shown, then hidden on close', async () => {
  const { page } = session;
  await importHidden();
  await page.getByTestId('tool-erase').click();
  const panel = page.getByTestId('erase-panel');
  await expect(panel).toBeVisible();
  const scanBox = panel.locator('[data-testid="erase-target-row"][data-label="tiny"]').locator('input');
  await scanBox.uncheck();
  await expect(scanRow()).toHaveAttribute('data-visible', 'false');
  await scanBox.check();
  await expect(scanRow()).toHaveAttribute('data-visible', 'true');
  await scanBox.uncheck();
  await expect(scanRow()).toHaveAttribute('data-visible', 'false');
  await scanBox.check();
  await expect(scanRow()).toHaveAttribute('data-visible', 'true');
  // The toolbar button toggles the tool closed.
  await page.getByTestId('tool-erase').click();
  await expect(panel).toHaveCount(0);
  await expectUntouched();
});

test('filter: a checked hidden scan is shown, then hidden on close', async () => {
  const { page } = session;
  await importHidden();
  await page.getByTestId('tool-filter').click();
  const panel = page.getByTestId('filter-panel');
  await expect(panel).toBeVisible();
  const scanBox = panel.locator('[data-testid="filter-target-row"][data-label="tiny"]').locator('input');
  await scanBox.uncheck();
  await expect(scanRow()).toHaveAttribute('data-visible', 'false');
  await scanBox.check();
  await expect(scanRow()).toHaveAttribute('data-visible', 'true');
  await scanBox.uncheck();
  await expect(scanRow()).toHaveAttribute('data-visible', 'false');
  await scanBox.check();
  await expect(scanRow()).toHaveAttribute('data-visible', 'true');
  await page.getByTestId('filter-close').click();
  await expect(panel).toHaveCount(0);
  await expectUntouched();
});
