import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Closing the app destroys the entire session — nothing in Phytograph is
// auto-persisted, and every edit after import (crop, erase, filter, bake,
// label) exists only in renderer RAM plus backend session memory. So a stray
// click on the window's X used to discard all of it with no warning.
//
// These specs drive the REAL main-process 'close' handler. The confirmation is
// a native modal, which under E2E has no driver to dismiss it (a previous
// beforeunload-based attempt hung Playwright's teardown for the full 180 s
// timeout — see the comment in PointCloudViewer.tsx), so main answers it from
// PHYTOGRAPH_E2E_QUIT_CONFIRM instead of opening a dialog. The handler, the
// renderer's dirty-state push and the preventDefault() are all genuine; only
// the pixels are stubbed.
//
// Per-test launches are deliberate: these tests ARE about close lifecycle, so
// each needs its own app to close. (The documented exception to the shared-app
// rule in CLAUDE.md, same as octree-cache-recovery.spec.ts.)

/** Close the window the way the X button does, and report what happened. */
async function closeWindow(app: import('@playwright/test').ElectronApplication) {
  return app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.close();
    // The guard is synchronous, but let Electron settle the close/destroy.
    await new Promise((r) => setTimeout(r, 500));
    return {
      windows: BrowserWindow.getAllWindows().length,
      prompts: ((globalThis as Record<string, unknown>).__quitConfirmShown as number) ?? 0,
    };
  });
}

test('a close is CANCELLED when the user declines, and the session survives intact', async () => {
  const app = await launchApp({ PHYTOGRAPH_E2E_QUIT_CONFIRM: 'cancel' });

  // Import a real cloud so the scene is dirty through the genuine renderer
  // push, not a hand-set flag.
  await importFiles(app.app, app.page, 'import-point-cloud', [TINY]);
  await completeImportWizard(app.page);
  const rows = app.page.locator('[data-testid="scan-row"]');
  await expect(rows).toHaveCount(1, { timeout: 20_000 });

  const result = await closeWindow(app.app);

  // The prompt fired, and declining kept the window alive.
  expect(result.prompts).toBe(1);
  expect(result.windows).toBe(1);

  // The point of cancelling: the work is still there and still usable. A
  // confirmation that saved the window but lost the scene would be useless.
  await expect(rows).toHaveCount(1);

  // Teardown: the guard would cancel Playwright's close too, so tell main the
  // scene is clean first (the same IPC the renderer sends after File → New).
  await app.page.evaluate(() => {
    (window as unknown as { electronAPI: { setSceneDirty: (p: unknown) => void } })
      .electronAPI.setSceneDirty({ dirty: false, strokes: 0 });
  });
  await app.close().catch(() => {});
});

test('a close PROCEEDS when the user accepts', async () => {
  const app = await launchApp({ PHYTOGRAPH_E2E_QUIT_CONFIRM: 'discard' });

  await importFiles(app.app, app.page, 'import-point-cloud', [TINY]);
  await completeImportWizard(app.page);
  await expect(app.page.locator('[data-testid="scan-row"]')).toHaveCount(1, { timeout: 20_000 });

  const result = await closeWindow(app.app);

  expect(result.prompts).toBe(1);
  expect(result.windows).toBe(0);

  await app.close().catch(() => {});
});

test('an EMPTY scene closes with no prompt at all', async () => {
  // Never make the user click twice to close an app they just opened. The
  // answer here is 'cancel', so a prompt would BLOCK the close — the window
  // going away is itself the proof that none was raised.
  const app = await launchApp({ PHYTOGRAPH_E2E_QUIT_CONFIRM: 'cancel' });

  const result = await closeWindow(app.app);

  expect(result.prompts).toBe(0);
  expect(result.windows).toBe(0);

  await app.close().catch(() => {});
});
