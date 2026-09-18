import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPC, type UpdaterStatusPayload } from '../shared/ipc.js';

// electron-updater is an EventEmitter in practice; a minimal stand-in lets us
// fire the real lifecycle events at the real listeners registered by updater.ts.
const handlers = new Map<string, (arg: any) => void>();

const autoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: false,
  on: vi.fn((event: string, cb: (arg: any) => void) => {
    handlers.set(event, cb);
  }),
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(() => Promise.resolve()),
  quitAndInstall: vi.fn(),
};

const app = { isPackaged: true, getVersion: vi.fn(() => '0.57.0') };
const showMessageBox =
  vi.fn<(win: any, opts: any) => Promise<{ response: number }>>(() =>
    Promise.resolve({ response: 1 }),
  );

// Captures the renderer->main handlers updater.ts registers, so a test can
// play the renderer and fire the paint ack.
const invokeHandlers = new Map<string, (...args: any[]) => any>();

vi.mock('electron', () => ({
  app,
  dialog: { showMessageBox: (win: any, opts: any) => showMessageBox(win, opts) },
  ipcMain: {
    handle: vi.fn((channel: string, cb: (...args: any[]) => any) => {
      invokeHandlers.set(channel, cb);
    }),
  },
  BrowserWindow: class {},
}));
vi.mock('electron-updater', () => ({ default: { autoUpdater } }));
vi.mock('./logger.js', () => ({
  updaterLog: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Captures what main pushes to the renderer over IPC.
let sent: { channel: string; payload: UpdaterStatusPayload }[] = [];
const fakeWindow = {
  webContents: {
    send: (channel: string, payload: UpdaterStatusPayload) => sent.push({ channel, payload }),
  },
};
const getWindow = () => fakeWindow as any;

/** Fresh module per test — updater.ts has module-level `listenersRegistered`. */
async function loadUpdater() {
  vi.resetModules();
  handlers.clear();
  invokeHandlers.clear();
  sent = [];
  showMessageBox.mockClear();
  showMessageBox.mockResolvedValue({ response: 1 } as any);
  // mockClear leaves recorded calls on checkForUpdates; reset it so per-test
  // "was it called?" assertions can't see a previous test's invocation.
  autoUpdater.checkForUpdates.mockReset();
  autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.57.0' } });
  autoUpdater.downloadUpdate.mockClear();
  autoUpdater.quitAndInstall.mockClear();
  app.isPackaged = true;
  return import('./updater.js');
}

/** Let the promise chain inside setupAutoUpdater settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('download progress → renderer', () => {
  beforeEach(loadUpdater);

  it('forwards percent as a downloading payload on the updater channel', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.58.0' } });
    setupAutoUpdater(getWindow);

    handlers.get('update-available')!({ version: '0.58.0' });
    handlers.get('download-progress')!({ percent: 42.5, bytesPerSecond: 1024 * 1024 });

    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(IPC.UpdaterStatus);
    expect(sent[0].payload).toEqual({
      status: 'downloading',
      version: '0.58.0',
      percent: 42.5,
    });
  });

  it('carries the version from update-available into progress events', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.3' } });
    setupAutoUpdater(getWindow);

    handlers.get('update-available')!({ version: '1.2.3' });
    handlers.get('download-progress')!({ percent: 10, bytesPerSecond: 1 });

    // ProgressInfo has no version field, so this only works if it was remembered.
    expect((sent[0].payload as any).version).toBe('1.2.3');
  });

  it('sends percent: null when percent is not finite (guards a NaN-width bar)', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.58.0' } });
    setupAutoUpdater(getWindow);

    handlers.get('download-progress')!({ percent: NaN, bytesPerSecond: 0 });

    expect((sent[0].payload as any).percent).toBeNull();
  });

  it('clears the pill on error so a failed download does not spin forever', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.58.0' } });
    setupAutoUpdater(getWindow);

    handlers.get('error')!(new Error('ETIMEDOUT'));

    expect(sent.at(-1)!.payload).toEqual({ status: 'error' });
  });

  it('survives a missing window (startup / teardown) without throwing', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.58.0' } });
    setupAutoUpdater(() => null);

    expect(() => handlers.get('download-progress')!({ percent: 5, bytesPerSecond: 1 })).not.toThrow();
  });
});

describe('update-downloaded prompt', () => {
  beforeEach(loadUpdater);

  it('emits downloaded, then explains the close/install/reopen sequence', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.58.0' } });
    setupAutoUpdater(getWindow);

    await handlers.get('update-downloaded')!({ version: '0.58.0' });

    expect(sent.at(-1)!.payload).toEqual({ status: 'downloaded', version: '0.58.0' });

    // Pick the restart prompt by title — the startup consent dialog may also
    // have fired, and `.at(-1)` would race it.
    const opts = showMessageBox.mock.calls
      .map((c) => c[1] as any)
      .find((o) => o?.title === 'Update ready');
    expect(opts).toBeDefined();
    // The whole point of the reword: name each step and bound the wait.
    expect(opts.detail).toMatch(/close/i);
    expect(opts.detail).toMatch(/install/i);
    expect(opts.detail).toMatch(/reopen/i);
    expect(opts.detail).toMatch(/under a minute/i);
  });

  it('installs only when the user picks "Restart now"', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.58.0' } });
    setupAutoUpdater(getWindow);

    // Answer per-dialog by title so the startup consent prompt can't consume
    // the response intended for the restart prompt.
    const answerRestartWith = (response: number) =>
      showMessageBox.mockImplementation((_win: any, opts: any) =>
        Promise.resolve({ response: opts?.title === 'Update ready' ? response : 1 }),
      );

    answerRestartWith(1); // "Later"
    await handlers.get('update-downloaded')!({ version: '0.58.0' });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    answerRestartWith(0); // "Restart now"
    await handlers.get('update-downloaded')!({ version: '0.58.0' });
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});

describe('restart notice covers the install gap', () => {
  beforeEach(loadUpdater);

  /** Answer the restart prompt with "Restart now", leaving others as "Later". */
  const clickRestartNow = () =>
    showMessageBox.mockImplementation((_win: any, opts: any) =>
      Promise.resolve({ response: opts?.title === 'Update ready' ? 0 : 1 }),
    );

  it('shows "installing" BEFORE quitAndInstall, not after', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.58.0' } });
    clickRestartNow();

    // Play the renderer: ack as soon as the notice arrives. Without an ack the
    // install would still proceed (on timeout), so acking here is what proves
    // the ordering rather than the timeout masking it.
    const fakeWindow2 = {
      webContents: {
        send: (channel: string, payload: UpdaterStatusPayload) => {
          sent.push({ channel, payload });
          if ((payload as any).status === 'installing') {
            // Deliberately async, like a real IPC round-trip.
            setTimeout(() => invokeHandlers.get(IPC.UpdaterStatusPainted)?.(), 0);
          }
        },
      },
    };
    setupAutoUpdater(() => fakeWindow2 as any);

    // Record the ordering: main blocks right after quitAndInstall, so an
    // 'installing' emitted afterwards would never reach the screen.
    let installingSentAt = -1;
    autoUpdater.quitAndInstall.mockImplementation(() => {
      installingSentAt = sent.findIndex((s) => (s.payload as any).status === 'installing');
    });

    await handlers.get('update-downloaded')!({ version: '0.58.0' });

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    // The notice was already in `sent` at the moment quitAndInstall ran.
    expect(installingSentAt).toBeGreaterThanOrEqual(0);
  });

  it('waits for the renderer paint ack before installing', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.58.0' } });
    clickRestartNow();

    let acked = false;
    let quitBeforeAck = false;
    const fakeWindow2 = {
      webContents: {
        send: (channel: string, payload: UpdaterStatusPayload) => {
          sent.push({ channel, payload });
          if ((payload as any).status === 'installing') {
            setTimeout(() => {
              acked = true;
              invokeHandlers.get(IPC.UpdaterStatusPainted)?.();
            }, 20);
          }
        },
      },
    };
    autoUpdater.quitAndInstall.mockImplementation(() => {
      if (!acked) quitBeforeAck = true;
    });
    setupAutoUpdater(() => fakeWindow2 as any);

    await handlers.get('update-downloaded')!({ version: '0.58.0' });

    // The ack gates the install; racing past it is the bug being prevented.
    expect(quitBeforeAck).toBe(false);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('installs anyway when the renderer never acks (a wedged window must not block the update)', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.58.0' } });
    clickRestartNow();
    // fakeWindow records the send but never acks.
    setupAutoUpdater(getWindow);

    await handlers.get('update-downloaded')!({ version: '0.58.0' });

    expect(sent.some((s) => (s.payload as any).status === 'installing')).toBe(true);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('does not show the restart notice when the user picks "Later"', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.58.0' } });
    showMessageBox.mockResolvedValue({ response: 1 } as any); // "Later"
    setupAutoUpdater(getWindow);

    await handlers.get('update-downloaded')!({ version: '0.58.0' });

    expect(sent.some((s) => (s.payload as any).status === 'installing')).toBe(false);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe('startup check asks consent before downloading', () => {
  beforeEach(loadUpdater);

  it('does not auto-download, and downloads only after the user agrees', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.58.0' } });
    showMessageBox.mockResolvedValue({ response: 0 } as any); // "Download"

    setupAutoUpdater(getWindow);
    // The regression this locks in: a large installer must never start
    // downloading on launch without asking.
    expect(autoUpdater.autoDownload).toBe(false);

    await flush();
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not download when the user picks "Later"', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.58.0' } });
    showMessageBox.mockResolvedValue({ response: 1 } as any); // "Later"

    setupAutoUpdater(getWindow);
    await flush();

    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('stays silent when already on the latest version', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.57.0' } });

    setupAutoUpdater(getWindow);
    await flush();

    // No "you're up to date" dialog on the startup path — that's manual-only.
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('skips entirely in a dev build', async () => {
    const { setupAutoUpdater } = await loadUpdater();
    app.isPackaged = false;

    setupAutoUpdater(getWindow);
    await flush();

    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The install must be vetoable BEFORE it happens
// ---------------------------------------------------------------------------
//
// electron-updater's `quitAndInstall()` installs FIRST and quits second:
// `install()` runs to completion, then `app.quit()` goes out on a setImmediate.
// So the app's own 'before-quit' scene-dirty prompt cannot veto it — by the time
// preventDefault() runs, the Linux AppImage has been unlinked and replaced, or
// the Windows NSIS installer is rewriting the directory under a live process.
// And `quitAndInstallCalled` is latched, so the update can never be retried.
//
// With a cloud open, that prompt's Cancel is both defaultId and cancelId, so
// Return or Escape lands on exactly that path.

describe('install confirmation gate', () => {
  beforeEach(loadUpdater);

  /** Drive update-downloaded with "Restart now" chosen. */
  async function restartNow(mod: any, confirm: (() => boolean) | null) {
    mod.setInstallConfirm(confirm);
    mod.setupAutoUpdater(getWindow);
    showMessageBox.mockResolvedValue({ response: 0 } as any);  // "Restart now"
    await handlers.get('update-downloaded')!({ version: '0.58.0' });
    await flush();
  }

  it('does not install when the confirm says no', async () => {
    const mod = await loadUpdater();
    await restartNow(mod, () => false);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('installs when the confirm says yes', async () => {
    const mod = await loadUpdater();
    await restartNow(mod, () => true);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('installs when no confirm is registered', async () => {
    const mod = await loadUpdater();
    await restartNow(mod, null);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('asks BEFORE installing, never after', async () => {
    const mod = await loadUpdater();
    const order: string[] = [];
    autoUpdater.quitAndInstall.mockImplementation(() => { order.push('install'); });
    await restartNow(mod, () => { order.push('confirm'); return true; });
    expect(order).toEqual(['confirm', 'install']);
    autoUpdater.quitAndInstall.mockReset();
  });

  it('leaves the update downloaded so an ordinary quit still installs it', async () => {
    const mod = await loadUpdater();
    await restartNow(mod, () => false);
    // autoInstallOnAppQuit is what picks it up later; declining must not clear
    // it or the user would have to download the update again.
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(sent.at(-1)!.payload).toEqual({ status: 'downloaded', version: '0.58.0' });
  });
});
