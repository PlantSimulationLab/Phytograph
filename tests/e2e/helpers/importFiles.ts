import type { ElectronApplication, Page } from '@playwright/test';

// File→Import menu command kinds (mirror of MenuCommandPayload's import
// variants in src/shared/ipc.ts).
export type ImportKind = 'import-auto' | 'import-point-cloud' | 'import-mesh' | 'import-skeleton';

// Imports files through the File→Import menu pathway — the real one a user hits.
//
// File→Import sends a menu command over IPC (main → `webContents.send`,
// src/main/menu.ts); the renderer's handler (handleMenuImport in App.tsx) then
// shows the native open dialog via the `dialog:open` IPC and feeds the chosen
// paths into the import pipeline (reading bytes with the real `fs:readBinary`).
//
// Under automation we can't drive an OS file chooser, so we replace the
// `dialog:open` handler to deterministically return the fixture path(s) — the
// same `multi: true` shape the renderer requests (an array). Everything
// downstream is real: real fs reads, real parsers, real backend import. This is
// also why the old gesture bug is now caught: the dialog is shown by the main
// process, not the renderer's gesture-gated dropzone.open().
//
// The handler is restored to throwing on the next call so a test that triggers
// an *unexpected* second import fails loudly instead of silently re-importing.
export async function importFiles(
  app: ElectronApplication,
  page: Page,
  kind: ImportKind,
  files: string | string[],
): Promise<void> {
  const paths = Array.isArray(files) ? files : [files];

  // The menu command is delivered to the renderer's onMenuCommand subscriber
  // (registered in a React effect). Wait until the app has mounted before
  // firing, or the IPC arrives before anything is listening and is dropped.
  await page.getByTestId('app-dropzone-input').waitFor({ state: 'attached' });

  await app.evaluate(async ({ ipcMain }, fixturePaths: string[]) => {
    ipcMain.removeHandler('dialog:open');
    // Mark the fixtures as user-selected, exactly as the real dialog:open
    // handler does — otherwise the fs allowlist (src/main/fsAllowlist.ts) denies
    // the downstream fs:readBinary. The real handler we're replacing seeds this.
    const allow = (globalThis as { __phytographAllowPath?: (p: string) => void }).__phytographAllowPath;
    for (const p of fixturePaths) allow?.(p);
    let served = false;
    ipcMain.handle('dialog:open', async () => {
      if (served) return null; // a second, unexpected prompt → user-cancel
      served = true;
      // Renderer requests `multi: true`, so it accepts an array of paths.
      return fixturePaths;
    });
  }, paths);

  await app.evaluate(({ BrowserWindow }, k) => {
    // IPC.MenuCommand === 'menu:command' (src/shared/ipc.ts). Hard-coded for
    // the same reason stubOpenDialog hard-codes 'dialog:open': the evaluate
    // body is serialized into the main process and can't close over TS imports.
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: k });
  }, kind);

  // Give the async handleMenuImport chain (dialog → readBinary → parse) a beat
  // to kick off; callers then await the resulting UI (wizard, mesh row, etc.).
  await page.waitForTimeout(100);
}
