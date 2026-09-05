import type { ElectronApplication, Page } from '@playwright/test';
import { expect } from '@playwright/test';

// Resets a shared app session to the fresh, empty state between tests — the
// in-app equivalent of relaunching. File → New remounts the App+SceneProvider
// subtree and frees every backend session it was holding (see new-reset.spec.ts
// for the flow's own coverage), so tests that share one launched app via
// beforeAll still each start from a clean scene, without paying the ~5-40s
// Electron + PyInstaller boot per test.
//
// Shared-session pattern (see bulk-actions.spec.ts for the reference):
//
//   let session: LaunchedApp;
//   test.beforeAll(async () => { session = await launchApp(); });
//   test.afterAll(async () => { await session?.close(); });
//   test.beforeEach(async () => { await resetToFreshScene(session.app, session.page); });
//
// Keep a per-test launchApp() only where the test is about app/launch lifecycle
// itself (fresh-boot splash, octree cache recovery, session release on quit).
export async function resetToFreshScene(app: ElectronApplication, page: Page): Promise<void> {
  // A failed prior test can leave a popup/modal open on the shared page, which
  // would sit above the New dialog. Escape is a no-op on a clean scene.
  await page.keyboard.press('Escape');

  // Fire File → New — the same `menu:command { kind: 'new' }` IPC the native
  // menu sends (the menu itself is inert under E2E) — then confirm for real.
  const sendNew = () => app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: 'new' });
  });
  const dialog = page.getByTestId('new-confirm-dialog');

  // Re-send until the dialog answers, rather than sending once and waiting.
  // The renderer only subscribes to `menu:command` in an App.tsx effect, and
  // launchApp() returns as soon as the BACKEND serves /version — which on a
  // slow CI runner is before that effect has run. So the first reset of a
  // shared session (beforeEach of the file's first test) could send `new` to
  // nobody and then wait out a 15 s toBeVisible on a dialog that was never
  // asked to open: auto-register-clouds, grid-snap-roundtrip and
  // ground-outliers all failed exactly this way on CI, always on the first
  // test of the file and never locally. Opening the dialog is idempotent
  // (`setNewConfirmOpen(true)`), so a duplicate send once the listener is up
  // is harmless.
  await expect.poll(async () => {
    await sendNew();
    return dialog.isVisible();
  }, { intervals: [250, 500, 1000, 1000, 2000], timeout: 30_000 }).toBe(true);
  await page.getByTestId('new-confirm-clear').click();

  // Back to the fresh empty state: hint visible, zero layer rows of any kind.
  await expect(page.getByTestId('empty-viewer-hint')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="scan-row"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="mesh-row"]')).toHaveCount(0);
}
