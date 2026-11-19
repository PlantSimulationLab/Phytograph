/**
 * Log lines for the renderer's own lifecycle, so a window that never came up
 * leaves evidence in the session log.
 *
 * The case that needed it (Linux CI, 2026-11-19): the window opened, the
 * backend started and answered, and the renderer never sent it a single
 * request: no toolbar, nothing logged. The renderer forwards only what its own
 * code passes to console.error/warn, so a page that failed to load, a preload
 * that threw, an exception while the bundle evaluated, or a hung renderer
 * wrote nothing anywhere. And the crash handlers (crashDialog.ts) are skipped
 * under E2E, where a native dialog would hang the driver, so a renderer that
 * died there was silent too.
 *
 * Everything here only LOGS, so it is installed in every mode, E2E included.
 * `logCrashes` is true where the crash handlers are absent; where they are
 * installed they already log a crash, and logging it again would double it.
 *
 * Kept free of `electron` imports (the caller passes the webContents and app)
 * so it is unit-testable.
 */

export interface DiagnosticsLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** The slice of a WebContents this module listens to. */
export interface DiagnosticsWebContents {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** The slice of `app` this module listens to. */
export interface DiagnosticsApp {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

const CONSOLE_ERROR_LEVEL = 3;

let childProcessLoggerInstalled = false;

export function installRendererDiagnostics(
  webContents: DiagnosticsWebContents,
  app: DiagnosticsApp,
  log: DiagnosticsLogger,
  { logCrashes }: { logCrashes: boolean },
): void {
  // A positive marker, so a session log WITHOUT it says the page never loaded.
  webContents.on('did-finish-load', () => {
    log.info('[window] renderer page loaded');
  });

  webContents.on('did-fail-load', (_e: unknown, errorCode: number, errorDescription: string,
    validatedURL: string, isMainFrame: boolean) => {
    // A failed sub-resource is the page's business; the main frame failing is
    // a window that will never render.
    if (!isMainFrame) return;
    log.error(`[window] renderer page failed to load: ${errorDescription} (${errorCode}) ${validatedURL}`);
  });

  webContents.on('preload-error', (_e: unknown, preloadPath: string, error: Error) => {
    log.error(`[window] preload script threw (${preloadPath}): ${error?.stack ?? error}`);
  });

  webContents.on('unresponsive', () => {
    log.warn('[window] renderer is unresponsive');
  });
  webContents.on('responsive', () => {
    log.info('[window] renderer is responsive again');
  });

  // Uncaught exceptions never pass through console.error, so the renderer's
  // own forwarding (lib/logger.ts) cannot see them, least of all one thrown
  // while the bundle evaluates. Chromium reports them here as "Uncaught ...".
  // Only those: anything else at error level came from console.error and was
  // already forwarded.
  webContents.on('console-message', (_e: unknown, level: number, message: string, line: number,
    sourceId: string) => {
    if (level < CONSOLE_ERROR_LEVEL || typeof message !== 'string' || !message.startsWith('Uncaught')) return;
    log.error(`[window] ${message} (${sourceId}:${line})`);
  });

  if (!logCrashes) return;
  webContents.on('render-process-gone', (_e: unknown, details: { reason: string; exitCode: number }) => {
    if (details.reason === 'clean-exit') return;
    log.error(`[window] renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });
  // App-wide, so once per process however many windows are created.
  if (!childProcessLoggerInstalled) {
    childProcessLoggerInstalled = true;
    app.on('child-process-gone', (_e: unknown, details: { type: string; reason: string; exitCode: number }) => {
      if (details.reason === 'clean-exit') return;
      log.warn(`[window] child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
    });
  }
}

/** Test seam: forget that the app-wide listener was installed. */
export function resetRendererDiagnosticsForTest(): void {
  childProcessLoggerInstalled = false;
}
