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
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { isBrokenPipe, pipeErrCode } from './brokenPipe.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug';

let initialized = false;

// A per-launch tag (sortable timestamp + pid) that names THIS session's log
// files. Timestamp so files sort chronologically and are human-scannable; pid so
// two instances launched in the same second (or an E2E run spawning several
// apps) never collide on one file. Computed once in initLogging() and reused for
// both the electron-log main file and the Python sidecar's file (via env), so an
// exported bug report pairs exactly one main + one backend file per session
// instead of the old single ever-growing main.log.
let sessionTag = '';

// How many past sessions' log files to keep. Older ones are pruned on launch so
// the logs dir stays bounded without the user managing it.
const KEEP_SESSIONS = 10;

/** The current session's log tag (e.g. 2026-07-22T14-32-08-123Z-pid59049). */
export function getLogSessionTag(): string {
  return sessionTag;
}

/**
 * Configure electron-log once. Idempotent — safe to call from multiple entry
 * points. Must run before the first log call (init it at the top of main.ts).
 */
export function initLogging(): void {
  if (initialized) return;
  initialized = true;

  // Per-session file naming. Each launch writes its own main-<tag>.log instead of
  // appending forever to one main.log (which grew to weeks of interleaved
  // sessions and made bug reports unreadable). The tag is a filesystem-safe
  // ISO timestamp + pid. resolvePathFn is electron-log 5.x's supported hook for
  // this; getFile().path still returns whatever it yields, so getLogFilePath()
  // and everything downstream keep working. Must be set before the first log
  // write (initLogging runs at the very top of main.ts, before anything logs).
  sessionTag = `${new Date().toISOString().replace(/[:.]/g, '-')}-pid${process.pid}`;
  electronLog.transports.file.resolvePathFn = (vars) =>
    join(vars.libraryDefaultDir, `main-${sessionTag}.log`);

  // File transport: still rotate a single (very long) session at 5 MB into its
  // own main-<tag>.old.log via electron-log's default archiveLogFn.
  electronLog.transports.file.level = 'info';
  electronLog.transports.file.maxSize = 5 * 1024 * 1024;
  electronLog.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}';
  // Console transport stays on in dev so `npm run dev` still shows everything in
  // the terminal; quiet it in packaged builds (nothing reads stdout there).
  electronLog.transports.console.level = app.isPackaged ? false : 'info';

  // Broken-pipe armor at the source. If the controlling terminal closes or the
  // system sleeps and tears down stdio, the next console write throws EIO/EPIPE.
  // That used to bubble up as an UNCAUGHT exception → fatal crash dialog → exit
  // → relaunch → re-crash (the dialog/logging path re-writes the dead pipe), a
  // 20×-and-counting loop. Wrap the console transport's writeFn so a dead pipe
  // degrades to "no terminal output" instead of throwing: swallow EIO/EPIPE and
  // permanently disable the console transport so we stop hammering it.
  const defaultConsoleWrite = electronLog.transports.console.writeFn;
  electronLog.transports.console.writeFn = (params) => {
    try {
      defaultConsoleWrite(params);
    } catch (e) {
      if (isBrokenPipe(e)) {
        disableConsoleTransport();
        return;
      }
      throw e;
    }
  };

  // Route main-process console.* through electron-log so existing console.log
  // calls in main.ts/octreeProtocol.ts/etc. also land in the file without
  // touching every call site. (Renderer console is forwarded separately over IPC.)
  electronLog.initialize?.();
  Object.assign(console, electronLog.functions);

  // Crash safety: previously an uncaught exception in main terminated the
  // process with no record. electron-log installs process.on('uncaughtException')
  // + 'unhandledRejection' listeners — which SUPPRESSES Node's default
  // print-and-exit-1. We log the error first (the file transport is synchronous,
  // so the line is on disk before anything else), then:
  //   - genuine uncaught EXCEPTION ('Unhandled') — main is likely in a corrupted
  //     state, so this is FATAL. We hand it to the fatal-error handler (which
  //     shows the native crash dialog so the user can view logs / report) and
  //     exit afterward.
  //   - unhandled promise REJECTION ('Unhandled rejection') — usually a stray
  //     async error the app can survive, so we log it and soldier on (no dialog).
  //   - a broken-stdio error ('EIO'/'EPIPE') — NOT a corrupted app, just a dead
  //     stdout/stderr pipe (terminal closed, system sleep tore down child procs).
  //     Fatal-dialoging on it caused a crash-loop: the dialog/logging path itself
  //     re-writes to the dead pipe → re-throws EIO → re-dialogs. Treat it as
  //     non-fatal and survive (the file transport still works). See isBrokenPipe.
  // Returning false stops electron-log from logging it a second time.
  electronLog.errorHandler.startCatching({
    showDialog: false,
    onError: ({ error, errorName }) => {
      // A dead stdout/stderr pipe is recoverable, not a corrupted app: disable
      // the console transport first so the warning below can't re-throw on the
      // same dead pipe, then log to the (still-working) file transport.
      if (isBrokenPipe(error)) {
        disableConsoleTransport();
        electronLog
          .scope('main')
          .warn(`stdio write failed (${pipeErrCode(error)}); console output disabled, continuing.`);
        return false;
      }
      electronLog.scope('main').error(`${errorName}:`, error);
      if (errorName !== 'Unhandled rejection') {
        // Let main.ts surface the crash dialog (it owns the BrowserWindow and the
        // crashDialog module). The handler is responsible for exiting the process
        // after the user dismisses the dialog. If main.ts never registered one
        // (e.g. crash during very early startup), fall back to the old behavior.
        if (fatalErrorHandler) {
          fatalErrorHandler(error instanceof Error ? error : new Error(String(error)));
        } else {
          process.exit(1);
        }
      }
      return false;
    },
  });

  // Prune old sessions' log files so the dir stays bounded. Runs after the
  // transport path is resolved (so getLogDir() is valid) and never touches this
  // session's own files. See pruneOldSessionLogs for why it's skipped under E2E.
  pruneOldSessionLogs();
}

/**
 * Delete all but the KEEP_SESSIONS newest session log groups (main-<tag>.log,
 * its .old.log, and the Python phytograph-backend-<tag>.log). Grouped by tag so
 * a session's main + backend files are kept or dropped together.
 *
 * SKIPPED under E2E: the Playwright suite launches many apps concurrently
 * against the shared logs dir, and unlinking a file another live worker's
 * backend still holds open (or that copySessionLogTo is mid-read on) could wedge
 * teardown. Real user sessions are sequential, so pruning there is safe.
 *
 * Best-effort throughout — a readdir/stat/unlink failure (a locked file on
 * Windows, a permissions quirk) must never break app startup.
 */
function pruneOldSessionLogs(): void {
  if (process.env.PHYTOGRAPH_E2E === '1') return;
  try {
    const dir = getLogDir();
    const current = sessionTag;
    // Map each session tag → the files belonging to it, plus the newest mtime
    // seen for that tag (used to rank which sessions to keep).
    const groups = new Map<string, { files: string[]; mtime: number }>();
    for (const name of readdirSync(dir)) {
      const m =
        /^main-(.+?)(?:\.old)?\.log$/.exec(name) ??
        /^phytograph-backend-(.+?)(?:\.\d+)?\.log$/.exec(name);
      if (!m) continue;
      const tag = m[1];
      if (tag === current) continue; // never prune the live session
      const full = join(dir, name);
      let mtime = 0;
      try { mtime = statSync(full).mtimeMs; } catch { /* skip unstatable */ continue; }
      const g = groups.get(tag) ?? { files: [], mtime: 0 };
      g.files.push(full);
      g.mtime = Math.max(g.mtime, mtime);
      groups.set(tag, g);
    }
    const stale = [...groups.values()]
      .sort((a, b) => b.mtime - a.mtime) // newest first
      .slice(KEEP_SESSIONS);             // everything past the keep window
    for (const g of stale) {
      for (const f of g.files) {
        try { unlinkSync(f); } catch { /* locked/gone — leave it */ }
      }
    }
  } catch {
    // Dir missing on first ever launch, or unreadable — nothing to prune.
  }
}

/**
 * Stop electron-log echoing to the (now-dead) console. Once stdout/stderr is a
 * broken pipe, every subsequent console.* would re-throw EIO; disabling the
 * console transport keeps the file transport (and the rest of the app) alive.
 * Idempotent.
 */
function disableConsoleTransport(): void {
  if (electronLog.transports.console.level !== false) {
    electronLog.transports.console.level = false;
  }
}

// Set by main.ts. Invoked for a fatal uncaught exception in the main process so
// main can show the native crash dialog before exiting. Kept here (not a direct
// import of crashDialog) so logger.ts stays free of UI dependencies and the
// handler can be installed only once initLogging has run.
let fatalErrorHandler: ((error: Error) => void) | null = null;

export function setFatalErrorHandler(handler: (error: Error) => void): void {
  fatalErrorHandler = handler;
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
  // Prefer THIS session's Python log (matched to the main file by tag) so an
  // export contains only the current run, not adjacent sessions. Fall back to
  // the legacy single-file name for a standalone backend launch that never got a
  // session tag; readOrNote() handles a missing file gracefully either way.
  const backendPath = sessionTag
    ? join(getLogDir(), `phytograph-backend-${sessionTag}.log`)
    : join(getLogDir(), 'phytograph-backend.log');

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
