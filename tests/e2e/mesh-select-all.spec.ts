import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// The Meshes panel header gained the Select All / Deselect All pair the Scans
// panel has had all along — before this, the only way to select every mesh was
// to ctrl/cmd-click each row, and there was no way to clear a mesh selection
// from the panel at all (only a click on empty viewport space).
//
// Per CLAUDE.md Testing rules: live backend, drive the real UI (real File→Import
// dialog, real header buttons), and assert concrete state — each row's
// data-selected attribute, and that the scan selection beside it is untouched
// (the obvious wiring slip is handing the panel the viewer's own onDeselectAll,
// which clears SCANS).
const CUBE_PLY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'cube-mesh.ply');
const SPHERE_PLY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-mesh.ply');
const CLOUD_XYZ = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sparse.xyz');

test('the Meshes panel header selects and deselects every mesh', async () => {
  const { app, page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // A cloud as well as the meshes: the header buttons are a bulk action on
    // THIS panel, so the scan selection beside them must survive both presses.
    await importFiles(app, page, 'import-auto', [CUBE_PLY, SPHERE_PLY]);
    const meshRows = page.getByTestId('mesh-row');
    await expect(meshRows).toHaveCount(2, { timeout: 60_000 });

    await importFiles(app, page, 'import-point-cloud', CLOUD_XYZ);
    await completeImportWizard(page);
    const scanRow = page.getByTestId('scan-row').first();
    await expect(scanRow).toBeVisible({ timeout: 30_000 });

    // Make sure the scan is selected, so there is something to preserve. An
    // import usually leaves its scan selected; a second click on a sole
    // selection would toggle it back off, so only click when it isn't.
    if (await scanRow.getAttribute('data-selected') !== 'true') {
      await scanRow.getByTestId('scan-row-name').click();
    }
    await expect(scanRow).toHaveAttribute('data-selected', 'true');
    await expect(meshRows.nth(0)).toHaveAttribute('data-selected', 'false');
    await expect(meshRows.nth(1)).toHaveAttribute('data-selected', 'false');

    // Select All → every mesh row is selected, the scan is left alone.
    await page.getByTestId('meshes-select-all').click();
    await expect(meshRows.nth(0)).toHaveAttribute('data-selected', 'true');
    await expect(meshRows.nth(1)).toHaveAttribute('data-selected', 'true');
    await expect(scanRow).toHaveAttribute('data-selected', 'true');

    // Deselect All → the panel is cleared, and the scan is STILL selected.
    await page.getByTestId('meshes-deselect-all').click();
    await expect(meshRows.nth(0)).toHaveAttribute('data-selected', 'false');
    await expect(meshRows.nth(1)).toHaveAttribute('data-selected', 'false');
    await expect(scanRow).toHaveAttribute('data-selected', 'true');

    // A plain row click still means single-focus (and, as before, takes the
    // cloud selection with it) — the new buttons haven't changed what an
    // ordinary click does...
    await meshRows.nth(1).click();
    await expect(meshRows.nth(0)).toHaveAttribute('data-selected', 'false');
    await expect(meshRows.nth(1)).toHaveAttribute('data-selected', 'true');

    // ...and Select All extends a partial selection to the whole list.
    await page.getByTestId('meshes-select-all').click();
    await expect(meshRows.nth(0)).toHaveAttribute('data-selected', 'true');
    await expect(meshRows.nth(1)).toHaveAttribute('data-selected', 'true');
  } finally {
    await close();
  }
});
