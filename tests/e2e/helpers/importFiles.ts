import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { basename, dirname, resolve } from 'node:path';

// File→Import menu command kinds (mirror of MenuCommandPayload's import
// variants in src/shared/ipc.ts).
export type ImportKind =
  | 'import-auto' | 'import-point-cloud' | 'import-mesh' | 'import-skeleton' | 'import-qsm' | 'import-scan-xml';

// Pages whose last importFiles() already clicked Import in the browser, so a
// following completeImportWizard() has nothing to do (see importWizard.ts).
export const importedViaBrowser = new WeakSet<Page>();

// Imports files through File→Import — the real pathway, end to end.
//
// File→Import opens the in-app file browser (FileBrowserDialog). Unlike the OS
// dialog it replaced, it is ordinary DOM, so nothing is stubbed: this types the
// fixtures' folder into the path bar, selects each fixture in the list, and
// clicks Import. The browser asks main to grant the chosen paths, and main
// grants only paths its own listing returned (src/main/fileBrowser.ts) — so
// the fs allowlist is exercised for real too.
//
// `keepOpen` leaves the browser open with the files selected, for a test that
// sets import options in its right-hand panel (the same `import-wizard-*`
// controls the modal wizard renders) before calling completeImportWizard().
//
// Every fixture must sit in ONE folder: a browser selection, like an OS open
// dialog's, cannot span folders.
export async function importFiles(
  app: ElectronApplication,
  page: Page,
  kind: ImportKind,
  files: string | string[],
  opts: { keepOpen?: boolean } = {},
): Promise<void> {
  const paths = (Array.isArray(files) ? files : [files]).map((p) => resolve(p));
  const dirs = [...new Set(paths.map((p) => dirname(p)))];
  if (dirs.length !== 1) {
    throw new Error(`importFiles: fixtures must share one folder, got ${dirs.join(', ')}`);
  }
  const dir = dirs[0];
  importedViaBrowser.delete(page);

  // The menu command is delivered to the renderer's onMenuCommand subscriber
  // (registered in a React effect). Wait until the app has mounted before
  // firing, or the IPC arrives before anything is listening and is dropped.
  //
  // 60 s, not Playwright's default 30 s: launchApp() only waits for the BACKEND
  // to serve /version, not for the renderer to mount. On the headless CI runner
  // two Playwright workers each drive an Electron app plus a PyInstaller
  // backend, and first paint (Vite bundle + R3F canvas) can exceed 30 s under
  // that contention — a per-test launchApp() spec then dies here before it has
  // done anything. Locally this mounts in ~2 s, which is why it only ever failed
  // in CI.
  await page.getByTestId('app-dropzone-input').waitFor({ state: 'attached', timeout: 60_000 });

  await app.evaluate(({ BrowserWindow }, k) => {
    // IPC.MenuCommand === 'menu:command' (src/shared/ipc.ts). Hard-coded
    // because the evaluate body is serialized into the main process and can't
    // close over TS imports.
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: k });
  }, kind);

  const browser = page.getByTestId('file-browser');
  await expect(browser).toBeVisible({ timeout: 30_000 });

  const pathBar = page.getByTestId('file-browser-path');
  await pathBar.fill(dir);
  await pathBar.press('Enter');
  await expect(browser).toHaveAttribute('data-dir', dir, { timeout: 15_000 });

  for (let i = 0; i < paths.length; i++) {
    let row = await revealRow(page, basename(paths[i]));
    if (!row) {
      // The type filter hides it: some specs import a fixture under a type
      // whose filter excludes it, to test the importer's routing. Show all
      // files, as a user would, and look again. Only then — so every other
      // import exercises the real per-type filter.
      await page.getByTestId('file-browser-type').selectOption('all');
      row = await revealRow(page, basename(paths[i]));
      if (!row) throw new Error(`importFiles: "${basename(paths[i])}" is not in the file browser's listing`);
    }
    await row.click({ modifiers: i === 0 ? [] : [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  }
  await expect(page.getByTestId('file-browser-summary')).toContainText(`${paths.length} selected`);

  if (opts.keepOpen) return;

  const importBtn = page.getByTestId('file-browser-import');
  // Enabled once every selected point cloud's header preview has landed.
  await expect(importBtn).toBeEnabled({ timeout: 30_000 });
  await importBtn.click();
  await expect(browser).toBeHidden({ timeout: 30_000 });
  // Only a point cloud imported as one would have met the wizard, so only
  // then can a caller follow up with completeImportWizard(). Scoping the flag
  // this way keeps a mesh or QSM import (.ply/.csv share point-cloud
  // extensions) from leaving it set for a later drag-drop test's wizard.
  const asPointCloud = kind === 'import-point-cloud' || kind === 'import-auto';
  if (asPointCloud && paths.some((p) => POINT_CLOUD_EXT.test(p))) importedViaBrowser.add(page);
}

// Mirrors POINT_CLOUD_FORMATS (src/renderer/lib/pointCloudParsers.ts).
const POINT_CLOUD_EXT = /\.(las|laz|e57|ptx|ply|pcd|xyz|txt|csv|pts|asc|ascii)$/i;

// The list renders only the rows in view (folders can hold thousands of
// files), so scroll it, as a user would, until the row exists.
async function revealRow(page: Page, name: string): Promise<Locator | null> {
  const row = page.locator(`[data-testid="file-browser-entry"][data-name="${name.replace(/"/g, '\\"')}"]`);
  const list = page.getByTestId('file-browser-list');
  // Each scroll re-renders the window on the next frame; looking before then
  // can find a row rendered for the OLD position that is about to unmount.
  const settle = () => page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await list.evaluate((el) => { el.scrollTop = 0; });
  await settle();
  for (let step = 0; step < 400; step++) {
    if (await row.count() > 0) return row;
    const atEnd = await list.evaluate((el) => {
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.8;
      return el.scrollTop === before;
    });
    await settle();
    if (atEnd) return (await row.count()) > 0 ? row : null;
  }
  throw new Error(`importFiles: gave up scrolling to "${name}"`);
}
