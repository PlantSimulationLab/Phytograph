// Central logging for the main process, backed by electron-log.
//
// Why this exists: until now nothing in Phytograph was written to disk — every
// log line (main, the Python sidecar, the renderer) went to stdout/stderr or the
// DevTools console and vanished when the process exited. In a packaged build the
// user has no terminal, so a crashed import or a backend 500 left no trace. This
// module gives the app ONE rotating session log on disk that all three processes
// feed into, so a bug report can carry something diagnosable.
//
// Layout of the unified file (default electron-log path):
//   macOS:   ~/Library/Logs/Phytograph/main.log
//   Windows: %APPDATA%\Phytograph\logs\main.log
//   Linux:   ~/.config/Phytograph/logs/main.log
// Scopes tag each line by origin: [main], [backend], [renderer], [updater].
//
// The Python backend ALSO writes its own rotating file (see backend_wrapper.py)
// at PHYTOGRAPH_LOG_DIR — that's belt-and-suspenders: the sidecar's stdout/stderr
// is teed into this file by backend.ts, but the backend's own file survives even
// if the tee misses a partial line, and is concatenated on export.

import electronLog from 'electron-log/main.js';
import { app } from 'electron';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug';

let initialized = false;

/**
 * Configure electron-log once. Idempotent — safe to call from multiple entry
 * points. Must run before the first log call (init it at the top of main.ts).
 */
export function initLogging(): void {
  if (initialized) return;
  initialized = true;

  // File transport: rotate at 5 MB, archive the previous file alongside.
  electronLog.transports.file.level = 'info';
  electronLog.transports.file.maxSize = 5 * 1024 * 1024;
  electronLog.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}';
  // Console transport stays on in dev so `npm run dev` still shows everything in
  // the terminal; quiet it in packaged builds (nothing reads stdout there).
  electronLog.transports.console.level = app.isPackaged ? false : 'info';

  // Route main-process console.* through electron-log so existing console.log
  // calls in main.ts/octreeProtocol.ts/etc. also land in the file without
  // touching every call site. (Renderer console is forwarded separately over IPC.)
  electronLog.initialize?.();
  Object.assign(console, electronLog.functions);

  // Crash safety: previously an uncaught exception in main terminated the
  // process with no record. electron-log installs process.on('uncaughtException')
  // + 'unhandledRejection' listeners — which SUPPRESSES Node's default
  // print-and-exit-1. We restore the exit for a genuine uncaught EXCEPTION
  // (errorName 'Unhandled' — main is likely in a corrupted state, don't soldier
  // on), but deliberately do NOT exit on an unhandled promise REJECTION
  // (errorName 'Unhandled rejection'), which is usually a stray async error the
  // app can survive. Either way the error is logged first. The file transport
  // is synchronous (sync:true), so the line is on disk before process.exit.
  // Returning false stops electron-log from logging it a second time.
  electronLog.errorHandler.startCatching({
    showDialog: false,
    onError: ({ error, errorName }) => {
      electronLog.scope('main').error(`${errorName}:`, error);
      if (errorName !== 'Unhandled rejection') {
        process.exit(1);
      }
      return false;
    },
  });
}

/** The configured root logger (scope: none / [main] semantics via console). */
export const log = electronLog;

/** Scoped loggers for the non-main streams that feed the same file. */
export const backendLog = electronLog.scope('backend');
export const rendererLog = electronLog.scope('renderer');
export const updaterLog = electronLog.scope('updater');

/** Absolute path of the current session's main log file. */
export function getLogFilePath(): string {
  return electronLog.transports.file.getFile().path;
}

/** Directory holding the log files — handed to the Python sidecar via env. */
export function getLogDir(): string {
  return dirname(getLogFilePath());
}

/** Write one line from the renderer into the unified file under [renderer]. */
export function logFromRenderer(level: LogLevel, message: string): void {
  const fn = rendererLog[level] ?? rendererLog.info;
  fn(message);
}

/**
 * Assemble a single human-readable export combining the main/renderer/backend
 * stream (electron-log's file) with the Python backend's own rotating file, and
 * write it to `destPath`. Used by the feedback dialog's "attach logs" path.
 * Best-effort: a missing/locked source is noted in the output rather than
 * failing the whole export.
 */
export async function copySessionLogTo(destPath: string): Promise<void> {
  const mainPath = getLogFilePath();
  const backendPath = join(getLogDir(), 'phytograph-backend.log');

  const sections: string[] = [];

  sections.push('===== Phytograph session log export =====');
  sections.push(`Exported main log: ${mainPath}`);
  sections.push(`Backend log: ${backendPath}`);
  sections.push('');

  sections.push('----- main / renderer / backend (electron-log) -----');
  sections.push(await readOrNote(mainPath));
  sections.push('');
  sections.push('----- backend (python, full) -----');
  sections.push(await readOrNote(backendPath));

  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, sections.join('\n'), 'utf-8');
}

async function readOrNote(path: string): Promise<string> {
  if (!existsSync(path)) return `(no file at ${path})`;
  try {
    return await readFile(path, 'utf-8');
  } catch (e) {
    return `(could not read ${path}: ${String(e)})`;
  }
}
