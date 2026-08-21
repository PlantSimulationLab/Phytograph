import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { stubSaveDialog, getSaveDialogCalls } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// POINT-CLOUD export (the "Export" button in the cloud section) to LAZ.
//
// The reported bug: a success toast fired immediately on click, THEN a save
// dialog appeared, and after choosing a location there was no progress pill and
// no completion toast. Cause: the LAS/LAZ/PLY/OBJ/ASCII branches hand the bytes
// to an <a download> click, which in Electron is an out-of-band browser download
// — the renderer's promise resolves as soon as the click returns, so "Export
// Complete" describes a file that has not been written and may not even have a
// destination yet. The native Save-As the user then sees belongs to Chromium's
// download handler, which the renderer never observes.
//
// Both properties asserted here are ORDERING ones. export-octree-cloud.spec.ts
// misses them because an octree-backed cloud takes the backend/session branch;
// this test uses an inline (flat) cloud, which is the <a download> path.
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

test('point-cloud LAZ export writes through a save dialog and reports completion only after the write', async () => {
  const { app, page } = session;

  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-cloudlaz-'));
  const savePath = join(outDir, 'cloud.laz');

  const fixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.ply');
  await importFiles(app, page, 'import-auto', fixture);
  await completeImportWizard(page);
  await expect(page.getByTestId('scans-panel').locator('[data-testid="scan-row"]'))
    .toHaveCount(1, { timeout: 30_000 });

  // Stub the save dialog only after the import, so it can't be confused with the
  // import's own open dialog.
  await stubSaveDialog(app, savePath);

  await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
  await expect(page.getByTestId('export-modal')).toBeVisible();

  await page.getByTestId('export-format-laz').click();
  await expect(page.getByTestId('export-format-laz')).toHaveAttribute('data-active', 'true');

  // Clear import toasts so anything below is attributable to the export.
  for (const close of await page.getByTestId('toast-close').all()) {
    await close.click().catch(() => {});
  }
  await expect(page.getByTestId('toast-title')).toHaveCount(0, { timeout: 15_000 });

  // Hold the save dialog open until we release it. This is what makes the
  // ordering assertion sound: with an instantly-returning stub the whole export
  // finishes within a frame, so "no success toast yet" would pass even for the
  // broken build. Blocking the dialog reproduces the real situation — the user
  // is still choosing a destination — and a premature toast becomes observable.
  await app.evaluate(async ({ ipcMain }, p: string) => {
    const g = globalThis as unknown as {
      __saveDialogCalls?: unknown[];
      __releaseSave?: () => void;
      __phytographAllowPath?: (path: string, kind?: string) => void;
    };
    g.__saveDialogCalls = [];
    g.__phytographAllowPath?.(p, 'saveFile');
    ipcMain.removeHandler('dialog:save');
    ipcMain.handle('dialog:save', async (_e, opts) => {
      g.__saveDialogCalls!.push(opts);
      await new Promise<void>(resolve => { g.__releaseSave = resolve; });
      return p;
    });
  }, savePath);

  await page.getByTestId('export-cloud-go').click();

  // (1) The export must route through the app's own save dialog, not an
  // out-of-band <a download>. Without this the file lands wherever Chromium
  // decides (or behind a native prompt the renderer can't see).
  await expect.poll(async () => (await getSaveDialogCalls(app)).length, { timeout: 20_000 })
    .toBeGreaterThan(0);

  // (2) While the picker is still open, nothing may claim the export succeeded.
  await page.waitForTimeout(1000);
  const titlesBeforeWrite = await page.getByTestId('toast-title').allTextContents();
  expect(
    titlesBeforeWrite.filter(t => /complete|success|exported/i.test(t)),
    `a success toast appeared while the save dialog was still open: ${JSON.stringify(titlesBeforeWrite)}`,
  ).toHaveLength(0);

  // (2b) …and no progress pill either. The pill means "work in progress", but
  // the user is still choosing a destination and no work has started. It used to
  // be raised first, leaving it spinning behind the file browser.
  await expect(page.getByTestId('scan-export-running')).toHaveCount(0);

  // Nothing can be on disk yet either — the destination isn't chosen.
  expect(readdirSync(outDir).filter(f => f.toLowerCase().endsWith('.laz'))).toHaveLength(0);

  // The user picks the path; now the real work runs.
  await app.evaluate(async () => {
    (globalThis as unknown as { __releaseSave?: () => void }).__releaseSave?.();
  });

  // (3) The file must actually land at the chosen path, non-empty. Poll the
  // SIZE, not existence — the write isn't atomic, so a separate existence check
  // followed by a stat can observe a freshly-created but still-empty file (this
  // raced under 2-worker contention).
  await expect.poll(
    () => {
      const laz = readdirSync(outDir).filter(f => f.toLowerCase().endsWith('.laz'));
      if (laz.length === 0) return 0;
      return Math.min(...laz.map(f => statSync(join(outDir, f)).size));
    },
    { timeout: 60_000, intervals: [200, 500, 1000] },
  ).toBeGreaterThan(0);

  // (4) And only then does completion get reported.
  await expect(page.getByTestId('toast-title').filter({ hasText: /Export Complete/i }))
    .toBeVisible({ timeout: 30_000 });
});
