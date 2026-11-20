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
 * The stall watchdog (#9, seen twice): the page load can also neither finish
 * nor fail. Every event above stays silent then, so the absence of the
 * `page loaded` line was all a log could show. If the load has not finished
 * `stallCheckMs` after navigation starts (15 s and 60 s by default), the
 * watchdog logs what the main process can still see: the webContents' own
 * state, every Electron process with its CPU and memory, and the GPU feature
 * status. Two snapshots, because Chromium measures CPU since the PREVIOUS
 * `getAppMetrics()` call: the first reads 0 %, and the second says whether the
 * renderer and GPU processes spent those 45 s spinning or idle.
 *
 * Kept free of `electron` imports (the caller passes the webContents and app)
 * so it is unit-testable. The probes are optional on the interfaces, so a test
 * can pass a bare EventEmitter.
 */

export interface DiagnosticsLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** The slice of a WebContents this module listens to and probes. */
export interface DiagnosticsWebContents {
  on(event: string, listener: (...args: any[]) => void): unknown;
  isLoading?(): boolean;
  isLoadingMainFrame?(): boolean;
  isWaitingForResponse?(): boolean;
  isCrashed?(): boolean;
  getOSProcessId?(): number;
  getURL?(): string;
}

/** The slice of an Electron ProcessMetric the stall snapshot reports. */
export interface DiagnosticsProcessMetric {
  type: string;
  pid: number;
  cpu?: { percentCPUUsage?: number; idleWakeupsPerSecond?: number };
  memory?: { workingSetSize?: number };
}

/** The slice of `app` this module listens to and probes. */
export interface DiagnosticsApp {
  on(event: string, listener: (...args: any[]) => void): unknown;
  getAppMetrics?(): DiagnosticsProcessMetric[];
  getGPUFeatureStatus?(): unknown;
}

const CONSOLE_ERROR_LEVEL = 3;

/** When the stall watchdog looks, in ms after navigation starts. */
export const DEFAULT_STALL_CHECK_MS = [15_000, 60_000];

/** Call a probe, turning a throw into text: a snapshot must never throw. */
function probe<T>(fn: (() => T) | undefined): T | string | undefined {
  if (!fn) return undefined;
  try {
    return fn();
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** What the main process can see of a renderer whose page has not loaded. */
export function stallSnapshot(webContents: DiagnosticsWebContents, app: DiagnosticsApp): string {
  const state = {
    loading: probe(webContents.isLoading?.bind(webContents)),
    mainFrameLoading: probe(webContents.isLoadingMainFrame?.bind(webContents)),
    waitingForResponse: probe(webContents.isWaitingForResponse?.bind(webContents)),
    crashed: probe(webContents.isCrashed?.bind(webContents)),
    rendererPid: probe(webContents.getOSProcessId?.bind(webContents)),
    url: probe(webContents.getURL?.bind(webContents)),
  };
  const metrics = probe(app.getAppMetrics?.bind(app));
  const processes = Array.isArray(metrics)
    ? metrics.map((m) => {
      const cpu = m.cpu?.percentCPUUsage;
      const mem = m.memory?.workingSetSize; // KB
      return `${m.type}:${m.pid} cpu=${cpu == null ? '?' : cpu.toFixed(1)}%`
        + ` wakeups=${m.cpu?.idleWakeupsPerSecond ?? '?'}/s mem=${mem == null ? '?' : Math.round(mem / 1024)}MB`;
    }).join(', ')
    : String(metrics);
  let gpu: string;
  try {
    gpu = JSON.stringify(probe(app.getGPUFeatureStatus?.bind(app)));
  } catch {
    gpu = '(unserializable)';
  }
  return `state=${JSON.stringify(state)} processes=[${processes}] gpu=${gpu}`;
}

let childProcessLoggerInstalled = false;

export function installRendererDiagnostics(
  webContents: DiagnosticsWebContents,
  app: DiagnosticsApp,
  log: DiagnosticsLogger,
  { logCrashes, stallCheckMs = DEFAULT_STALL_CHECK_MS }: { logCrashes: boolean; stallCheckMs?: number[] },
): void {
  // The stall watchdog: armed when a navigation starts (a crash-recovery
  // reload re-arms it), disarmed when that load finishes or the contents go.
  let stallTimers: ReturnType<typeof setTimeout>[] = [];
  const disarm = () => {
    for (const t of stallTimers) clearTimeout(t);
    stallTimers = [];
  };
  webContents.on('did-start-loading', () => {
    disarm();
    log.info('[window] renderer navigation started');
    const startedAt = Date.now();
    stallTimers = stallCheckMs.map((ms) => {
      const t = setTimeout(() => {
        const s = Math.round((Date.now() - startedAt) / 1000);
        log.warn(`[window] renderer page not loaded after ${s}s: ${stallSnapshot(webContents, app)}`);
      }, ms);
      // Never the reason the process stays alive.
      (t as { unref?: () => void }).unref?.();
      return t;
    });
  });
  webContents.on('destroyed', disarm);

  // Between navigation start and page load: the HTML has been parsed.
  webContents.on('dom-ready', () => {
    log.info('[window] renderer DOM ready');
  });

  // A positive marker, so a session log WITHOUT it says the page never loaded.
  webContents.on('did-finish-load', () => {
    disarm();
    log.info('[window] renderer page loaded');
  });

  webContents.on('did-fail-load', (_e: unknown, errorCode: number, errorDescription: string,
    validatedURL: string, isMainFrame: boolean) => {
    // A failed sub-resource is the page's business; the main frame failing is
    // a window that will never render.
    if (!isMainFrame) return;
    disarm();
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
