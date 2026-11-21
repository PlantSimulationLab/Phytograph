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
 * status. Chromium measures CPU since the PREVIOUS `getAppMetrics()` call, so
 * the watchdog primes it when it arms: each snapshot's CPU covers the time
 * since the one before. A window closed while its load is still pending gets
 * a final snapshot on the way out, since a stalled test is often torn down
 * before the 60 s check.
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
  getGPUInfo?(infoType: 'basic' | 'complete'): Promise<unknown>;
}

/** How long the page-load GPU baseline waits for `getGPUInfo('basic')`. */
const GPU_INFO_TIMEOUT_MS = 5_000;

/** The GPU fields worth a log line, out of getGPUInfo('basic'). */
function summarizeGpuInfo(info: unknown): string {
  if (!info || typeof info !== 'object') return String(info);
  const i = info as { auxAttributes?: Record<string, unknown>; gpuDevice?: unknown[] };
  const aux = i.auxAttributes ?? {};
  const pick = (k: string) => (k in aux ? aux[k] : undefined);
  return JSON.stringify({
    glRenderer: pick('glRenderer'),
    glVendor: pick('glVendor'),
    glVersion: pick('glVersion'),
    glImplementationParts: pick('glImplementationParts'),
    gpuDevice: i.gpuDevice,
  });
}

/**
 * One line per window at its first page load: the GPU feature status and the
 * GL implementation the GPU process settled on. It is the healthy baseline
 * the stall snapshot is read against (#9: a stalled CI window showed every
 * feature off and a 0 MB GPU process, and nothing said what a working one
 * shows). getGPUInfo needs the GPU process, so it is raced against a timeout
 * and never called from the stall snapshot itself.
 */
export async function logGpuBaseline(app: DiagnosticsApp, log: DiagnosticsLogger): Promise<void> {
  let features: string;
  try {
    features = JSON.stringify(app.getGPUFeatureStatus?.());
  } catch (err) {
    features = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  let info = 'unavailable';
  if (app.getGPUInfo) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${GPU_INFO_TIMEOUT_MS} ms`)), GPU_INFO_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      info = summarizeGpuInfo(await Promise.race([app.getGPUInfo('basic'), timeout]));
    } catch (err) {
      info = `error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  log.info(`[window] gpu at page load: features=${features} info=${info}`);
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
  // When the load still pending began; null once it finished or failed.
  let pendingSince: number | null = null;
  const disarm = () => {
    for (const t of stallTimers) clearTimeout(t);
    stallTimers = [];
    pendingSince = null;
  };
  const secondsPending = () => Math.round((Date.now() - (pendingSince ?? Date.now())) / 1000);
  webContents.on('did-start-loading', () => {
    disarm();
    log.info('[window] renderer navigation started');
    pendingSince = Date.now();
    // Prime Chromium's CPU accounting: each getAppMetrics() reports CPU since
    // the previous call, so without this the 15 s snapshot always reads 0 %.
    probe(app.getAppMetrics?.bind(app));
    stallTimers = stallCheckMs.map((ms) => {
      const t = setTimeout(() => {
        log.warn(`[window] renderer page not loaded after ${secondsPending()}s: ${stallSnapshot(webContents, app)}`);
      }, ms);
      // Never the reason the process stays alive.
      (t as { unref?: () => void }).unref?.();
      return t;
    });
  });
  // A stalled window can be closed before any timer fires: the lad-wood stall
  // on CI was torn down about 38 s after launch, before a 60 s check. Take the
  // snapshot on the way out instead. `before-quit` comes while everything is
  // still alive; `destroyed` is the fallback for a window closed on its own.
  const closingSnapshot = () => {
    if (pendingSince == null) return;
    log.warn(`[window] renderer closing before its page loaded (after ${secondsPending()}s): ${stallSnapshot(webContents, app)}`);
    disarm();
  };
  app.on('before-quit', closingSnapshot);
  webContents.on('destroyed', closingSnapshot);

  // Between navigation start and page load: the HTML has been parsed.
  webContents.on('dom-ready', () => {
    log.info('[window] renderer DOM ready');
  });

  // A positive marker, so a session log WITHOUT it says the page never loaded.
  let gpuBaselineLogged = false;
  webContents.on('did-finish-load', () => {
    disarm();
    log.info('[window] renderer page loaded');
    if (!gpuBaselineLogged) {
      gpuBaselineLogged = true;
      void logGpuBaseline(app, log);
    }
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
