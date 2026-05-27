import type { ElectronApplication } from '@playwright/test';

// Replaces the IPC `dialog:open` handler so a workflow that triggers a native
// open file picker resolves to a deterministic value. Pass a single string to
// always return that path, or an array to return one entry per call (useful
// for flows that prompt multiple times, e.g. Helios XML import where each
// referenced point-cloud file may need to be located). Once the array is
// exhausted the last entry is repeated. `null` entries simulate user cancel.
//
// The real `fs:readText` / `fs:readBinary` handlers still run, so tests
// assert against real file contents on disk — no mocked I/O.
export async function stubOpenDialog(
  app: ElectronApplication,
  filePathOrResponses: string | (string | null)[],
): Promise<void> {
  const responses = Array.isArray(filePathOrResponses) ? filePathOrResponses : [filePathOrResponses];
  await app.evaluate(async ({ ipcMain }, openResponses: (string | null)[]) => {
    const g = globalThis as unknown as { __openDialogCalls?: unknown[]; __openDialogIndex?: number };
    g.__openDialogCalls = [];
    g.__openDialogIndex = 0;
    ipcMain.removeHandler('dialog:open');
    ipcMain.handle('dialog:open', async (_e, opts) => {
      g.__openDialogCalls!.push(opts);
      const idx = g.__openDialogIndex ?? 0;
      const value = openResponses[Math.min(idx, openResponses.length - 1)];
      g.__openDialogIndex = idx + 1;
      return value;
    });
  }, responses);
}

export async function getOpenDialogCalls(app: ElectronApplication): Promise<unknown[]> {
  return app.evaluate(async () => {
    const g = globalThis as unknown as { __openDialogCalls?: unknown[] };
    return g.__openDialogCalls ?? [];
  });
}
