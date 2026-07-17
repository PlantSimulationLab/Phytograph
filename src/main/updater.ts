// Auto-updater wiring. Pulls release artifacts from the configured `publish`
// target in package.json (GitHub Releases by default). Falls back to a no-op
// in dev — electron-updater requires a packaged build.

import { app, dialog, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { updaterLog } from './logger.js';

const { autoUpdater } = electronUpdater;

type GetWindow = () => BrowserWindow | null;

// Register the shared event listeners exactly once, whether the first trigger
// is the startup auto-check or a manual "Check for Updates…" click.
let listenersRegistered = false;
// Guard against overlapping manual checks stacking dialogs on double-click.
let checking = false;

function registerListeners(getWindow: GetWindow): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  autoUpdater.on('checking-for-update', () => updaterLog.info('checking for update...'));
  autoUpdater.on('update-available', (info) => updaterLog.info(`update available: v${info.version}`));
  autoUpdater.on('update-not-available', () => updaterLog.info('already up to date.'));
  autoUpdater.on('error', (err) => updaterLog.error('error:', err));
  autoUpdater.on('download-progress', (p) => {
    updaterLog.info(`download ${p.percent.toFixed(1)}% (${(p.bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s)`);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const win = getWindow();
    const choice = await dialog.showMessageBox(win ?? undefined!, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Phytograph v${info.version} is ready to install.`,
      detail: 'The app will restart to apply the update.',
    });
    if (choice.response === 0) autoUpdater.quitAndInstall();
  });
}

export function setupAutoUpdater(getWindow: GetWindow): void {
  if (!app.isPackaged) {
    updaterLog.info('dev build — skipping auto-update check.');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  registerListeners(getWindow);

  // Fire-and-forget; failures are logged in the error handler above.
  autoUpdater.checkForUpdates().catch((err) => updaterLog.error('check failed:', err));
}

// Manual "Check for Updates…" trigger from the app/Help menu. Unlike the
// startup check, this reports *every* outcome to the user via native dialogs
// (up to date / error) and asks for consent before downloading.
export async function checkForUpdatesManually(getWindow: GetWindow): Promise<void> {
  const win = getWindow();

  // electron-updater can't check in a dev build — give feedback instead of
  // silently doing nothing when the menu item is clicked.
  if (!app.isPackaged) {
    updaterLog.info('dev build — manual update check unavailable.');
    await dialog.showMessageBox(win ?? undefined!, {
      type: 'info',
      buttons: ['OK'],
      title: 'Check for Updates',
      message: 'Updates are only available in the installed app.',
      detail: 'This is a development build. Install a packaged release to receive updates.',
    });
    return;
  }

  if (checking) {
    updaterLog.info('manual check already in progress; ignoring.');
    return;
  }
  checking = true;

  // Don't auto-download on a manual check — ask the user first.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  registerListeners(getWindow);

  try {
    const result = await autoUpdater.checkForUpdates();
    const info = result?.updateInfo;
    const latest = info?.version;
    const current = app.getVersion();

    // No result, or the "latest" is not newer than what we're running.
    if (!latest || latest === current) {
      await dialog.showMessageBox(win ?? undefined!, {
        type: 'info',
        buttons: ['OK'],
        title: 'Check for Updates',
        message: "You're on the latest version.",
        detail: `Phytograph v${current} is up to date.`,
      });
      return;
    }

    const choice = await dialog.showMessageBox(win ?? undefined!, {
      type: 'info',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `Phytograph v${latest} is available.`,
      detail: `You're on v${current}. Download the update now? You'll be prompted to restart once it finishes.`,
    });
    if (choice.response === 0) {
      // The download-progress / update-downloaded listeners take over from here.
      autoUpdater.downloadUpdate().catch((err) => updaterLog.error('download failed:', err));
    }
  } catch (err) {
    updaterLog.error('manual check failed:', err);
    await dialog.showMessageBox(win ?? undefined!, {
      type: 'error',
      buttons: ['OK'],
      title: 'Check for Updates',
      message: "Couldn't check for updates.",
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    checking = false;
  }
}
