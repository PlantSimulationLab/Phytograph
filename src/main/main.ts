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
// PHYTOGRAPH_E2E=1 is set by the Playwright launcher (tests/e2e/helpers/launchApp.ts):
//   - window starts hidden, unfocusable, off the taskbar/Window menu
//   - app registers as a macOS "accessory" (no Dock tile, no menu bar, no
//     foreground activation), eliminating window/dock flashes between specs
//   - devtools are suppressed even though Electron sees `isDev=true`
//   - app.quit() is invoked on window-all-closed even on darwin, so each
//     spec's app.close() actually exits the process and doesn't race the
//     next spec's launch
// PHYTOGRAPH_DEVTOOLS=1 is the opt-in to get the detached devtools window back
//   during `npm run dev`. It's a no-op under E2E.
const isE2E = process.env.PHYTOGRAPH_E2E === '1';
const wantDevTools = process.env.PHYTOGRAPH_DEVTOOLS === '1' && !isE2E;

// MUST run synchronously at module top-level (before app.whenReady()) so the
// process never registers as a regular GUI app. 'accessory' = no Dock, no
// menu bar, no Cmd-Tab, no automatic activation. Renderer windows can still
// be created and driven by Playwright over CDP.
// Refs: https://www.electronjs.org/docs/latest/api/app#appsetactivationpolicypolicy-macos
//       https://github.com/electron/electron/issues/21970
if (isE2E && process.platform === 'darwin') {
  app.setActivationPolicy('accessory');
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'Phytograph',
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    center: true,
    // E2E invisibility stack:
    //   show:false        — never display the window
    //   skipTaskbar:true  — also keeps it out of the macOS Window menu
    // We intentionally LEAVE focusable at its default `true`. Setting
    // focusable:false on macOS interferes with Playwright's CDP click
    // delivery (the renderer never receives the synthetic events), so the
    // app.setActivationPolicy('accessory') call above is doing the
    // heavy lifting for focus-stealing prevention instead.
    show: !isE2E,
    skipTaskbar: isE2E,
    webPreferences: {
      preload: join(__dirname, '../dist-preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Under E2E, the Vite dev server isn't running — load the prebuilt
  // renderer from dist-renderer just like production would. (npm run
  // build is a prereq for the E2E suite; see CLAUDE.md.)
  if (isDev && !isE2E) {
    mainWindow.loadURL(`http://localhost:${RENDERER_DEV_PORT}`);
    if (wantDevTools) mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, '../dist-renderer/index.html'));
  }

  // Insurance: if anything tries to open devtools under E2E, slam it shut.
  if (isE2E) {
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow?.webContents.closeDevTools();
    });
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
  // Under E2E, always quit — even on darwin — so Playwright's app.close()
  // actually causes process exit and the next spec doesn't race the
  // previous Electron's teardown (which on macOS can briefly flash a
  // window). Refs: playwright#20016, playwright#12189.
  if (process.platform !== 'darwin' || isE2E) app.quit();
});

app.on('before-quit', () => {
  stopBackend();
});
