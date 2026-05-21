// Auto-updater wiring. Pulls release artifacts from the configured `publish`
// target in package.json (GitHub Releases by default). Falls back to a no-op
// in dev — electron-updater requires a packaged build.

import { app, dialog, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

export function setupAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) {
    console.log('[updater] dev build — skipping auto-update check.');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => console.log('[updater] checking for update...'));
  autoUpdater.on('update-available', (info) => console.log(`[updater] update available: v${info.version}`));
  autoUpdater.on('update-not-available', () => console.log('[updater] already up to date.'));
  autoUpdater.on('error', (err) => console.error('[updater] error:', err));
  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] download ${p.percent.toFixed(1)}% (${(p.bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s)`);
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

  // Fire-and-forget; failures are logged in the error handler above.
  autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed:', err));
}
