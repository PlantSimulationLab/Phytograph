import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, stopBackend } from './backend.js';
import { registerIpc } from './ipc.js';
import { setupAutoUpdater } from './updater.js';
import { IPC, type FileDropPayload } from '../shared/ipc.js';
import { RENDERER_DEV_PORT } from '../shared/constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'Phytograph',
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    center: true,
    webPreferences: {
      preload: join(__dirname, '../dist-preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(`http://localhost:${RENDERER_DEV_PORT}`);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, '../dist-renderer/index.html'));
  }

  // Forward file-drop events into the renderer via the same IPC channel name
  // that preload exposes for subscription.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

app.whenReady().then(async () => {
  registerIpc();

  // Bridge: main can broadcast file-drop events to the focused window.
  // (No-op placeholder for now; native drag/drop happens in the renderer.
  // Wire native OS file-association open events here later.)
  ipcMain.on('__file-drop-broadcast', (_e, payload: FileDropPayload) => {
    mainWindow?.webContents.send(IPC.FileDropEvent, payload);
  });

  await startBackend();
  createWindow();
  setupAutoUpdater(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopBackend();
});
