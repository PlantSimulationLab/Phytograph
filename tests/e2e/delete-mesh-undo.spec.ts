import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';

// Regression: the delete confirmation dialog used to claim "This action cannot
// be undone" for EVERY object type, but mesh/skeleton/qsm/cloud deletes all
// commit an undoable `remove` to the scene store. The dialog now tells the user
// the delete is reversible; this test pins both halves of that claim end-to-end:
//   1. the dialog body advertises the undo shortcut (not "cannot be undone"), and
//   2. deleting an imported mesh, then undoing, brings it back.
//
// Per CLAUDE.md Testing rules: live backend, drive the real UI through the file
// chooser + the row's Remove button + the real Ctrl/Cmd+Z keybinding, and assert
// on concrete UI state (the mesh row's presence + triangle count).
const MESH_PLY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'cube-mesh.ply');

test('deleting an imported mesh is undoable, and the dialog says so', async () => {
  const { app, page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // Import the cube mesh (12 triangles) and confirm the mesh row.
    await importFiles(app, page, 'import-auto', MESH_PLY);
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 30_000 });
    await expect(meshRow).toHaveAttribute('data-triangle-count', '12');

    // Grab the row's id so we can target its Remove button precisely.
    const meshId = await meshRow.getAttribute('data-mesh-id');
    await page.getByTestId(`mesh-delete-${meshId}`).click();

    // The confirmation dialog must NOT claim the delete is irreversible — it
    // advertises the undo shortcut instead (⌘Z on macOS, Ctrl+Z elsewhere).
    const dialog = page.getByTestId('delete-confirm-title');
    await expect(dialog).toBeVisible();
    const body = page.locator('text=/You can undo this with/');
    await expect(body).toBeVisible();
    await expect(page.locator('text=/cannot be undone/')).toHaveCount(0);

    // Confirm the delete; the mesh row disappears.
    await page.getByTestId('confirm-delete').click();
    await expect(page.getByTestId('mesh-row')).toHaveCount(0);

    // Undo via the real keybinding — the mesh comes back with its geometry.
    const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';
    await page.keyboard.press(undoKey);

    const restored = page.getByTestId('mesh-row').first();
    await expect(restored).toBeVisible({ timeout: 10_000 });
    await expect(restored).toHaveAttribute('data-triangle-count', '12');
  } finally {
    await close();
  }
});
