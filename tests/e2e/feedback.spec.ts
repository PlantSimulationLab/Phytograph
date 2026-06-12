import { test, expect, type ElectronApplication } from '@playwright/test';
import { launchApp } from './helpers/launchApp';

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
