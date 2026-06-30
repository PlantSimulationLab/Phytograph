// Native crash dialog for hard crashes the in-renderer UI can't handle.
//
// Two crash classes land here:
//   1. The RENDERER process dies natively (a WebGL/three.js/native crash, OOM,
//      or a GPU-process kill). React's ErrorBoundary only catches JS render
//      exceptions — a native renderer crash leaves a blank window and, by
//      default, macOS/Electron drop crash dumps into os.tmpdir()
//      (/private/tmp/<user>), NOT next to our real log. The user is left
//      staring at a dead window and a Finder window full of cryptic dumps.
//   2. The BACKEND sidecar exhausts its restart budget ('failed'). The renderer
//      is still alive here, but compute is dead for the rest of the session.
//
// Because case (1) can fire when the renderer can't render anything, this dialog
// is a NATIVE dialog.showMessageBox driven from the main process — it works even
// with a dead window. It points the user at the RIGHT log (our combined export),
// not the tmp crash-dump folder, and reuses the existing feedback URL builders
// so "Report" lands a pre-filled, log-attached GitHub/email issue.

import { app, dialog, shell, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { EXPECTED_BACKEND_VERSION, FEEDBACK_EMAIL } from '../shared/constants.js';
import { PYHELIOS_VERSION, HELIOS_CORE_VERSION } from '../shared/generated/versionInfo.js';
import {
  buildIssueBody,
  buildGithubUrl,
  buildMailtoUrl,
  type Diagnostics,
} from '../renderer/lib/feedback.js';
import { copySessionLogTo, getLogFilePath, log } from './logger.js';

const crashLog = log.scope('crash');

// One crash dialog at a time. A native renderer crash can fire
// 'render-process-gone' repeatedly (e.g. while a reload re-crashes); without
// this guard we'd stack modal dialogs the user can't dismiss.
let dialogOpen = false;

function diagnostics(): Diagnostics {
  return {
    appVersion: app.getVersion(),
    backendVersion: EXPECTED_BACKEND_VERSION,
    pyheliosVersion: PYHELIOS_VERSION,
    heliosVersion: HELIOS_CORE_VERSION,
    platform: process.platform,
  };
}

/** Write the combined main+backend log to a timestamped temp file and reveal it. */
async function revealCombinedLog(): Promise<string | null> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = join(app.getPath('temp'), `phytograph-crash-${stamp}.txt`);
    await copySessionLogTo(dest);
    shell.showItemInFolder(dest);
    return dest;
  } catch (e) {
    crashLog.error('Failed to export combined log; revealing raw log file instead:', e);
    // Fall back to revealing the live electron-log file directly so the user
    // still gets the RIGHT file (not the /private/tmp crash-dump folder).
    try {
      const raw = getLogFilePath();
      shell.showItemInFolder(raw);
      return raw;
    } catch {
      return null;
    }
  }
}

/** Open a pre-filled, log-attached bug report (GitHub if possible, else email). */
async function openCrashReport(context: string): Promise<void> {
  const savedPath = await revealCombinedLog();
  const logFileName = savedPath?.split(/[\\/]/).pop();
  const description =
    `**A crash occurred.**\n\n${context}\n\n` +
    `_(Auto-generated from the crash dialog. Please add what you were doing when it happened.)_`;
  const body = buildIssueBody('bug', description, diagnostics(), logFileName);
  const title = `Crash: ${context}`;
  // GitHub is the primary path (structured issue form); the email fallback is
  // there for users without a GitHub account, matching FeedbackDialog.
  const url = buildGithubUrl('bug', title, body);
  try {
    await shell.openExternal(url);
  } catch (e) {
    crashLog.error('Failed to open GitHub issue URL; falling back to email:', e);
    await shell.openExternal(buildMailtoUrl('bug', title, body, FEEDBACK_EMAIL));
  }
}

interface CrashDialogOptions {
  /** Short human label of what crashed, e.g. "The display crashed.". */
  message: string;
  /** Extra detail line(s) shown under the message. */
  detail: string;
  /** Machine-readable context embedded in a crash report. */
  reportContext: string;
  /** If set, the dialog offers a "Reload" button that calls this. */
  onReload?: () => void;
}

/**
 * Show the native crash dialog. Buttons (left→right): Reload (optional), Quit,
 * View Logs, Report. View Logs / Report re-open the dialog afterward so the user
 * can still pick a recovery action — only Reload and Quit are terminal.
 */
async function showCrashDialog(opts: CrashDialogOptions): Promise<void> {
  if (dialogOpen) return;
  dialogOpen = true;
  try {
    const buttons: string[] = [];
    if (opts.onReload) buttons.push('Reload');
    buttons.push('Quit', 'View Logs', 'Report');
    const reloadIdx = opts.onReload ? 0 : -1;
    const quitIdx = buttons.indexOf('Quit');
    const viewLogsIdx = buttons.indexOf('View Logs');
    const reportIdx = buttons.indexOf('Report');

    // Reload and Quit are terminal; View Logs / Report do their thing and then
    // re-show the dialog so the user can still pick a recovery action. Loop
    // rather than recurse so `dialogOpen` stays true for the whole interaction
    // (a re-crash mid-dialog can't stack a second modal).
    for (;;) {
      const win = BrowserWindow.getAllWindows()[0];
      const result = win
        ? await dialog.showMessageBox(win, messageBoxOpts(opts, buttons, reloadIdx, quitIdx))
        : await dialog.showMessageBox(messageBoxOpts(opts, buttons, reloadIdx, quitIdx));

      const choice = result.response;
      if (choice === reloadIdx) {
        crashLog.info('User chose Reload after crash:', opts.reportContext);
        opts.onReload?.();
        return;
      }
      if (choice === quitIdx) {
        crashLog.info('User chose Quit after crash:', opts.reportContext);
        app.quit();
        return;
      }
      if (choice === viewLogsIdx) {
        await revealCombinedLog();
        continue;
      }
      if (choice === reportIdx) {
        await openCrashReport(opts.reportContext);
        continue;
      }
      return; // unknown response (shouldn't happen) — bail out
    }
  } finally {
    dialogOpen = false;
  }
}

function messageBoxOpts(
  opts: CrashDialogOptions,
  buttons: string[],
  reloadIdx: number,
  quitIdx: number,
) {
  return {
    type: 'error' as const,
    title: 'Phytograph crashed',
    message: opts.message,
    detail:
      `${opts.detail}\n\n` +
      `Your work in memory was lost. "View Logs" opens the diagnostic log; ` +
      `"Report" opens a pre-filled bug report with the log attached.`,
    buttons,
    // Reload is the friendliest default when available; otherwise default to Quit.
    defaultId: reloadIdx >= 0 ? reloadIdx : quitIdx,
    cancelId: quitIdx,
    noLink: true,
  };
}

/**
 * Wire crash handlers onto a freshly created BrowserWindow. Called from main.ts
 * after createWindow(). `reload` recreates/reloads the renderer in place — the
 * backend (and its in-RAM data) survives a renderer crash, so a reload can
 * recover the session without a full relaunch.
 */
export function installCrashHandlers(win: BrowserWindow, reload: () => void): void {
  // The renderer process died natively (not a caught JS exception). 'clean-exit'
  // is a normal teardown (window close / quit) — ignore it; only 'crashed',
  // 'oom', 'killed', etc. are real crashes.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    crashLog.error(`Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`);
    void showCrashDialog({
      message: 'The display crashed.',
      detail: `The rendering process stopped unexpectedly (${details.reason}).`,
      reportContext: `renderer ${details.reason} (exit ${details.exitCode})`,
      onReload: reload,
    });
  });

  // A utility/GPU child process died ('child-process-gone' is an app-level
  // event, not a webContents one). The GPU process usually recovers on its own
  // (Chromium respawns it), so we just log it for diagnostics rather than
  // interrupting with a dialog. Registered once, app-wide.
  if (!childProcessHandlerInstalled) {
    childProcessHandlerInstalled = true;
    app.on('child-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      crashLog.warn(
        `Child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`,
      );
    });
  }
}

// 'child-process-gone' is app-wide; guard so re-creating the window doesn't stack
// duplicate listeners.
let childProcessHandlerInstalled = false;

/**
 * Surface the backend's terminal 'failed' state (restart budget exhausted) as
 * the same native crash dialog. The renderer is alive here, so Reload reloads
 * it (which re-runs initBackendUrl and lets the user retry); Report/View Logs
 * behave identically to the renderer-crash path.
 */
export function showBackendFailedDialog(reload: () => void): void {
  void showCrashDialog({
    message: 'The compute backend stopped and could not be restarted.',
    detail:
      'Import, fitting, and all other compute features are unavailable for this ' +
      'session. Reloading restarts the backend; if it keeps failing, relaunch Phytograph.',
    reportContext: 'backend failed (restart budget exhausted)',
    onReload: reload,
  });
}

/**
 * Surface a FATAL uncaught exception in the main process, then exit. Unlike the
 * other crash paths the main process is in a corrupted state here, so this is
 * deliberately SYNCHRONOUS (showMessageBoxSync + sync log reveal) — the async
 * event loop can't be trusted after an uncaught exception, and we must not
 * return to it. There is no "Reload": main can't safely keep running, so the
 * choices are View Logs / Report / Quit, and we exit no matter what.
 *
 * Wired from logger.ts via setFatalErrorHandler. Called for the M debug shortcut
 * too (kind 'main' throws an uncaught exception, which lands here).
 */
export function showFatalMainErrorDialog(error: Error): void {
  crashLog.error('Fatal main-process error; showing dialog before exit:', error);
  // A fatal main error can strike before the window exists (or with it dead), so
  // the dialog may be parentless and open behind the foreground app on macOS.
  // Pull the app forward so the user actually sees the modal they're blocked on.
  try {
    app.focus({ steal: true });
  } catch {
    /* best-effort */
  }
  const reportContext = `main-process uncaught exception: ${error.message}`;
  // Loop so View Logs / Report don't dismiss the dialog — only Quit exits.
  for (;;) {
    const buttons = ['Quit', 'View Logs', 'Report'];
    const win = BrowserWindow.getAllWindows()[0];
    const opts = {
      type: 'error' as const,
      title: 'Phytograph crashed',
      message: 'Phytograph hit a fatal error and must close.',
      detail:
        `${error.message}\n\n` +
        `Your work in memory was lost. "View Logs" opens the diagnostic log; ` +
        `"Report" opens a pre-filled bug report with the log attached. ` +
        `The app will close when you're done.`,
      buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const choice = win
      ? dialog.showMessageBoxSync(win, opts)
      : dialog.showMessageBoxSync(opts);
    if (choice === 1) {
      revealLogSync();
      continue;
    }
    if (choice === 2) {
      // Reveal the log synchronously, then open the report URL (openExternal is
      // fire-and-forget; the OS handles it even as we exit).
      const savedPath = revealLogSync();
      openReportUrlFor(reportContext, savedPath ?? undefined);
      continue;
    }
    break; // Quit (or dialog dismissed)
  }
  process.exit(1);
}

/**
 * Synchronously reveal the live log file (no combined export — that's async and
 * unsafe after a fatal error). Returns the revealed path, or null on failure.
 */
function revealLogSync(): string | null {
  try {
    const raw = getLogFilePath();
    shell.showItemInFolder(raw);
    return raw;
  } catch (e) {
    crashLog.error('Failed to reveal log after fatal error:', e);
    return null;
  }
}

/** Open a pre-filled GitHub bug report URL (fire-and-forget). */
function openReportUrlFor(context: string, logFileName?: string): void {
  const name = logFileName?.split(/[\\/]/).pop();
  const description =
    `**A fatal crash occurred.**\n\n${context}\n\n` +
    `_(Auto-generated from the crash dialog. Please add what you were doing when it happened.)_`;
  const body = buildIssueBody('bug', description, diagnostics(), name);
  void shell.openExternal(buildGithubUrl('bug', `Crash: ${context}`, body));
}
