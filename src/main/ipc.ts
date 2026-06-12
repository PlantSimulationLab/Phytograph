// Main-process IPC handlers backing the renderer's window.electronAPI surface.
// Mirrors the Tauri plugins the frontend currently uses: dialog, fs, store, file-drop events.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { access, readFile, writeFile } from 'node:fs/promises';
import Store from 'electron-store';
import {
  IPC,
  type BackendInfo,
  type MessageBoxOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from '../shared/ipc.js';
import { EXPECTED_BACKEND_VERSION } from '../shared/constants.js';
import { getBackendPort } from './backend.js';
// Generated at build time by scripts/gen-version-info.mjs (gitignored).
import { PYHELIOS_VERSION, HELIOS_CORE_VERSION } from '../shared/generated/versionInfo.js';

const store = new Store({ name: 'phytograph-store' });

export function registerIpc(): void {
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
    };
  });

  // Open an https: URL in the browser or a mailto: link in the default mail
  // client. The feedback dialog uses this for both its GitHub and email paths.
  ipcMain.handle(IPC.ShellOpenExternal, (_e, url: string) => shell.openExternal(url));

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
    return opts.multi ? result.filePaths : result.filePaths[0];
  });

  ipcMain.handle(IPC.DialogSave, async (_e, opts: SaveDialogOptions = {}) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win ?? undefined!, {
      title: opts.title,
      defaultPath: opts.defaultPath,
      filters: opts.filters,
    });
    return result.canceled ? null : result.filePath ?? null;
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

  ipcMain.handle(IPC.FsReadText, async (_e, path: string) => {
    return readFile(path, 'utf-8');
  });
  ipcMain.handle(IPC.FsReadBinary, async (_e, path: string) => {
    const buf = await readFile(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
  ipcMain.handle(IPC.FsWriteText, async (_e, path: string, contents: string) => {
    await writeFile(path, contents, 'utf-8');
  });
  ipcMain.handle(IPC.FsWriteBinary, async (_e, path: string, contents: ArrayBuffer) => {
    await writeFile(path, Buffer.from(contents));
  });
  ipcMain.handle(IPC.FsExists, async (_e, path: string): Promise<boolean> => {
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
