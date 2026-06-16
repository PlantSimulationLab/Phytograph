import type { ElectronApplication } from '@playwright/test';

// Replaces the IPC `dialog:messageBox` handler so a workflow that shows a NATIVE
// Electron message box (dialog.showMessageBox — a blocking OS window Playwright
// cannot see or click) resolves to a deterministic button choice instead of
// hanging the test until timeout.
//
// Pass a single number to always click that button index, or an array to return
// one index per call (useful for flows that prompt more than once, e.g. the
// Helios XML import "Locate… / Skip" prompt shown once per unresolvable scan).
// Once the array is exhausted the last entry is repeated. The handler returns
// `{ response: <index> }`, matching the real handler's shape (src/main/ipc.ts).
export async function stubMessageBox(
  app: ElectronApplication,
  buttonIndexOrResponses: number | number[],
): Promise<void> {
  const responses = Array.isArray(buttonIndexOrResponses)
    ? buttonIndexOrResponses
    : [buttonIndexOrResponses];
  await app.evaluate(async ({ ipcMain }, msgResponses: number[]) => {
    const g = globalThis as unknown as {
      __messageBoxCalls?: unknown[];
      __messageBoxIndex?: number;
    };
    g.__messageBoxCalls = [];
    g.__messageBoxIndex = 0;
    ipcMain.removeHandler('dialog:messageBox');
    ipcMain.handle('dialog:messageBox', async (_e, opts) => {
      g.__messageBoxCalls!.push(opts);
      const idx = g.__messageBoxIndex ?? 0;
      const value = msgResponses[Math.min(idx, msgResponses.length - 1)];
      g.__messageBoxIndex = idx + 1;
      return { response: value };
    });
  }, responses);
}

export async function getMessageBoxCalls(app: ElectronApplication): Promise<unknown[]> {
  return app.evaluate(async () => {
    const g = globalThis as unknown as { __messageBoxCalls?: unknown[] };
    return g.__messageBoxCalls ?? [];
  });
}
