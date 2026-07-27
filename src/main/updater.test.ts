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

vi.mock('electron', () => ({
  app,
  dialog: { showMessageBox: (win: any, opts: any) => showMessageBox(win, opts) },
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
