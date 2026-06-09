// IPC channel names and payload types shared between main and preload/renderer.
// Renderer never imports `electron` directly; it uses `window.electronAPI`
// (declared in src/renderer/types/electron.d.ts), which is wired up in preload.

export const IPC = {
  // File dialogs
  DialogOpen: 'dialog:open',
  DialogSave: 'dialog:save',
  // Filesystem (user-selected paths only)
  FsReadText: 'fs:readText',
  FsReadBinary: 'fs:readBinary',
  FsWriteText: 'fs:writeText',
  FsWriteBinary: 'fs:writeBinary',
  FsExists: 'fs:exists',
  // App info
  AppGetCwd: 'app:getCwd',
  // Persistent key/value store
  StoreGet: 'store:get',
  StoreSet: 'store:set',
  StoreDelete: 'store:delete',
  // Backend info
  BackendGetInfo: 'backend:getInfo',
  // File-drop events (main -> renderer)
  FileDropEvent: 'fileDrop:event',
  // Menu commands (main -> renderer)
  MenuCommand: 'menu:command',
} as const;

export interface BackendInfo {
  url: string;
  expectedVersion: string;
  isDev: boolean;
}

export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
  multi?: boolean;
  // Pick a directory instead of file(s). Returns the chosen folder path string.
  directory?: boolean;
}

export interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export type FileDropPayload =
  | { kind: 'hover'; paths: string[] }
  | { kind: 'drop'; paths: string[] }
  | { kind: 'cancel' };

export type SnapViewDirection = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

export type MenuCommandPayload =
  | { kind: 'import-point-cloud' }
  | { kind: 'import-mesh' }
  | { kind: 'import-skeleton' }
  | { kind: 'save' }
  | { kind: 'export' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'select-all' }
  | { kind: 'deselect-all' }
  | { kind: 'reset-camera' }
  | { kind: 'snap-view'; direction: SnapViewDirection }
  | { kind: 'nav'; target: 'viewer' | 'options' };
