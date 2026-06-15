// Post-mortem crash detection for crashes too severe to handle live.
//
// The live crash dialog (crashDialog.ts) only works when the MAIN process
// survives — a renderer crash, a backend failure, or a catchable JS exception in
// main. It is fundamentally powerless against the main process ITSELF dying: a
// native segfault, an OS SIGKILL (memory pressure, Force Quit), or a power loss.
// The code that draws the dialog dies with the process, so there's nothing left
// to show anything.
//
// The only way to inform the user about those is AFTER THE FACT, on the next
// launch, from a fresh process. Two complementary signals:
//
//   1. crashReporter (Crashpad) — a SEPARATE OS process Electron starts that
//      captures native crashes as minidumps even when main is gone. We start it
//      with no submitURL, so dumps stay local in app.getPath('crashDumps').
//      Good for native segfaults; blind to a plain SIGKILL (no dump is written).
//
//   2. Clean-shutdown marker — a file we DELETE on a clean quit. If it's still
//      present at the next launch, the previous session did NOT exit cleanly.
//      This catches everything, including the SIGKILL that leaves no dump.
//
// On launch we check both: if the last session was unclean and/or left fresh
// dumps, we show a recovery dialog (View Logs / Report / Dismiss) that, for
// Report, attaches the newest minidump alongside the session log. All local —
// no auto-upload (reuses the existing manual GitHub/email flow).

import { app, crashReporter, dialog, shell, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { existsSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { EXPECTED_BACKEND_VERSION, FEEDBACK_EMAIL } from '../shared/constants.js';
import { PYHELIOS_VERSION, HELIOS_CORE_VERSION } from '../shared/generated/versionInfo.js';
import { buildIssueBody, buildGithubUrl, buildMailtoUrl, type Diagnostics } from '../renderer/lib/feedback.js';
import { getLogFilePath, log } from './logger.js';

const pmLog = log.scope('crash');

// Lives in userData so it survives across launches but is per-install.
function markerPath(): string {
  return join(app.getPath('userData'), 'clean-shutdown.marker');
}

function diagnostics(): Diagnostics {
  return {
    appVersion: app.getVersion(),
    backendVersion: EXPECTED_BACKEND_VERSION,
    pyheliosVersion: PYHELIOS_VERSION,
    heliosVersion: HELIOS_CORE_VERSION,
    platform: process.platform,
  };
}

/**
 * Start native crash capture. Call ONCE, as early as possible in main (before
 * app.whenReady), so Crashpad is armed before anything can crash. No submitURL →
 * minidumps are written locally to app.getPath('crashDumps') and never uploaded.
 */
export function initCrashReporter(): void {
  try {
    crashReporter.start({
      productName: 'Phytograph',
      companyName: 'PlantSimulationLab',
      uploadToServer: false, // local-only; we surface dumps on next launch
      compress: true,
    });
    pmLog.info('crashReporter started (local-only minidump capture).');
  } catch (e) {
    pmLog.error('Failed to start crashReporter:', e);
  }
}

/**
 * Mark this session as "running" — call once at startup, AFTER checking the
 * previous session (checkPreviousSession reads the OLD marker first). Writes the
 * marker file; clearCleanShutdownMarker() removes it on a clean quit.
 */
export function markSessionStarted(): void {
  try {
    writeFileSync(markerPath(), new Date().toISOString(), 'utf-8');
  } catch (e) {
    pmLog.error('Failed to write clean-shutdown marker:', e);
  }
}

/**
 * Record a CLEAN shutdown — call from before-quit/will-quit. Deleting the marker
 * is what tells the next launch the previous session ended normally.
 */
export function clearCleanShutdownMarker(): void {
  try {
    rmSync(markerPath(), { force: true });
  } catch (e) {
    pmLog.error('Failed to clear clean-shutdown marker:', e);
  }
}

/**
 * Treat SIGINT (Ctrl+C in the dev terminal) and SIGTERM (OS asking the app to
 * quit — logout/shutdown/`kill`) as INTENTIONAL shutdowns, not crashes. Default
 * Node behavior is to terminate on these WITHOUT running app's 'before-quit', so
 * the marker would survive and the next launch would wrongly report a crash.
 * We clear the marker synchronously, run the caller's cleanup (e.g. stopBackend
 * so the Python sidecar isn't orphaned), then exit cleanly. Call once at startup.
 *
 * Note: SIGKILL (kill -9) and a true native crash are deliberately NOT handled —
 * they're uncatchable / genuinely abnormal, and SHOULD trip the post-mortem path.
 */
export function installCleanShutdownSignals(cleanup: () => void): void {
  let handled = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (handled) return; // a second signal during teardown — ignore
      handled = true;
      pmLog.info(`Received ${sig}; clearing clean-shutdown marker and exiting cleanly.`);
      clearCleanShutdownMarker();
      try {
        cleanup();
      } catch (e) {
        pmLog.error('Cleanup during signal shutdown threw:', e);
      }
      // Exit 0 (not a crash). We bypass app.quit()'s async teardown because the
      // signal default is immediate termination anyway; the marker — the only
      // thing the next launch reads — is already cleared synchronously above.
      process.exit(0);
    });
  }
}

/** Newest *.dmp under the crashDumps dir modified since `sinceMs`, or null. */
function newestDumpSince(sinceMs: number): string | null {
  let dir: string;
  try {
    dir = app.getPath('crashDumps');
  } catch {
    return null;
  }
  // Crashpad nests completed dumps under a "completed" subfolder on some
  // platforms; check both the root and that subfolder.
  const candidates = [dir, join(dir, 'completed')];
  let newest: { path: string; mtime: number } | null = null;
  for (const d of candidates) {
    if (!existsSync(d)) continue;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.dmp')) continue;
      const p = join(d, name);
      try {
        const st = statSync(p);
        if (st.mtimeMs >= sinceMs && (!newest || st.mtimeMs > newest.mtime)) {
          newest = { path: p, mtime: st.mtimeMs };
        }
      } catch {
        /* unreadable — skip */
      }
    }
  }
  return newest?.path ?? null;
}

/**
 * Detect whether the PREVIOUS session crashed, and if so show a recovery dialog.
 * MUST be called once at startup BEFORE markSessionStarted() (it reads the old
 * marker) — typically right after app.whenReady(), before createWindow().
 *
 * Returns true if a crash was detected (a dialog was shown), false otherwise.
 */
export function checkPreviousSession(): boolean {
  const marker = markerPath();
  const uncleanExit = existsSync(marker);

  // The clean-shutdown marker is the only proof that a PREVIOUS session ran and
  // didn't exit cleanly: markSessionStarted() writes it at launch and a clean
  // quit deletes it. If it's absent we're either on a first launch (it never
  // existed) or after a clean quit (it was removed) — in both cases there is no
  // previous unclean session to report. Bail before searching for dumps, so a
  // stray/startup minidump can't be mis-attributed to a prior crash (this was
  // firing the recovery dialog on a freshly installed app's very first launch).
  if (!uncleanExit) return false;

  // A prior run left its marker → bound the dump search to that session.
  let sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  try {
    sinceMs = statSync(marker).mtimeMs - 1000;
  } catch {
    /* marker unreadable — use the fallback window */
  }
  const dump = newestDumpSince(sinceMs);

  pmLog.warn(
    `Previous session did not exit cleanly (marker=${uncleanExit}, dump=${dump ?? 'none'}).`,
  );
  showRecoveryDialog(dump);
  return true;
}

/** The post-mortem recovery dialog. Non-fatal: the app keeps launching normally. */
function showRecoveryDialog(dumpPath: string | null): void {
  const reportContext = dumpPath
    ? `previous session crashed (native minidump: ${dumpPath.split(/[\\/]/).pop()})`
    : 'previous session did not exit cleanly (no minidump — likely force-quit/OOM-kill)';
  for (;;) {
    const buttons = ['Dismiss', 'View Logs', 'Report'];
    const win = BrowserWindow.getAllWindows()[0];
    const opts = {
      type: 'warning' as const,
      title: 'Phytograph closed unexpectedly',
      message: 'Phytograph closed unexpectedly the last time it ran.',
      detail:
        (dumpPath
          ? 'A crash report was captured. '
          : 'No crash report was captured (this can happen on a force-quit or out-of-memory kill). ') +
        '"View Logs" opens the diagnostic log; "Report" opens a pre-filled bug ' +
        'report with the log' +
        (dumpPath ? ' and crash report' : '') +
        ' to attach. You can dismiss this and keep using the app.',
      buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const choice = win ? dialog.showMessageBoxSync(win, opts) : dialog.showMessageBoxSync(opts);
    if (choice === 1) {
      revealCrashArtifacts(dumpPath);
      continue;
    }
    if (choice === 2) {
      revealCrashArtifacts(dumpPath);
      openReport(reportContext, dumpPath);
      continue;
    }
    break; // Dismiss
  }
}

/** Reveal the session log and the minidump (if any) in the OS file manager. */
function revealCrashArtifacts(dumpPath: string | null): void {
  try {
    shell.showItemInFolder(getLogFilePath());
  } catch (e) {
    pmLog.error('Failed to reveal log:', e);
  }
  if (dumpPath) {
    try {
      shell.showItemInFolder(dumpPath);
    } catch (e) {
      pmLog.error('Failed to reveal minidump:', e);
    }
  }
}

/** Open a pre-filled GitHub bug report (email fallback), naming files to attach. */
function openReport(context: string, dumpPath: string | null): void {
  const logName = getLogFilePathSafe()?.split(/[\\/]/).pop();
  const dumpName = dumpPath?.split(/[\\/]/).pop();
  const description =
    `**Phytograph crashed (detected on next launch).**\n\n${context}\n\n` +
    `_(Auto-generated from the crash-recovery dialog. Please add what you were ` +
    `doing when it happened.)_`;
  // buildIssueBody names the log file under a "Session logs" heading; the
  // minidump (if any) is a second attachment, so name it with an extra line.
  let body = buildIssueBody('bug', description, diagnostics(), logName);
  if (dumpName) {
    body += `\n\nAlso attach the crash report \`${dumpName}\` (revealed in your file manager).`;
  }
  const title = `Crash: ${context}`;
  shell.openExternal(buildGithubUrl('bug', title, body)).catch(() => {
    void shell.openExternal(buildMailtoUrl('bug', title, body, FEEDBACK_EMAIL));
  });
}

function getLogFilePathSafe(): string | null {
  try {
    return getLogFilePath();
  } catch {
    return null;
  }
}
