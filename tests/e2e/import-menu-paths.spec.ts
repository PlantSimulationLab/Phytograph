import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { resetToFreshScene } from './helpers/resetApp';

// Regression coverage for two import bugs:
//
// 1. File → Import → {Mesh, Skeleton, Auto-detect} did nothing. The menu
//    command reached the renderer with no transient user gesture, so the
//    dropzone's gesture-gated open() never surfaced a picker. Menu imports now
//    open the in-app import browser (FileBrowserDialog), which needs no
//    gesture at all. importFiles() drives that real browser → grant →
//    readBinary → import pipeline, so these tests exercise it.
//
// 2. Dropping a mesh .ply after a canceled skeleton import raised
//    "Unsupported skeleton format: .ply" — a stale pendingImportTypeRef from
//    the menu leaked into the next drop. The fix removes the menu's dependency
//    on that ref entirely and makes drops auto-detect explicitly.
//
// Per CLAUDE.md: live backend, real UI, assert concrete outputs, no mocking.
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).
const MESH_PLY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'cube-mesh.ply');
const SKELETON_JSON = join(repoRoot, 'tests', 'e2e', 'fixtures', 'skeleton.json');

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

test('File → Import → Mesh imports a mesh through the import browser', async () => {
  const { app, page } = session;
  await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

  await importFiles(app, page, 'import-mesh', MESH_PLY);

  const meshRow = page.getByTestId('mesh-row').first();
  await expect(meshRow).toBeVisible({ timeout: 30_000 });
  await expect(meshRow).toHaveAttribute('data-triangle-count', '12');
  await expect(meshRow).toHaveAttribute('data-mesh-name', 'cube-mesh');
  await expect(page.getByTestId('scan-row')).toHaveCount(0);
});

test('File → Import → Skeleton imports a skeleton through the import browser', async () => {
  const { app, page } = session;
  await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

  await importFiles(app, page, 'import-skeleton', SKELETON_JSON);

  const skelRow = page.getByTestId('skeleton-row').first();
  await expect(skelRow).toBeVisible({ timeout: 30_000 });
  await expect(skelRow).toHaveAttribute('data-point-count', '3');
  await expect(page.getByTestId('mesh-row')).toHaveCount(0);
  await expect(page.getByTestId('scan-row')).toHaveCount(0);
});

test('a dropped mesh .ply still auto-detects after a canceled skeleton import', async () => {
  const { app, page } = session;
  await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

  // User picks File → Import → Skeleton, then cancels the browser.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: 'import-skeleton' });
  });
  await expect(page.getByTestId('file-browser')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('file-browser-cancel').click();
  await expect(page.getByTestId('file-browser')).toBeHidden();
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
});

test('a dropped point cloud still opens the wizard after a File → Import of the same file', async () => {
  // File → Import hands the browser's options to the import through a preset
  // map (App.tsx presetWizardResultsRef) so the wizard is skipped. That map
  // must not outlive its import: if it did, dropping the same file later would
  // silently reuse the old choices instead of asking.
  const { app, page } = session;
  const cloud = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
  await importFiles(app, page, 'import-point-cloud', cloud);
  await expect(page.locator('[data-testid="scan-row"][data-scan-name="tiny"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('import-wizard')).toHaveCount(0);

  await page.getByTestId('app-dropzone-input').setInputFiles(cloud);
  await expect(page.getByTestId('import-wizard')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('import-wizard-cancel').click();
  await expect(page.getByTestId('import-wizard')).toBeHidden();
});
