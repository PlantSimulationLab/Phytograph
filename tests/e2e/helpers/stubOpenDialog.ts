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
//
// `hold: true` makes the stub behave like a picker the user has NOT answered
// yet: the handler records the call, then parks on a promise that only
// `releaseOpenDialog` resolves. Without it there is no such state to observe —
// the handler records and returns the path in one synchronous body, so by the
// time `getOpenDialogCalls` reports a call the caller already has its
// destination and the work is running. Any assertion of the form "nothing has
// claimed success while the picker is open" is then a race against however long
// the work takes, which for a small fixture is well under one poll interval.
export async function stubOpenDialog(
  app: ElectronApplication,
  filePathOrResponses: string | (string | null)[],
  opts: { hold?: boolean } = {},
): Promise<void> {
  const responses = Array.isArray(filePathOrResponses) ? filePathOrResponses : [filePathOrResponses];
  await app.evaluate(async ({ ipcMain }, { openResponses, hold }: { openResponses: (string | null)[]; hold: boolean }) => {
    const g = globalThis as unknown as {
      __openDialogCalls?: unknown[];
      __openDialogIndex?: number;
      __openDialogRelease?: (() => void) | null;
      __openDialogGate?: Promise<void> | null;
      __phytographAllowPath?: (p: string, kind?: 'file' | 'saveFile' | 'directory') => void;
    };
    g.__openDialogCalls = [];
    g.__openDialogIndex = 0;
    g.__openDialogRelease = null;
    g.__openDialogGate = hold
      ? new Promise<void>((resolve) => { g.__openDialogRelease = resolve; })
      : null;
    // Seed the fs allowlist with every path this stub may return, mirroring the
    // real dialog:open handler — otherwise downstream fs:readBinary/readText is
    // denied (src/main/fsAllowlist.ts). null entries (user-cancel) are skipped.
    for (const r of openResponses) if (r) g.__phytographAllowPath?.(r);
    ipcMain.removeHandler('dialog:open');
    ipcMain.handle('dialog:open', async (_e, opts) => {
      g.__openDialogCalls!.push(opts);
      // Park BEFORE returning a path, so the caller is genuinely still waiting
      // on the picker while the test inspects the UI. The call is already
      // recorded, so getOpenDialogCalls observes it during the hold.
      if (g.__openDialogGate) await g.__openDialogGate;
      const idx = g.__openDialogIndex ?? 0;
      const value = openResponses[Math.min(idx, openResponses.length - 1)];
      g.__openDialogIndex = idx + 1;
      // Re-allow with the kind the REAL handler would use: a chosen directory
      // authorizes writes to its children (the export-to-folder flows), which
      // the up-front 'file' seeding above does not. Without this a folder export
      // is denied by src/main/fsAllowlist.ts.
      if (value) {
        g.__phytographAllowPath?.(value, opts?.directory ? 'directory' : 'file');
      }
      return value;
    });
  }, { openResponses: responses, hold: opts.hold === true });
}

// Answer a picker stubbed with `hold: true`. No-op if nothing is holding, so a
// test can release unconditionally in a finally block.
export async function releaseOpenDialog(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const g = globalThis as unknown as { __openDialogRelease?: (() => void) | null };
    g.__openDialogRelease?.();
    g.__openDialogRelease = null;
  });
}

export async function getOpenDialogCalls(app: ElectronApplication): Promise<unknown[]> {
  return app.evaluate(async () => {
    const g = globalThis as unknown as { __openDialogCalls?: unknown[] };
    return g.__openDialogCalls ?? [];
  });
}
