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
    window.electronAPI?.logs?.write(level, formatArgs(args));
  } catch {
    // Never let logging break the app.
  }
}

/**
 * Render console arguments the way DevTools would, applying printf-style
 * substitution when the first argument is a format string.
 *
 * React logs errors as ('%s\n\n%s', message, componentStack). Joining the raw
 * args dropped the substitutions on the floor, so the log recorded a literal
 * "%s" and threw away the two things a bug report actually needs: the error
 * message and the component stack. Substituting first keeps them.
 *
 * Supports the specifiers React and console consumers actually emit (%s %d %i
 * %f %o %O %j %c); %% is a literal percent. Unmatched specifiers are left as-is
 * and surplus args are appended, so nothing is ever silently lost.
 */
function formatArgs(args: unknown[]): string {
  const [first, ...rest] = args;
  if (typeof first !== 'string' || !/%[sdifoOjc%]/.test(first)) {
    return args.map(formatArg).join(' ');
  }

  let i = 0;
  const out = first.replace(/%([sdifoOjc%])/g, (match, spec: string) => {
    if (spec === '%') return '%';
    if (i >= rest.length) return match; // more specifiers than args — keep literal
    const arg = rest[i++];
    switch (spec) {
      case 'd':
      case 'i': {
        const n = Number(arg);
        return Number.isNaN(n) ? 'NaN' : String(Math.trunc(n));
      }
      case 'f': {
        const n = Number(arg);
        return Number.isNaN(n) ? 'NaN' : String(n);
      }
      case 'c':
        return ''; // CSS styling directive — no textual output
      default:
        return formatArg(arg);
    }
  });

  const leftover = rest.slice(i);
  return leftover.length ? `${out} ${leftover.map(formatArg).join(' ')}` : out;
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
