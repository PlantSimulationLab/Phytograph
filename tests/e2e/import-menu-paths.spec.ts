import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';

// Regression coverage for two import bugs:
//
// 1. File → Import → {Mesh, Skeleton, Auto-detect} did nothing. The menu
//    command reached the renderer with no transient user gesture, so the
//    dropzone's gesture-gated open() never surfaced a picker. The fix routes
//    menu imports through the native Electron dialog (shown by the main
//    process, no renderer gesture needed). importFiles() now drives that real
//    dialog → readBinary → import pipeline, so these tests exercise the fix.
//
// 2. Dropping a mesh .ply after a cancelled skeleton import raised
//    "Unsupported skeleton format: .ply" — a stale pendingImportTypeRef from
//    the menu leaked into the next drop. The fix removes the menu's dependency
//    on that ref entirely and makes drops auto-detect explicitly.
//
// Per CLAUDE.md: live backend, real UI, assert concrete outputs, no mocking the
// backend (the native OS chooser is stubbed to a fixture path — allowed).
const MESH_PLY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'cube-mesh.ply');
const SKELETON_JSON = join(repoRoot, 'tests', 'e2e', 'fixtures', 'skeleton.json');

test('File → Import → Mesh imports a mesh through the native dialog', async () => {
  const { app, page, close } = await launchApp();
  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await importFiles(app, page, 'import-mesh', MESH_PLY);

    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 30_000 });
    await expect(meshRow).toHaveAttribute('data-triangle-count', '12');
    await expect(meshRow).toHaveAttribute('data-mesh-name', 'cube-mesh');
    await expect(page.getByTestId('scan-row')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('File → Import → Skeleton imports a skeleton through the native dialog', async () => {
  const { app, page, close } = await launchApp();
  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await importFiles(app, page, 'import-skeleton', SKELETON_JSON);

    const skelRow = page.getByTestId('skeleton-row').first();
    await expect(skelRow).toBeVisible({ timeout: 30_000 });
    await expect(skelRow).toHaveAttribute('data-point-count', '3');
    await expect(page.getByTestId('mesh-row')).toHaveCount(0);
    await expect(page.getByTestId('scan-row')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('a dropped mesh .ply still auto-detects after a cancelled skeleton import', async () => {
  const { app, page, close } = await launchApp();
  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // User picks File → Import → Skeleton, then cancels the native dialog.
    await app.evaluate(async ({ ipcMain }) => {
      ipcMain.removeHandler('dialog:open');
      ipcMain.handle('dialog:open', async () => null); // cancel
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: 'import-skeleton' });
    });
    await page.waitForTimeout(200);
    // Nothing imported, no error, still empty.
    await expect(page.getByTestId('skeleton-row')).toHaveCount(0);
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // Now the user drags a face-bearing .ply into the viewport. It must be
    // auto-detected as a mesh — NOT routed to the skeleton parser (the old bug
    // produced "Unsupported skeleton format: .ply"). A drop is the dropzone
    // input's change event (noClick), which onDrop handles with auto-detect.
    await page.getByTestId('app-dropzone-input').setInputFiles(MESH_PLY);

    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 30_000 });
    await expect(meshRow).toHaveAttribute('data-triangle-count', '12');
    // The skeleton-format error toast must never appear.
    await expect(page.getByText(/Unsupported skeleton format/i)).toHaveCount(0);
  } finally {
    await close();
  }
});
