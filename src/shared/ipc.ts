// IPC channel names and payload types shared between main and preload/renderer.
// Renderer never imports `electron` directly; it uses `window.electronAPI`
// (declared in src/renderer/types/electron.d.ts), which is wired up in preload.

export const IPC = {
  // File dialogs
  DialogOpen: 'dialog:open',
  DialogSave: 'dialog:save',
  DialogMessageBox: 'dialog:messageBox',
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
  // Open a URL (https: or mailto:) in the OS default browser / mail client
  ShellOpenExternal: 'shell:openExternal',
  // Session logs
  LogsGetPath: 'logs:getPath',     // renderer -> main: path of the current log file
  LogsExport: 'logs:export',       // renderer -> main: write+reveal a combined log file
  LogWrite: 'log:write',           // renderer -> main (one-way): forward a renderer log line
  // File-drop events (main -> renderer)
  FileDropEvent: 'fileDrop:event',
  // Menu commands (main -> renderer)
  MenuCommand: 'menu:command',
  // Backend supervisor status (main -> renderer): crash/restart lifecycle
  BackendStatus: 'backend:status',
} as const;

export type BackendStatusPayload =
  // The sidecar crashed; the supervisor is respawning it on the same port.
  | { status: 'restarting'; port: number }
  // The respawned sidecar is healthy again (in-RAM sessions were lost).
  | { status: 'ready'; port: number }
  // Respawn attempts were exhausted; compute features are unavailable.
  | { status: 'failed'; port: number };

export interface BackendInfo {
  url: string;
  expectedVersion: string;
  isDev: boolean;
  /** App version (Electron app.getVersion(), reads package.json). */
  appVersion: string;
  /** OS platform: 'darwin' | 'win32' | 'linux'. */
  platform: string;
  /** PyHelios submodule version (git describe), captured at build time. */
  pyheliosVersion: string;
  /** helios-core C++ submodule version (git describe), captured at build time. */
  heliosVersion: string;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug';

export interface LogExportResult {
  /** Absolute path of the written combined log file, revealed in the OS file
   * manager. null if the user cancelled the save dialog. */
  savedPath: string | null;
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

export interface MessageBoxOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  title?: string;
  message: string;
  detail?: string;
  /** Button labels, left-to-right. Defaults to ['OK']. */
  buttons?: string[];
  /** Index of the default (Enter) button. */
  defaultId?: number;
  /** Index of the button selected when the dialog is dismissed (Esc / close). */
  cancelId?: number;
}

export interface MessageBoxResult {
  /** Index into `buttons` of the button the user clicked. */
  response: number;
}

export type FileDropPayload =
  | { kind: 'hover'; paths: string[] }
  | { kind: 'drop'; paths: string[] }
  | { kind: 'cancel' };

export type SnapViewDirection = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

export type MenuCommandPayload =
  | { kind: 'import-auto' }
  | { kind: 'import-point-cloud' }
  | { kind: 'import-mesh' }
  | { kind: 'import-skeleton' }
  | { kind: 'import-scan-xml' }
  | { kind: 'save' }
  | { kind: 'export' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'select-all' }
  | { kind: 'deselect-all' }
  | { kind: 'reset-camera' }
  | { kind: 'snap-view'; direction: SnapViewDirection }
  | { kind: 'feedback'; mode: 'bug' | 'feature' }
  | { kind: 'about' }
  | { kind: 'nav'; target: 'viewer' | 'options' };
