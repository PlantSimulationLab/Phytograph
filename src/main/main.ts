import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend, stopBackend, setBackendWindowGetter, setBackendFailedHandler } from './backend.js';
import { registerIpc } from './ipc.js';
import { installApplicationMenu } from './menu.js';
import { setupAutoUpdater } from './updater.js';
import { IPC, type FileDropPayload } from '../shared/ipc.js';
import { RENDERER_DEV_PORT, IMPORTABLE_EXTENSIONS } from '../shared/constants.js';
import { registerOctreeSchemeAsPrivileged, registerOctreeProtocol } from './octreeProtocol.js';
import { initLogging, getLogDir, setFatalErrorHandler } from './logger.js';
import { installCrashHandlers, showBackendFailedDialog, showFatalMainErrorDialog } from './crashDialog.js';
import {
  initCrashReporter,
  checkPreviousSession,
  markSessionStarted,
  clearCleanShutdownMarker,
  installCleanShutdownSignals,
} from './postMortem.js';

// Configure the unified session log before anything else logs. This also patches
// the main-process console.* onto the file transport, so every console.log below
// is persisted, and installs the uncaught-exception handler.
initLogging();
// Tell the spawned Python sidecar where to write its own rotating log file, so
// it lands next to the electron-log file and can be concatenated on export.
process.env.PHYTOGRAPH_LOG_DIR = getLogDir();

// Arm native crash capture as early as possible — Crashpad runs in a separate
// OS process and captures a minidump even if the MAIN process dies natively
// (segfault/OOM), which no in-process handler can survive. Local-only (no
// upload); surfaced on the next launch by checkPreviousSession(). Must precede
// app.whenReady() so it's armed before anything can crash.
initCrashReporter();

// Ctrl+C in the dev terminal (SIGINT) and OS-requested quit (SIGTERM) don't run
// app's 'before-quit', so without this the clean-shutdown marker would survive
// and the NEXT launch would wrongly report a crash. Treat both as intentional:
// clear the marker + stop the backend, then exit 0. (SIGKILL / native crashes
// stay uncatchable and correctly trip the post-mortem path.)
installCleanShutdownSignals(stopBackend);

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

// ── OS "Open With" / file-association handling ─────────────────────────────
// The OS can hand us files three ways: macOS fires 'open-file'; Windows/Linux
// pass paths in argv on a cold launch, and deliver a second launch's argv to
// the already-running first instance via 'second-instance'. All funnel into
// handleOpenPaths(), which queues anything that arrives before the renderer is
// ready (the window/backend take ~10-20s) and flushes on IPC.RendererReady.

// Single-instance lock: the user's chosen behavior is "import into the existing
// window" rather than spawning a second app (each would launch its own Python
// backend). Skipped under E2E — the Playwright suite launches several apps that
// all run `electron .` from the same userData dir, so a lock would make every
// app after the first quit immediately and break the suite.
if (!isE2E) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    // Another instance owns the lock; it will receive our argv via
    // 'second-instance'. Quit this one immediately.
    app.quit();
  }
}

let pendingOpenPaths: string[] = [];
let rendererReady = false;

function isImportablePath(p: string): boolean {
  const ext = p.toLowerCase().split('.').pop() ?? '';
  return (IMPORTABLE_EXTENSIONS as readonly string[]).includes(ext);
}

// Extract importable file paths from a process argv array. The executable and
// any leading `electron .`/flag tokens are not files; in dev, argv also includes
// the entry script path. Filtering to known importable extensions + existence on
// disk is a robust, platform-agnostic way to pick out genuine file arguments.
function extractFilePathsFromArgv(argv: string[]): string[] {
  return argv.filter((a) => !a.startsWith('-') && isImportablePath(a) && existsSync(a));
}

function handleOpenPaths(paths: string[]): void {
  const importable = paths.filter(isImportablePath);
  if (importable.length === 0) return;
  if (rendererReady && mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send(IPC.OpenFiles, { paths: importable });
  } else {
    // Window/backend not up yet — queue; flushed on IPC.RendererReady.
    pendingOpenPaths.push(...importable);
  }
}

// macOS delivers file-association opens here. Register at top level (not inside
// whenReady) because on a cold launch macOS can fire this before the app is
// ready; queuing handles that. e.preventDefault() tells Electron we handled it.
app.on('open-file', (e, path) => {
  e.preventDefault();
  handleOpenPaths([path]);
});

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

  // Surface hard crashes (native renderer/GPU death that React's ErrorBoundary
  // can't catch) as a native dialog that points at the RIGHT log and can reload
  // the renderer in place — the backend (and its in-RAM data) survives a
  // renderer crash, so a reload can recover the session. Suppressed under E2E,
  // where a native modal would hang the Playwright driver. See crashDialog.ts.
  if (!isE2E) installCrashHandlers(mainWindow, reloadRenderer);
}

/**
 * Recover the renderer after a crash. If the window is still alive (e.g. backend
 * 'failed', or a renderer crash that left the BrowserWindow intact) reload it;
 * otherwise recreate it. The backend is left running — startBackend() already
 * reuses a healthy sidecar on the same port, so a reload re-runs the renderer's
 * initBackendUrl() against the existing (or respawning) backend.
 */
function reloadRenderer(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.reload();
  } else {
    createWindow();
  }
}

/**
 * Recovery for the backend-'failed' case: the supervisor gave up restarting the
 * sidecar, so a bare renderer reload wouldn't bring compute back. Re-arm and
 * restart the backend, then reload the renderer (which re-runs initBackendUrl
 * against the freshly spawned sidecar on the same port).
 */
async function restartBackendAndReload(): Promise<void> {
  try {
    await startBackend();
  } catch (e) {
    console.error('[main] backend restart after failure threw:', e);
  }
  reloadRenderer();
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

  setBackendWindowGetter(() => mainWindow);
  // When the sidecar exhausts its restart budget, the renderer already gets a
  // toast (App.tsx); also pop the native crash dialog so the user gets the
  // log/report/reload actions, not just a dismissable toast. Suppressed under
  // E2E (a native modal would hang the Playwright driver).
  if (!isE2E) setBackendFailedHandler(() => showBackendFailedDialog(restartBackendAndReload));

  // Kick off the backend's (slow, ~10-20s cold) start NOW, before the synchronous
  // post-mortem dialog below — otherwise that modal blocks the event loop and the
  // sidecar doesn't even begin spawning until the user dismisses it. We await the
  // promise after the dialog so startup still completes before the window opens.
  const backendStarting = startBackend();

  // Post-mortem: detect whether the PREVIOUS session crashed (a native main-
  // process death no live handler can catch) and, if so, surface a recovery
  // dialog. MUST run before markSessionStarted() — it reads the old marker — and
  // is skipped under E2E (a native modal would hang Playwright). Then mark THIS
  // session as running; the marker is cleared on a clean quit (before-quit).
  if (!isE2E) checkPreviousSession();
  markSessionStarted();

  // Bridge: main can broadcast file-drop events to the focused window.
  // (No-op placeholder for now; native drag/drop happens in the renderer.)
  ipcMain.on('__file-drop-broadcast', (_e, payload: FileDropPayload) => {
    mainWindow?.webContents.send(IPC.FileDropEvent, payload);
  });

  // OS "Open With": the renderer signals it has mounted and can receive imports.
  // Mark ready and flush any paths the OS handed us before the window was up.
  ipcMain.on(IPC.RendererReady, () => {
    rendererReady = true;
    if (pendingOpenPaths.length > 0 && mainWindow) {
      mainWindow.webContents.send(IPC.OpenFiles, { paths: pendingOpenPaths });
      pendingOpenPaths = [];
    }
  });

  // Windows/Linux: a second launch (e.g. double-clicking a file while the app is
  // already running) delivers its argv here, to the first instance. Focus the
  // existing window and import. (Never fires under the E2E no-lock path.)
  app.on('second-instance', (_e, argv) => {
    handleOpenPaths(extractFilePathsFromArgv(argv));
  });

  // Windows/Linux cold launch: file paths arrive in this process's argv. macOS
  // uses 'open-file' instead, so this is a no-op there. Gate on isPackaged so a
  // dev `electron .` run doesn't misread its own entry-script path as a file.
  if (app.isPackaged) {
    handleOpenPaths(extractFilePathsFromArgv(process.argv));
  }

  // Give the supervisor a way to reach the renderer with crash/restart status.
  // (Safe to set before the window exists: emitBackendStatus no-ops on null.)
  // A fatal uncaught exception in main can only show a dialog while the process
  // is still alive — so register the handler now (after app.whenReady, since
  // dialog.showMessageBoxSync needs the app ready). A crash before this point
  // falls back to logger.ts's plain log+exit. Suppressed under E2E (a native
  // modal would hang the Playwright driver).
  if (!isE2E) setFatalErrorHandler(showFatalMainErrorDialog);

  await backendStarting;
  createWindow();
  setupAutoUpdater(() => mainWindow);

  // macOS: closing the window doesn't quit the app (window-all-closed only
  // quits off-darwin), and window-all-closed calls stopBackend() — so the
  // sidecar is gone by the time the user reopens via the Dock. Reopening fires
  // 'activate'; if we only recreated the window the renderer would poll a dead
  // backend for the full splash timeout and fail. So restart the backend too.
  // startBackend() is idempotent (it reuses a healthy backend on its port and
  // only spawns when none answers), so calling it again is safe and cheap.
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // Reopening after the window was closed starts a fresh live session;
      // window-all-closed cleared the marker, so re-arm it to catch a crash in
      // this new session.
      markSessionStarted();
      await startBackend();
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  // Closing the last window is a clean, deliberate end of the session — clear
  // the marker NOW. On macOS the app stays alive after the window closes (we
  // don't quit on darwin), so 'before-quit' won't run until the process is
  // later terminated, and that termination often comes as a SIGINT/SIGTERM from
  // the dev terminal whose JS handler doesn't reliably run before Electron's
  // native signal teardown — leaving the marker behind and making the NEXT
  // launch falsely report a crash. Clearing here means the marker is already
  // gone by the time the user Ctrl+C's `npm run dev`, regardless of how the
  // process ultimately dies. markSessionStarted() rewrites it if the user
  // reopens a window via the Dock ('activate'), so a genuine later crash is
  // still caught.
  clearCleanShutdownMarker();
  // Under E2E, always quit — even on darwin — so Playwright's app.close()
  // actually causes process exit and the next spec doesn't race the
  // previous Electron's teardown (which on macOS can briefly flash a
  // window). Refs: playwright#20016, playwright#12189.
  if (process.platform !== 'darwin' || isE2E) app.quit();
});

app.on('before-quit', () => {
  stopBackend();
  // A clean quit reached this handler — remove the marker so the next launch
  // knows the session ended normally. (A crash/SIGKILL never gets here, so the
  // marker survives and checkPreviousSession() detects the unclean exit.)
  clearCleanShutdownMarker();
});
