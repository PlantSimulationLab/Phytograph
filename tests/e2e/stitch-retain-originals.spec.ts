import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
const TREE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// Stitch "Keep original clouds" end-to-end.
//
// Fixtures: tiny.xyz (60 pts) + tree.xyz (900 pts) → merged 960 pts.
//
// By default a stitch REMOVES its inputs from the scene. With the box ticked
// they stay, hidden, so the viewport matches the destructive result while the
// sources remain available (they keep their scanner origins, so origin-
// dependent analyses can still run on them).
//
// The backend merge already leaves the input sessions untouched — this option
// only changes which actions the scene transaction carries.
//
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

// Import both fixtures, select them, and open the stitch dialog.
async function importBothAndOpenDialog(session: LaunchedApp) {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', [TINY, TREE]);
  await completeImportWizard(page);

  const rows = page.locator('[data-testid="scan-row"]');
  await expect(rows).toHaveCount(2, { timeout: 20_000 });

  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  const treeRow = page.locator('[data-testid="scan-row"][data-scan-name="tree"]');
  await expect(tinyRow).toHaveAttribute('data-point-count', '60');
  await expect(treeRow).toHaveAttribute('data-point-count', '900');

  await tinyRow.click();
  await treeRow.click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('[data-testid="scan-row"][data-selected="true"]')).toHaveCount(2);

  await page.getByTestId('tool-cloud-stitch').click();
  const dialog = page.getByTestId('stitch-dialog');
  await expect(dialog).toBeVisible();
  return { rows, tinyRow, treeRow, dialog };
}

test('retained stitch keeps both inputs in the scene, hidden, alongside the merge', async () => {
  const { page } = session;
  const { rows, tinyRow, treeRow, dialog } = await importBothAndOpenDialog(session);

  // Off by default — the destructive path is what an untouched dialog does.
  const retain = dialog.getByTestId('stitch-retain-originals').locator('input');
  await expect(retain).not.toBeChecked();
  await retain.check();

  await dialog.getByTestId('stitch-run').click();
  await expect(dialog).toHaveCount(0);

  // Three rows now: both retained sources + the merge.
  await expect(rows).toHaveCount(3, { timeout: 30_000 });

  // Sources survive at their original counts, hidden.
  await expect(tinyRow).toHaveAttribute('data-point-count', '60');
  await expect(treeRow).toHaveAttribute('data-point-count', '900');
  await expect(tinyRow).toHaveAttribute('data-visible', 'false');
  await expect(treeRow).toHaveAttribute('data-visible', 'false');

  // The merged cloud carries every point and went through the backend session
  // path (a flat collapse would report data-octree=false).
  const merged = page.locator('[data-testid="scan-row"][data-scan-name="tiny_tree_stitched"]');
  await expect(merged).toBeVisible({ timeout: 30_000 });
  await expect(merged).toHaveAttribute('data-point-count', '960', { timeout: 30_000 });
  await expect(merged).toHaveAttribute('data-octree', 'true');
  await expect(merged).toHaveAttribute('data-visible', 'true');
  await expect(merged).toHaveAttribute('data-selected', 'true');
});

test('undoing a retained stitch removes only the merged cloud', async () => {
  const { page } = session;
  const { rows, tinyRow, treeRow, dialog } = await importBothAndOpenDialog(session);

  await dialog.getByTestId('stitch-retain-originals').locator('input').check();
  await dialog.getByTestId('stitch-run').click();
  await expect(dialog).toHaveCount(0);
  await expect(rows).toHaveCount(3, { timeout: 30_000 });

  await page.keyboard.press('ControlOrMeta+z');

  // Back to the two sources at full count. They stay HIDDEN: visibility is
  // deliberately outside the undo action model (SceneAction's `property` kind
  // covers label/color/opacity/colorMode only), so the user unhides them with
  // the eye icon. Pinned here so the trade-off can't regress silently.
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  await expect(tinyRow).toHaveAttribute('data-point-count', '60');
  await expect(treeRow).toHaveAttribute('data-point-count', '900');
  await expect(tinyRow).toHaveAttribute('data-visible', 'false');
  await expect(treeRow).toHaveAttribute('data-visible', 'false');
});

test('deleting the merged cloud leaves the retained originals usable', async () => {
  const { page } = session;
  const { rows, tinyRow, treeRow, dialog } = await importBothAndOpenDialog(session);

  await dialog.getByTestId('stitch-retain-originals').locator('input').check();
  await dialog.getByTestId('stitch-run').click();
  await expect(dialog).toHaveCount(0);
  await expect(rows).toHaveCount(3, { timeout: 30_000 });

  const merged = page.locator('[data-testid="scan-row"][data-scan-name="tiny_tree_stitched"]');
  await expect(merged).toBeVisible({ timeout: 30_000 });
  const mergedId = await merged.getAttribute('data-scan-id');
  await page.getByTestId(`scan-delete-${mergedId}`).click();
  // Deleting a cloud asks for confirmation first.
  await expect(page.getByTestId('delete-confirm-title')).toBeVisible();
  await page.getByTestId('confirm-delete').click();

  // The merge got its OWN backend session, so freeing it must not disturb the
  // sources' sessions — two scene objects sharing a session id would leave the
  // survivors dangling ("Point cloud unavailable").
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
  await expect(tinyRow).toHaveAttribute('data-point-count', '60');
  await expect(treeRow).toHaveAttribute('data-point-count', '900');
  await expect(page.getByText('Point cloud unavailable')).toHaveCount(0);

  // The retained sources are still real, live clouds: the eye icon brings one
  // back (the button's title flips Hide/Show with the current state).
  await tinyRow.getByTitle('Show').click();
  await expect(tinyRow).toHaveAttribute('data-visible', 'true');
});
