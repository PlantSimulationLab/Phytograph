import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
const TREE_FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// Generalized undo/redo (Phase B): a mesh ADD is undoable, and undo/redo are
// reversible. Drives the real UI against the live backend per CLAUDE.md rules:
// import a cloud, triangulate (Open3D Ball Pivoting — the default), confirm the
// mesh row appears, then Cmd+Z removes it and Cmd+Shift+Z brings it back.
test('mesh add is undoable; undo removes it and redo restores it', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Triangulate with the default Open3D method (reliable, fast on 60 pts).
    await page.getByTestId('tool-triangulate').click();
    const modal = page.getByTestId('triangulation-popup');
    await expect(modal).toBeVisible();
    await modal.getByTestId('triangulation-run-button').click();

    // The mesh row appears once the backend returns.
    const meshRow = page.getByTestId('mesh-row');
    await expect(meshRow.first()).toBeVisible({ timeout: 60_000 });
    await expect(meshRow).toHaveCount(1);

    // Close the triangulation modal so the keyboard reaches the viewer's window
    // keydown listener (Cmd+Z). Wait for it to actually be gone — pressing Cmd+Z
    // while it's still mounted is the race that intermittently swallowed the undo.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('triangulation-popup')).toHaveCount(0);

    // Undo: the mesh add is reverted → no mesh rows.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(meshRow).toHaveCount(0, { timeout: 10_000 });

    // Redo (Cmd+Shift+Z): the mesh comes back.
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(meshRow).toHaveCount(1, { timeout: 10_000 });
    await expect(meshRow.first().getByTestId('mesh-row-count')).toContainText('triangles');
  } finally {
    await close();
  }
});

// Deleting a mesh is undoable: after deletion, one undo restores the row.
test('mesh delete is undoable', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('tool-triangulate').click();
    const modal = page.getByTestId('triangulation-popup');
    await expect(modal).toBeVisible();
    await modal.getByTestId('triangulation-run-button').click();

    const meshRow = page.getByTestId('mesh-row');
    await expect(meshRow.first()).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('triangulation-popup')).toHaveCount(0);

    // Select the mesh, then delete via the Meshes panel header (one confirm).
    await meshRow.first().click();
    await page.getByTestId('meshes-bulk-delete').click();
    await page.getByTestId('confirm-delete').click();
    await expect(meshRow).toHaveCount(0, { timeout: 10_000 });
    // Confirm dialog gone before the keyboard undo (avoids the focus race).
    await expect(page.getByTestId('confirm-delete')).toHaveCount(0);

    // Undo restores the deleted mesh.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(meshRow).toHaveCount(1, { timeout: 10_000 });
  } finally {
    await close();
  }
});

// Phase C: skeleton extraction is undoable. Uses the Y-shaped tree fixture and
// non-default extraction params (matching skeleton-extract.spec) so the BFS
// actually produces a skeleton, then Cmd+Z removes it and redo restores it.
test('skeleton extraction is undoable', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', TREE_FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('tool-skeleton').click();
    const panel = page.getByTestId('skeleton-panel');
    await expect(panel).toBeVisible();
    await page.getByTestId('skeleton-search-radius').fill('0.04');
    await page.getByTestId('skeleton-min-points').fill('1');
    await page.getByTestId('skeleton-extract-button').click();

    const skelRow = page.getByTestId('skeleton-row');
    await expect(skelRow.first()).toBeVisible({ timeout: 60_000 });
    await expect(skelRow).toHaveCount(1);

    // The skeleton panel auto-closes on successful extraction; wait for it to be
    // gone so the keyboard undo reaches the viewer's window listener.
    await expect(panel).toHaveCount(0);

    // Undo removes the skeleton; redo restores it.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(skelRow).toHaveCount(0, { timeout: 10_000 });
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(skelRow).toHaveCount(1, { timeout: 10_000 });
  } finally {
    await close();
  }
});
