// Renderer-side log forwarding.
//
// The renderer's console output otherwise only exists in the DevTools console,
// which is invisible in a packaged build. This patches console.error/warn so
// every error/warning is ALSO forwarded over IPC to the main process, where it's
// written into the unified session log under the [renderer] scope. That log is
// what the feedback dialog's "attach logs" path exports.
//
// We deliberately forward only error+warn (not log/info/debug) to keep the file
// signal-dense — those are the lines that matter for a bug report. The original
// console behaviour is preserved so DevTools still shows everything in dev.

import type { LogLevel } from '../../shared/ipc';

function forward(level: LogLevel, args: unknown[]): void {
  try {
    window.electronAPI?.logs?.write(level, args.map(formatArg).join(' '));
  } catch {
    // Never let logging break the app.
  }
}

function formatArg(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

let installed = false;

/** Patch console.error/warn to also forward to the main-process log file. */
export function installConsoleForwarding(): void {
  if (installed) return;
  installed = true;

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    forward('error', args);
    origError(...args);
  };
  console.warn = (...args: unknown[]) => {
    forward('warn', args);
    origWarn(...args);
  };
}

/** Direct log to the session file (used by ErrorBoundary for componentStack). */
export function logToSession(level: LogLevel, message: string): void {
  try {
    window.electronAPI?.logs?.write(level, message);
  } catch {
    /* ignore */
  }
}
