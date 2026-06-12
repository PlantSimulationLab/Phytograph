import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, stopBackend } from './backend.js';
import { registerIpc } from './ipc.js';
import { installApplicationMenu } from './menu.js';
import { setupAutoUpdater } from './updater.js';
import { IPC, type FileDropPayload } from '../shared/ipc.js';
import { RENDERER_DEV_PORT } from '../shared/constants.js';
import { registerOctreeSchemeAsPrivileged, registerOctreeProtocol } from './octreeProtocol.js';

// Must run before app.whenReady(). `protocol.registerSchemesAsPrivileged` is
// a once-per-process call that has to be made while the protocol module is
// still configurable. Late registration is a silent no-op.
registerOctreeSchemeAsPrivileged();

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cap the initial window on very large monitors so the app doesn't open at 5K.
// Matches the HeliosGUI reference (Dropbox/HeliosGUI_mockup/heliosgui-desktop/electron/main.ts).
const MAX_W = 1920;
const MAX_H = 1080;

// Resolve the BrowserWindow icon. macOS ignores this (Dock uses .icns from the
// app bundle), so we only really care about Windows (.ico) and Linux (.png).
// In dev, build/ lives at the repo root, one level above the compiled dist-main/.
// In packaged builds, build/icon.{png,ico} is shipped via extraResources to
// process.resourcesPath/build/.
function resolveIconPath(): string {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return app.isPackaged
    ? join(process.resourcesPath, 'build', file)
    : join(__dirname, '../build', file);
}

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

// In dev, the running binary is node_modules/electron/dist/Electron.app, whose
// Info.plist labels the macOS menu bar "Electron" and ships the generic
// Electron .icns. Override both so dev runs feel like the real app — packaged
// builds already get this right via electron-builder's productName + icon.
// (Skip under E2E: tests assume an inert chrome.)
if (!isE2E) {
  app.setName('Phytograph');
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  // E2E tests assume a known, stable 1200x800 window. The display-aware sizing
  // below would otherwise make pixel coordinates depend on the test machine's
  // monitor — that's not acceptable for the Playwright suite.
  let winWidth = 1200;
  let winHeight = 800;
  let shouldMaximize = false;
  if (!isE2E) {
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;
    if (screenW <= MAX_W && screenH <= MAX_H) {
      winWidth = screenW;
      winHeight = screenH;
      shouldMaximize = true;
    } else {
      winWidth = Math.min(screenW, MAX_W);
      winHeight = Math.min(screenH, MAX_H);
    }
  }

  mainWindow = new BrowserWindow({
    title: 'Phytograph',
    width: winWidth,
    height: winHeight,
    minWidth: 900,
    minHeight: 600,
    center: true,
    icon: resolveIconPath(),
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

  if (shouldMaximize) mainWindow.maximize();

  // Under E2E, the Vite dev server isn't running — load the prebuilt
  // renderer from dist-renderer just like production would. (npm run
  // build is a prereq for the E2E suite; see CLAUDE.md.)
  if (isDev && !isE2E) {
    // scripts/dev.mjs picks a free renderer port per session and passes it via
    // PHYTOGRAPH_RENDERER_PORT; fall back to the constant for a bare electron run.
    const rendererPort = Number(process.env.PHYTOGRAPH_RENDERER_PORT) || RENDERER_DEV_PORT;
    mainWindow.loadURL(`http://localhost:${rendererPort}`);
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
  // Override the dev Dock icon (node_modules/electron ships generic Electron
  // artwork). icon-dock.png pads the logo into a 1024x1024 canvas at the
  // ~80% safe-area size macOS expects, so it doesn't appear oversized next
  // to system apps. On packaged builds the .icns from the bundle wins;
  // calling setIcon there is harmless.
  if (!isE2E && process.platform === 'darwin' && app.dock) {
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'build', 'icon-dock.png')
      : join(__dirname, '../build/icon-dock.png');
    app.dock.setIcon(iconPath);
  }

  registerIpc();
  registerOctreeProtocol();
  installApplicationMenu(() => mainWindow);

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
