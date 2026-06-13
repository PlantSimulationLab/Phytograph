import { test, expect, type ElectronApplication } from '@playwright/test';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchApp } from './helpers/launchApp';
import { stubSaveDialog } from './helpers/stubSaveDialog';

// Drives the in-app feedback feature end-to-end against the LIVE app. The two
// toolbar buttons open a dialog that collects a title + description, then hands
// off to either GitHub (pre-filled new-issue URL) or email (mailto:). The OS
// handoff via shell.openExternal is the one boundary we must not actually fire
// in CI (it would launch a browser / mail client), so we re-handle that single
// IPC channel in the main process to CAPTURE the URL — everything else is the
// real UI, real diagnostics from backend.getInfo(), and the real URL-builder
// logic.
//
// Capturing the handoff URL and decoding its params is the real output under
// test: it proves the typed text and the auto-attached environment block reach
// GitHub/email with the right labels and template.

// Replace the `shell:openExternal` IPC handler so it records URLs instead of
// launching a browser/mail client. Same approach as stubOpenDialog.ts.
async function captureOpenExternal(app: ElectronApplication) {
  await app.evaluate(async ({ ipcMain }) => {
    const g = globalThis as unknown as { __openedUrls?: string[] };
    g.__openedUrls = [];
    ipcMain.removeHandler('shell:openExternal');
    ipcMain.handle('shell:openExternal', async (_e, url: string) => {
      g.__openedUrls!.push(url);
    });
  });
}

async function lastOpenedUrl(app: ElectronApplication): Promise<string> {
  return app.evaluate(async () => {
    const g = globalThis as unknown as { __openedUrls?: string[] };
    const urls = g.__openedUrls ?? [];
    return urls[urls.length - 1];
  });
}

test('feedback: bug report hands off to a pre-filled GitHub issue URL', async () => {
  const { app, page, close } = await launchApp();

  try {
    await captureOpenExternal(app);

    await page.getByTestId('report-bug-btn').click();
    const dialog = page.getByTestId('feedback-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('feedback-title')).toBeVisible();
    await expect(page.getByTestId('feedback-description')).toBeVisible();

    // GitHub button is disabled until a title is entered.
    await expect(page.getByTestId('feedback-github')).toBeDisabled();

    await page.getByTestId('feedback-title').fill('Crash when importing sphere.xml');
    await page
      .getByTestId('feedback-description')
      .fill('The viewer freezes right after the import wizard closes.');

    // This test exercises the plain (no-attachment) handoff, so untick the
    // "Attach session logs" box (defaults ON for bug reports) — otherwise the
    // send would route through the save dialog. The attach path is covered by
    // its own test below.
    await page.getByTestId('feedback-include-logs').uncheck();

    await expect(page.getByTestId('feedback-github')).toBeEnabled();
    await page.getByTestId('feedback-github').click();

    // Dialog closes after handoff.
    await expect(dialog).not.toBeVisible();

    const url = await lastOpenedUrl(app);
    expect(url).toContain('/issues/new?');
    const params = new URL(url).searchParams;
    expect(params.get('title')).toBe('Crash when importing sphere.xml');
    expect(params.get('labels')).toBe('bug');
    expect(params.get('template')).toBe('bug.yml');

    const body = params.get('body') ?? '';
    expect(body).toContain('The viewer freezes right after the import wizard closes.');
    // Auto-attached diagnostics — real values from backend.getInfo().
    expect(body).toContain('## Environment');
    expect(body).toMatch(/- Phytograph: \d+\.\d+\.\d+/);
    expect(body).toMatch(/- Backend: \d+\.\d+\.\d+/);
    // Engine versions baked in at build time from the git submodules — real,
    // non-empty, not the "unknown" fallback.
    expect(body).toMatch(/- PyHelios: \S+/);
    expect(body).not.toContain('- PyHelios: unknown');
    expect(body).toMatch(/- Helios \(C\+\+\): \S+/);
    expect(body).not.toContain('- Helios (C++): unknown');
    expect(body).toMatch(/- OS: (darwin|win32|linux)/);
  } finally {
    await close();
  }
});

test('feedback: feature request hands off to a pre-filled mailto URL', async () => {
  const { app, page, close } = await launchApp();

  try {
    await captureOpenExternal(app);

    await page.getByTestId('request-feature-btn').click();
    const dialog = page.getByTestId('feedback-dialog');
    await expect(dialog).toBeVisible();

    await page.getByTestId('feedback-title').fill('Add dark mode');
    await page.getByTestId('feedback-description').fill('A dark theme would help in the field.');

    await page.getByTestId('feedback-email').click();
    await expect(dialog).not.toBeVisible();

    const url = await lastOpenedUrl(app);
    expect(url.startsWith('mailto:')).toBe(true);
    // Subject + body are percent-encoded; decode to assert content.
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('[Phytograph Feature request] Add dark mode');
    expect(decoded).toContain('A dark theme would help in the field.');
    expect(decoded).toContain('## Feature request');
    expect(decoded).toMatch(/- Phytograph: \d+\.\d+\.\d+/);
  } finally {
    await close();
  }
});

test('feedback: "Attach session logs" writes a real combined log file and names it in the report', async () => {
  const { app, page, close } = await launchApp();
  const savePath = join(tmpdir(), `phytograph-e2e-logs-${Date.now()}.txt`);

  try {
    await captureOpenExternal(app);
    await stubSaveDialog(app, savePath);

    await page.getByTestId('report-bug-btn').click();
    const dialog = page.getByTestId('feedback-dialog');
    await expect(dialog).toBeVisible();

    // The checkbox defaults ON for bug reports.
    const includeLogs = page.getByTestId('feedback-include-logs');
    await expect(includeLogs).toBeChecked();

    await page.getByTestId('feedback-title').fill('Backend error during fit');
    await page.getByTestId('feedback-description').fill('Got a 500 on /api/fit.');

    await page.getByTestId('feedback-github').click();
    await expect(dialog).not.toBeVisible();

    // The combined log file was written to disk and is non-trivial.
    expect(existsSync(savePath)).toBe(true);
    const contents = readFileSync(savePath, 'utf-8');
    expect(contents.length).toBeGreaterThan(100);
    // Structural markers from copySessionLogTo's assembled output.
    expect(contents).toContain('Phytograph session log export');
    expect(contents).toContain('main / renderer / backend');
    // Real backend output captured via the sidecar stdout/stderr tee: the
    // wrapper logs a distinctive "Starting server on http://127.0.0.1:<port>"
    // line at boot. Asserting it proves the [backend] stream actually reached
    // the unified file — the whole point of the tee.
    expect(contents).toMatch(/Starting server on http:\/\/127\.0\.0\.1:\d+/);

    // The handoff URL body points the user at the file they need to drag in.
    const url = await lastOpenedUrl(app);
    const body = new URL(url).searchParams.get('body') ?? '';
    expect(body).toContain('## Session logs');
    expect(body).toContain(savePath.split(/[\\/]/).pop()!);
  } finally {
    if (existsSync(savePath)) rmSync(savePath, { force: true });
    await close();
  }
});
