// Main-process IPC handlers backing the renderer's window.electronAPI surface.
// Mirrors the Tauri plugins the frontend currently uses: dialog, fs, store, file-drop events.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { access, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Store from 'electron-store';
import {
  IPC,
  type BackendInfo,
  type LogExportResult,
  type LogLevel,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from '../shared/ipc.js';
import { EXPECTED_BACKEND_VERSION } from '../shared/constants.js';
import { getBackendPort } from './backend.js';
import { allowPath, isPathAllowed, isWriteAllowed } from './fsAllowlist.js';
import { copySessionLogTo, getLogFilePath, logFromRenderer } from './logger.js';
// Generated at build time by scripts/gen-version-info.mjs (gitignored).
import { PYHELIOS_VERSION, HELIOS_CORE_VERSION } from '../shared/generated/versionInfo.js';

// Capture first-run BEFORE instantiating Store (which creates the file): if the
// store JSON didn't exist yet, this is the first launch on this machine. Used to
// tell the splash the first cold start is slower. Computed once at module load.
const isFirstRun = !existsSync(join(app.getPath('userData'), 'phytograph-store.json'));

const store = new Store({ name: 'phytograph-store' });

// Private per-instance scratch dir for materialized drag-drop imports (see
// FsWriteTempBinary). Unique per process so concurrent app instances never
// clobber each other; removed on quit by cleanupTempImports().
const tempImportDir = join(app.getPath('temp'), `phytograph-imports-${process.pid}`);

function cleanupTempImports(): void {
  // Best-effort: a stale dir on a crash is harmless (OS temp gets reaped) and
  // the pid-scoping means we never delete a sibling instance's in-use files.
  rm(tempImportDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
}

export function registerIpc(): void {
  // Drop materialized-import scratch files when this instance exits.
  app.on('will-quit', cleanupTempImports);


  ipcMain.handle(IPC.BackendGetInfo, (): BackendInfo => {
    const isDev = !app.isPackaged;
    return {
      // The actual port this instance's backend was started on (dynamic,
      // per-instance). This is the renderer's source of truth — getBackendUrl()
      // in the renderer fetches this once at startup and caches it.
      url: `http://127.0.0.1:${getBackendPort()}`,
      expectedVersion: EXPECTED_BACKEND_VERSION,
      isDev,
      appVersion: app.getVersion(),
      platform: process.platform,
      pyheliosVersion: PYHELIOS_VERSION,
      heliosVersion: HELIOS_CORE_VERSION,
      firstRun: isFirstRun,
    };
  });

  // Open an https: URL in the browser or a mailto: link in the default mail
  // client. The feedback dialog uses this for both its GitHub and email paths.
  ipcMain.handle(IPC.ShellOpenExternal, (_e, url: string) => shell.openExternal(url));

  // Session logs ----------------------------------------------------------
  // One-way forward of a renderer console/error line into the unified log file.
  ipcMain.on(IPC.LogWrite, (_e, level: LogLevel, message: string) => {
    logFromRenderer(level, message);
  });

  ipcMain.handle(IPC.LogsGetPath, (): string => getLogFilePath());

  // Write a combined (main+renderer+backend) log file to `destPath` (the
  // renderer picks it via the normal dialog.save() IPC first, matching how
  // exports work elsewhere), then reveal it in the OS file manager so the user
  // can drag it into a GitHub issue / email — external URLs can't carry
  // attachments. A null destPath (user cancelled the save dialog) is a no-op.
  ipcMain.handle(
    IPC.LogsExport,
    async (_e, destPath: string | null): Promise<LogExportResult> => {
      if (!destPath) return { savedPath: null };
      await copySessionLogTo(destPath);
      // Reveal the written file in the OS file manager so the user can drag it
      // into a GitHub issue / email. SKIP under E2E: on a headless CI runner
      // (Linux + xvfb, no desktop session) showItemInFolder blocks on a
      // D-Bus/xdg file-manager launch that never returns, wedging the main
      // process so the app can't quit — the "Attach session logs" E2E test then
      // hung its whole 180s teardown. This reveal is a convenience, not part of
      // the export's correctness (the file is already written above), so
      // dropping it in tests changes nothing the test asserts.
      if (process.env.PHYTOGRAPH_E2E !== '1') {
        shell.showItemInFolder(destPath);
      }
      return { savedPath: destPath };
    },
  );

  ipcMain.handle(IPC.DialogOpen, async (_e, opts: OpenDialogOptions = {}) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
      properties: opts.directory
        ? ['openDirectory', 'createDirectory']
        : opts.multi
        ? ['openFile', 'multiSelections']
        : ['openFile'],
    });
    if (result.canceled) return null;
    // Whatever the user picked is now allowed. A chosen directory authorizes
    // writes to its direct children (export-to-folder flows); chosen files are
    // allowed for reads.
    const kind = opts.directory ? 'directory' : 'file';
    for (const p of result.filePaths) allowPath(p, kind);
    return opts.multi ? result.filePaths : result.filePaths[0];
  });

  ipcMain.handle(IPC.DialogSave, async (_e, opts: SaveDialogOptions = {}) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
    });
    if (result.canceled || !result.filePath) return null;
    // The user chose this save target; allow the write to it AND to sibling
    // files in the same folder (the scan exporter writes backend-named files
    // next to the chosen path).
    allowPath(result.filePath, 'saveFile');
    return result.filePath;
  });

  ipcMain.handle(IPC.DialogMessageBox, async (_e, opts: MessageBoxOptions) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showMessageBox(win ?? undefined!, {
      type: opts.type ?? 'none',
      title: opts.title,
      message: opts.message,
      detail: opts.detail,
      buttons: opts.buttons ?? ['OK'],
      defaultId: opts.defaultId,
      cancelId: opts.cancelId,
    });
    return { response: result.response };
  });

  // One-way: the renderer reports a path it obtained from a native drag-drop or
  // <input type=file> (resolved via webUtils.getPathForFile in preload). That's
  // a genuine user selection, so allowlist it before the renderer reads it.
  ipcMain.on(IPC.FsAllowPath, (_e, path: string) => {
    if (typeof path === 'string') allowPath(path);
  });

  // The fs handlers enforce the "user-selected paths only" contract: a path is
  // readable/writable only if it was returned by a dialog or reported via
  // FsAllowPath. This prevents a compromised renderer from reaching arbitrary
  // files (e.g. ~/.ssh/id_rsa) through the bridge.
  const denyRead = (path: string): void => {
    if (!isPathAllowed(path)) {
      throw new Error(`fs access denied: "${path}" is not a user-selected path`);
    }
  };
  const denyWrite = (path: string): void => {
    if (!isWriteAllowed(path)) {
      throw new Error(`fs write denied: "${path}" is not a user-selected path`);
    }
  };

  ipcMain.handle(IPC.FsReadText, async (_e, path: string) => {
    denyRead(path);
    return readFile(path, 'utf-8');
  });
  ipcMain.handle(IPC.FsReadBinary, async (_e, path: string) => {
    denyRead(path);
    const buf = await readFile(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
  ipcMain.handle(IPC.FsWriteText, async (_e, path: string, contents: string) => {
    denyWrite(path);
    await writeFile(path, contents, 'utf-8');
  });
  ipcMain.handle(IPC.FsWriteBinary, async (_e, path: string, contents: ArrayBuffer) => {
    denyWrite(path);
    await writeFile(path, Buffer.from(contents));
  });
  // Materialize a dropped File's bytes into a private per-instance temp dir and
  // return the absolute path, allowlisted for the fs handlers + the backend's
  // path-backed import. This is what lets a dragged point cloud with no
  // resolvable OS path (cloud-storage placeholder, drag from a non-file source)
  // still take the octree import path instead of the flat fallback. The dir is
  // unique per process (so concurrent instances never clobber each other) and
  // removed on quit (see cleanupTempImports below). `fileName` is preserved so
  // the backend's format detection sees the right extension.
  ipcMain.handle(IPC.FsWriteTempBinary, async (_e, fileName: string, contents: ArrayBuffer): Promise<string> => {
    // Each drop lands in its own uuid subdir so the file keeps its ORIGINAL
    // basename — that basename becomes the cloud's fileName / scan label and the
    // backend's format-detection extension, and per-drop subdirs avoid collisions
    // when the same filename is dropped twice.
    const safeName = String(fileName).replace(/[/\\]/g, '_') || 'dropped.xyz';
    const dir = join(tempImportDir, randomUUID());
    await mkdir(dir, { recursive: true });
    const target = join(dir, safeName);
    await writeFile(target, Buffer.from(contents));
    allowPath(target, 'saveFile');  // readable + writable for downstream fs/import
    return target;
  });
  ipcMain.handle(IPC.FsExists, async (_e, path: string): Promise<boolean> => {
    // The scan-file resolver probes candidate companion paths here. Report a
    // non-authorized path as simply "not found" rather than throwing — that
    // doesn't leak existence of arbitrary files (always false) and lets the
    // resolver fall through to its "Locate…" prompt for anything outside the
    // selected file's folder (e.g. its cwd fallback candidate).
    if (!isPathAllowed(path) && !isWriteAllowed(path)) {
      return false;
    }
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC.AppGetCwd, (): string => process.cwd());

  ipcMain.handle(IPC.StoreGet, (_e, key: string) => store.get(key));
  ipcMain.handle(IPC.StoreSet, (_e, key: string, value: unknown) => {
    store.set(key, value);
  });
  ipcMain.handle(IPC.StoreDelete, (_e, key: string) => {
    store.delete(key);
  });
}
