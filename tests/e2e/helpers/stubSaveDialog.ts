import type { ElectronApplication } from '@playwright/test';

// Replaces the IPC `dialog:save` handler in the running main process so an
// export workflow can route its native Save-As to a deterministic path. The
// real `fs:writeText` / `fs:writeBinary` handlers still run, so the test
// asserts against a real file on disk — no mocked I/O.
//
// Also records every `dialog:save` invocation onto `global.__saveDialogCalls`
// so tests can assert that the dialog actually fired (catches the case
// where an export button silently no-ops because the renderer took a
// different path).
export async function stubSaveDialog(
  app: ElectronApplication,
  filePath: string,
): Promise<void> {
  await app.evaluate(async ({ ipcMain }, savePath: string) => {
    const g = globalThis as unknown as { __saveDialogCalls?: unknown[] };
    g.__saveDialogCalls = [];
    // The renderer's IPC channel name is 'dialog:save' (see src/shared/ipc.ts).
    ipcMain.removeHandler('dialog:save');
    ipcMain.handle('dialog:save', async (_e, opts) => {
      g.__saveDialogCalls!.push(opts);
      return savePath;
    });
  }, filePath);
}

export async function getSaveDialogCalls(app: ElectronApplication): Promise<unknown[]> {
  return app.evaluate(async () => {
    const g = globalThis as unknown as { __saveDialogCalls?: unknown[] };
    return g.__saveDialogCalls ?? [];
  });
}
