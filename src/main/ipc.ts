// Main-process IPC handlers backing the renderer's window.electronAPI surface.
// Mirrors the Tauri plugins the frontend currently uses: dialog, fs, store, file-drop events.

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { access, readFile, writeFile } from 'node:fs/promises';
import Store from 'electron-store';
import {
  IPC,
  type BackendInfo,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from '../shared/ipc.js';
import { EXPECTED_BACKEND_VERSION, BACKEND_PORT_DEV, BACKEND_PORT_PROD } from '../shared/constants.js';

const store = new Store({ name: 'phytograph-store' });

export function registerIpc(): void {
  ipcMain.handle(IPC.BackendGetInfo, (): BackendInfo => {
    const isDev = !app.isPackaged;
    return {
      url: `http://localhost:${isDev ? BACKEND_PORT_DEV : BACKEND_PORT_PROD}`,
      expectedVersion: EXPECTED_BACKEND_VERSION,
      isDev,
    };
  });

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
