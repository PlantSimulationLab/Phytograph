import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launchApp';

// Drives the About dialog end-to-end against the LIVE app. The dialog replaces
// Electron's native About panel (which would show the Electron framework logo
// and Electron's own version). It lists four versions, each from a live source:
//   - Application + Backend  → IPC backend.getInfo() (app.getVersion() /
//     EXPECTED_BACKEND_VERSION)
//   - PyHelios + Helios (C++) → src/shared/generated/versionInfo.ts, captured at
//     build time by scripts/gen-version-info.mjs from the git submodules.
//
// The dialog is menu-only (no toolbar button), so we trigger it the same way
// the import-menu-paths test does: send the real menu:command IPC to the
// renderer. That exercises the real App handler, real getInfo(), and the real
// baked-in submodule versions — no stubbing.
//
// What's under test is correctness, not "didn't throw": every version row must
// render a real, plausible value, and the two submodule versions must NOT be
// Electron's version (the bug this feature fixes).

test('about: dialog shows app, backend, and both submodule versions', async () => {
  const { app, page, close } = await launchApp();

  try {
    // Wait for the renderer to be ready (its onMenuCommand listener registered)
    // before driving the menu — the empty-viewer hint marks a loaded App.
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // Open via the real menu command (App's onMenuCommand → setAboutOpen).
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: 'about' });
    });

    const dialog = page.getByTestId('about-dialog');
    await expect(dialog).toBeVisible();

    // App + backend versions are semver (e.g. 0.13.1), sourced from getInfo().
    const appVersion = page.getByTestId('about-version-application');
    const backendVersion = page.getByTestId('about-version-backend');
    await expect(appVersion).toHaveText(/^\d+\.\d+\.\d+/);
    await expect(backendVersion).toHaveText(/^\d+\.\d+\.\d+/);

    // Submodule versions are git-describe strings (e.g. v0.1.22, v1.3.74), baked
    // in at build time. They must be present and must NOT match Electron's
    // version (the whole point: the native panel used to show Electron's).
    const pyheliosVersion = page.getByTestId('about-version-pyhelios');
    const heliosVersion = page.getByTestId('about-version-helios-c');
    await expect(pyheliosVersion).toHaveText(/.+/);
    await expect(heliosVersion).toHaveText(/.+/);

    const pyheliosText = (await pyheliosVersion.textContent())?.trim() ?? '';
    const heliosText = (await heliosVersion.textContent())?.trim() ?? '';
    const electronVersion = await app.evaluate(() => process.versions.electron);

    expect(pyheliosText.length).toBeGreaterThan(0);
    expect(pyheliosText).not.toBe('unknown');
    expect(pyheliosText).not.toBe(electronVersion);
    expect(heliosText.length).toBeGreaterThan(0);
    expect(heliosText).not.toBe('unknown');
    expect(heliosText).not.toBe(electronVersion);

    // Closing the dialog removes it.
    await page.getByTestId('about-dialog').getByRole('button').first().click();
    await expect(dialog).not.toBeVisible();
  } finally {
    await close();
  }
});
