import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const fixture = (name: string) => join(repoRoot, 'tests', 'e2e', 'fixtures', name);
const TREE = fixture('tree.xyz');

// File → New resets the app to a fresh, empty state — the same as relaunching
// it. The renderer handles this in-place by remounting the App + SceneProvider
// subtree (a key bump in Root), giving a fresh empty SceneProvider without a
// window reload or backend re-probe; before remounting it frees every backend
// session it was holding so the long-lived sidecar doesn't leak that RAM.
//
// Per CLAUDE.md: live backend, drive the real UI, assert concrete outcomes.
// We import a real octree-backed cloud (so a real /api/cloud/session is created),
// fire the real `menu:command { kind: 'new' }` (the same IPC the native File
// menu sends — the menu itself is inert under E2E), click the actual confirm
// button, then assert two concrete things:
//   1. the renderer is back to the fresh empty state (no scan rows, empty hint), and
//   2. the backend session the cloud held was actually freed — a direct DELETE
//      now reports deleted:false because New already removed it.

test('File → New clears all data and frees backend sessions', async () => {
  const { app, page, close } = await launchApp();
  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // Capture the backend session URL created by the import. The renderer POSTs
    // /api/cloud/session/create; the response carries the new session_id. We
    // reconstruct the per-session DELETE URL from that request's origin so we
    // can probe the backend directly after the reset.
    const createResponse = page.waitForResponse(
      (r) => r.url().includes('/api/cloud/session/create') && r.request().method() === 'POST',
    );

    await importFiles(app, page, 'import-point-cloud', [TREE]);
    await completeImportWizard(page);

    const original = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
    await expect(original).toHaveCount(1, { timeout: 20_000 });
    await expect(original).toHaveAttribute('data-octree', 'true');

    const created = await (await createResponse).json();
    const sessionId: string = created.session_id;
    expect(sessionId).toBeTruthy();
    const apiOrigin = new URL((await createResponse).url()).origin;
    const sessionUrl = `${apiOrigin}/api/cloud/session/${sessionId}`;

    // Fire File → New (same IPC the native menu sends) and confirm.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: 'new' });
    });
    const dialog = page.getByTestId('new-confirm-dialog');
    await expect(dialog).toBeVisible();

    // Cancelling first must be a no-op: the cloud is still there.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(original).toHaveCount(1);

    // Re-open and actually clear. Clicking "Clear everything" frees sessions and
    // remounts the renderer subtree to a fresh empty state.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: 'new' });
    });
    await expect(dialog).toBeVisible();
    await page.getByTestId('new-confirm-clear').click();

    // The renderer remounts to a fresh state: empty hint back, zero scan rows.
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="scan-row"]')).toHaveCount(0);

    // The backend session was freed by the reset. Deleting it now reports it
    // no longer existed (deleted:false) — the proof New released backend RAM,
    // not just the renderer's view of it.
    const deleted = await page.evaluate(async (url) => {
      const res = await fetch(url, { method: 'DELETE' });
      return res.json();
    }, sessionUrl);
    expect(deleted.deleted).toBe(false);
  } finally {
    await close();
  }
});
