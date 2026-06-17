import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  IPC,
  type BackendInfo,
  type BackendStatusPayload,
  type FileDropPayload,
  type LogExportResult,
  type LogLevel,
  type MenuCommandPayload,
  type MessageBoxOptions,
  type MessageBoxResult,
  type OpenDialogOptions,
  type OpenFilesPayload,
  type SaveDialogOptions,
} from '../shared/ipc.js';

const api = {
  backend: {
    getInfo: (): Promise<BackendInfo> => ipcRenderer.invoke(IPC.BackendGetInfo),
  },
  dialog: {
    open: (opts?: OpenDialogOptions): Promise<string | string[] | null> =>
      ipcRenderer.invoke(IPC.DialogOpen, opts),
    save: (opts?: SaveDialogOptions): Promise<string | null> =>
      ipcRenderer.invoke(IPC.DialogSave, opts),
    messageBox: (opts: MessageBoxOptions): Promise<MessageBoxResult> =>
      ipcRenderer.invoke(IPC.DialogMessageBox, opts),
  },
  fs: {
    readText: (path: string): Promise<string> => ipcRenderer.invoke(IPC.FsReadText, path),
    readBinary: (path: string): Promise<ArrayBuffer> => ipcRenderer.invoke(IPC.FsReadBinary, path),
    writeText: (path: string, contents: string): Promise<void> =>
      ipcRenderer.invoke(IPC.FsWriteText, path, contents),
    writeBinary: (path: string, contents: ArrayBuffer): Promise<void> =>
      ipcRenderer.invoke(IPC.FsWriteBinary, path, contents),
    exists: (path: string): Promise<boolean> => ipcRenderer.invoke(IPC.FsExists, path),
  },
  app: {
    getCwd: (): Promise<string> => ipcRenderer.invoke(IPC.AppGetCwd),
  },
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.ShellOpenExternal, url),
  },
  logs: {
    // Write a combined main+renderer+backend log file to `destPath` and reveal
    // it in the OS file manager. The caller picks destPath via dialog.save()
    // first (pass null to no-op on cancel). Returns the saved path or null.
    export: (destPath: string | null): Promise<LogExportResult> =>
      ipcRenderer.invoke(IPC.LogsExport, destPath),
    getPath: (): Promise<string> => ipcRenderer.invoke(IPC.LogsGetPath),
    // Fire-and-forget forward of a renderer log line into the unified file.
    write: (level: LogLevel, message: string): void =>
      ipcRenderer.send(IPC.LogWrite, level, message),
  },
  store: {
    get: <T = unknown>(key: string): Promise<T | undefined> => ipcRenderer.invoke(IPC.StoreGet, key),
    set: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke(IPC.StoreSet, key, value),
    delete: (key: string): Promise<void> => ipcRenderer.invoke(IPC.StoreDelete, key),
  },
  // Resolves the absolute path of a File obtained from a native drag-drop or
  // <input type="file"> in the renderer. Replaces the deprecated File.path.
  // Also allowlists the path in main so the fs IPC handlers will read it — this
  // is a genuine user selection (the user dragged/picked the file).
  getPathForFile: (file: File): string => {
    const path = webUtils.getPathForFile(file);
    if (path) ipcRenderer.send(IPC.FsAllowPath, path);
    return path;
  },
  onFileDrop: (handler: (payload: FileDropPayload) => void): (() => void) => {
    const listener = (_e: unknown, payload: FileDropPayload) => handler(payload);
    ipcRenderer.on(IPC.FileDropEvent, listener);
    return () => ipcRenderer.removeListener(IPC.FileDropEvent, listener);
  },
  onMenuCommand: (handler: (payload: MenuCommandPayload) => void): (() => void) => {
    const listener = (_e: unknown, payload: MenuCommandPayload) => handler(payload);
    ipcRenderer.on(IPC.MenuCommand, listener);
    return () => ipcRenderer.removeListener(IPC.MenuCommand, listener);
  },
  // OS "Open With" / file-association events: main hands us the paths the OS
  // asked Phytograph to open, to be auto-imported by the renderer.
  onOpenFiles: (handler: (payload: OpenFilesPayload) => void): (() => void) => {
    const listener = (_e: unknown, payload: OpenFilesPayload) => handler(payload);
    ipcRenderer.on(IPC.OpenFiles, listener);
    return () => ipcRenderer.removeListener(IPC.OpenFiles, listener);
  },
  // Tell main the renderer has mounted and can receive OpenFiles; main flushes
  // any paths queued before this (the window/backend take ~10-20s to come up).
  notifyRendererReady: (): void => ipcRenderer.send(IPC.RendererReady),
  onBackendStatus: (handler: (payload: BackendStatusPayload) => void): (() => void) => {
    const listener = (_e: unknown, payload: BackendStatusPayload) => handler(payload);
    ipcRenderer.on(IPC.BackendStatus, listener);
    return () => ipcRenderer.removeListener(IPC.BackendStatus, listener);
  },
};

export type ElectronAPI = typeof api;

contextBridge.exposeInMainWorld('electronAPI', api);
