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
  // renderer -> main (one-way): allowlist a drag-drop / file-input path so the
  // fs handlers will read it (it's a genuine user selection).
  FsAllowPath: 'fs:allowPath',
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
  // OS "Open With" file-association events (main -> renderer): paths the OS
  // handed us at launch / via a second-instance, to be auto-imported.
  OpenFiles: 'app:openFiles',
  // Renderer -> main (one-way): the renderer has mounted and can receive
  // OpenFiles. Main queues any paths that arrive before this and flushes on it.
  RendererReady: 'app:rendererReady',
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
  /**
   * True if this is the app's first launch on this machine (no persisted store
   * existed at startup). The backend's cold start is much slower the first time
   * (PyInstaller unpack + open3d/pyhelios import + macOS Gatekeeper scan), so
   * the splash uses this to show a "first launch is slower" message.
   */
  firstRun: boolean;
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

/** Paths the OS asked Phytograph to open (file association / "Open With"). */
export interface OpenFilesPayload {
  paths: string[];
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
  | { kind: 'fit-selection' }
  | { kind: 'snap-view'; direction: SnapViewDirection }
  | { kind: 'feedback'; mode: 'bug' | 'feature' }
  | { kind: 'about' }
  | { kind: 'nav'; target: 'viewer' | 'options' }
  // Run a tool from the native Tools menu by its registry id. One payload kind
  // carries every tool; the renderer dispatches via __runToolCommand (the tool
  // actions live inside PointCloudViewer's command registry).
  | { kind: 'tool'; toolId: string };
