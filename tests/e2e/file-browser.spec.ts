import { test, expect, type Page } from '@playwright/test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { resetToFreshScene } from './helpers/resetApp';

// The in-app file browser that File → Import opens (FileBrowserDialog): browse
// on the left, import options on the right, one window.
//
// Per CLAUDE.md: live backend, real UI (path bar, list clicks, keyboard,
// options panel), concrete assertions (point counts, imported fields, the
// cloud's metric extent, persisted folder).
//
// Fixtures are fabricated per run in a temp folder, because two of the cases
// need a folder layout no committed fixture has: an unreadable subfolder, and
// two ASCII column layouts side by side.

let session: LaunchedApp;
let dir: string;

// 10 points each, z from 0 to 100 in FILE units (so cm -> a 1 m span).
function xyz(header: string, cols: number): string {
  const rows = Array.from({ length: 10 }, (_, i) => {
    const extra = Array.from({ length: cols - 3 }, (_, k) => (i * (k + 2)).toFixed(1));
    return [i * 3, i * 2, (i * 100) / 9, ...extra].join(' ');
  });
  return `${header}\n${rows.join('\n')}\n`;
}

test.beforeAll(async () => {
  // realpath: macOS's tmpdir is a /var -> /private/var symlink, and the
  // browser shows the path it was given, so compare against one spelling.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'phyto-browse-')));
  writeFileSync(join(dir, 'alpha.xyz'), xyz('X Y Z Foo Bar', 5));
  writeFileSync(join(dir, 'beta.xyz'), xyz('X Y Z Foo Bar', 5));
  writeFileSync(join(dir, 'gamma.xyz'), xyz('X Y Z Baz', 4));
  writeFileSync(join(dir, 'notes.md'), 'not a point cloud\n');
  writeFileSync(join(dir, 'secret.key'), 'do not read\n');
  // Header-less, so nothing auto-maps to X/Y/Z.
  writeFileSync(join(dir, 'raw.txt'), Array.from({ length: 5 }, (_, i) => `${i} ${i} ${i} a${i}`).join('\n') + '\n');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'inner.xyz'), xyz('X Y Z', 3));
  if (process.platform !== 'win32') {
    mkdirSync(join(dir, 'locked'));
    chmodSync(join(dir, 'locked'), 0o000);
  }
  session = await launchApp();
});

test.afterAll(async () => {
  await session?.close();
  try { chmodSync(join(dir, 'locked'), 0o755); } catch { /* none */ }
  rmSync(dir, { recursive: true, force: true });
});

test.beforeEach(async () => {
  await resetToFreshScene(session.app, session.page);
});

async function openBrowser(page: Page, kind = 'import-point-cloud') {
  await session.app.evaluate(({ BrowserWindow }, k) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: k });
  }, kind);
  const browser = page.getByTestId('file-browser');
  await expect(browser).toBeVisible({ timeout: 30_000 });
  return browser;
}

async function goTo(page: Page, path: string) {
  const bar = page.getByTestId('file-browser-path');
  await bar.fill(path);
  await bar.press('Enter');
  await expect(page.getByTestId('file-browser')).toHaveAttribute('data-dir', path);
}

// The display labels of the scalar fields a scan imported, from its expanded
// row in the Scans panel (as import-wizard.spec.ts reads them).
async function importedColumns(page: Page, scanName: string): Promise<string[]> {
  const row = page.locator(`[data-testid="scan-row"][data-scan-name="${scanName}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  const scanId = await row.getAttribute('data-scan-id');
  await page.getByTestId(`scan-expand-${scanId}`).click();
  const cols = page.getByTestId(`scan-columns-${scanId}`);
  await expect(cols).toBeVisible();
  const listed = ((await cols.locator('[data-columns]').getAttribute('data-columns')) ?? '').split(',');
  await page.getByTestId(`scan-expand-${scanId}`).click();
  return listed;
}

const names = (page: Page) =>
  page.getByTestId('file-browser-entry').evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));
const entry = (page: Page, name: string) =>
  page.locator(`[data-testid="file-browser-entry"][data-name="${name}"]`);

test('browses with the path bar, folders, breadcrumbs, back and places', async () => {
  const { page } = session;
  const browser = await openBrowser(page);
  await goTo(page, dir);

  // Point-cloud filter: the .xyz files and the folders, not notes.md.
  expect(await names(page)).toEqual(['locked', 'sub', 'alpha.xyz', 'beta.xyz', 'gamma.xyz', 'raw.txt']
    .filter((n) => process.platform !== 'win32' || n !== 'locked'));
  await page.getByTestId('file-browser-type').selectOption('all');
  await expect(entry(page, 'notes.md')).toBeVisible();

  // The name filter narrows the view.
  await page.getByTestId('file-browser-filter').fill('bet');
  expect(await names(page)).toEqual(['beta.xyz']);
  await page.getByTestId('file-browser-filter').fill('');

  // Into a folder by double-click, out by breadcrumb, then Back.
  await entry(page, 'sub').dblclick();
  await expect(browser).toHaveAttribute('data-dir', join(dir, 'sub'));
  expect(await names(page)).toEqual(['inner.xyz']);
  await page.locator(`[data-testid="file-browser-crumb"][data-path="${dir}"]`).click();
  await expect(browser).toHaveAttribute('data-dir', dir);
  await page.getByTestId('file-browser-back').click();
  await expect(browser).toHaveAttribute('data-dir', join(dir, 'sub'));

  // A typed FILE path opens its folder with that file selected.
  await goTo(page, dir); // establish the folder, then type a file inside it
  await page.getByTestId('file-browser-path').fill(join(dir, 'gamma.xyz'));
  await page.getByTestId('file-browser-path').press('Enter');
  await expect(entry(page, 'gamma.xyz')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('file-browser-primary')).toHaveText('gamma.xyz');

  // The Home place.
  await page.locator('[data-testid="file-browser-place"]').first().click();
  await expect(browser).toHaveAttribute('data-dir', homedir());

  // Cancel imports nothing.
  await page.getByTestId('file-browser-cancel').click();
  await expect(browser).toBeHidden();
  await expect(page.locator('[data-testid="scan-row"]')).toHaveCount(0);
});

test('an unreadable folder shows why instead of an empty list', async () => {
  test.skip(process.platform === 'win32', 'POSIX permissions');
  const { page } = session;
  await openBrowser(page);
  await goTo(page, join(dir, 'locked'));
  await expect(page.getByTestId('file-browser-error')).toContainText(/permission/i);
  await expect(page.getByTestId('file-browser-entry')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('file-browser')).toBeHidden();
});

test('the keyboard selects and imports: type-ahead, then Enter', async () => {
  const { page } = session;
  await openBrowser(page);
  await goTo(page, dir);
  await page.getByTestId('file-browser-list').focus();
  await page.keyboard.type('be');
  await expect(entry(page, 'beta.xyz')).toHaveAttribute('aria-selected', 'true');
  // The options panel previews the file it will import.
  await expect(page.locator('[data-testid="import-wizard-column"]')).toHaveCount(5, { timeout: 30_000 });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('file-browser')).toBeHidden({ timeout: 30_000 });

  const row = page.locator('[data-testid="scan-row"][data-scan-name="beta"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-point-count', '10');
});

test('one set of options applies to the whole selection, by layout', async () => {
  const { app, page } = session;
  // alpha + beta share "X Y Z Foo Bar"; gamma is "X Y Z Baz".
  await importFiles(app, page, 'import-point-cloud',
    [join(dir, 'alpha.xyz'), join(dir, 'beta.xyz'), join(dir, 'gamma.xyz')], { keepOpen: true });

  await expect(page.getByTestId('file-browser-primary')).toHaveText('alpha.xyz');
  const note = page.getByTestId('file-browser-batch-note');
  await expect(note).toContainText('1 share this column layout', { timeout: 30_000 });
  await expect(note).toContainText('1 has a different layout');

  // A COLUMN edit on alpha: drop Bar (column 4). beta has the same layout, so
  // it must lose Bar too; gamma has no such column and keeps its own Baz.
  const bar = page.locator('[data-testid="import-wizard-column"][data-col-index="4"]');
  await bar.getByTestId('import-wizard-include').uncheck();
  // A BATCH edit: the files are in centimeters. gamma declares no unit, so it
  // takes this too.
  await page.getByTestId('import-wizard-units-select').selectOption('cm');

  await page.getByTestId('file-browser-import').click();
  await expect(page.getByTestId('file-browser')).toBeHidden({ timeout: 30_000 });

  for (const name of ['alpha', 'beta', 'gamma']) {
    const row = page.locator(`[data-testid="scan-row"][data-scan-name="${name}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveAttribute('data-point-count', '10');
  }

  // Each scan's own imported columns, read from its expanded row.
  expect(await importedColumns(page, 'alpha')).toEqual(expect.arrayContaining(['Foo']));
  expect(await importedColumns(page, 'alpha')).not.toContain('Bar');
  expect(await importedColumns(page, 'beta')).toEqual(expect.arrayContaining(['Foo']));
  expect(await importedColumns(page, 'beta')).not.toContain('Bar'); // same layout: dropped too
  expect(await importedColumns(page, 'gamma')).toEqual(expect.arrayContaining(['Baz'])); // its own

  // Every file spans 0-100 cm in z, so the scene spans 1 m: all three were
  // converted, including gamma, whose layout differed.
  await expect.poll(async () => {
    const cam = await page.evaluate(() => (window as any).__getCameraState?.());
    return cam ? cam.bounds.max[2] - cam.bounds.min[2] : null;
  }, { timeout: 20_000 }).toBeCloseTo(1.0, 2);

  // The browser reopens where the last import came from.
  const browser = await openBrowser(page);
  await expect(browser).toHaveAttribute('data-dir', dir);
  await expect(page.locator(`[data-testid="file-browser-recent"][data-path="${dir}"]`)).toBeVisible();
  await page.getByTestId('file-browser-cancel').click();
});

test('a mesh and a point cloud in one Auto import: options only for the cloud', async () => {
  const { page } = session;
  writeFileSync(join(dir, 'tri.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  await openBrowser(page, 'import-auto');
  await goTo(page, dir);
  await entry(page, 'alpha.xyz').click();
  await entry(page, 'tri.obj').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(page.getByTestId('file-browser-primary')).toHaveText('alpha.xyz');
  await expect(page.getByTestId('file-browser-info')).toContainText('Mesh');
  const importBtn = page.getByTestId('file-browser-import');
  await expect(importBtn).toBeEnabled({ timeout: 30_000 });
  await importBtn.click();
  await expect(page.getByTestId('file-browser')).toBeHidden({ timeout: 30_000 });
  // No wizard: the cloud's options were already chosen in the browser.
  await expect(page.getByTestId('import-wizard')).toHaveCount(0);
  await expect(page.locator('[data-testid="scan-row"][data-scan-name="alpha"]'))
    .toHaveAttribute('data-point-count', '10', { timeout: 30_000 });
  await expect(page.locator('[data-testid="mesh-row"]')).toHaveCount(1, { timeout: 30_000 });
});

test('settings stay with the file they were chosen for', async () => {
  // A unit picked while looking at one file must not be replayed onto the
  // next file clicked: that would silently rescale a file whose own header
  // says something else.
  const { page } = session;
  await openBrowser(page);
  await goTo(page, dir);
  const units = page.getByTestId('import-wizard-units');
  await entry(page, 'alpha.xyz').click();
  await expect(units).toHaveAttribute('data-units', 'm', { timeout: 30_000 });
  await page.getByTestId('import-wizard-units-select').selectOption('cm');
  await expect(units).toHaveAttribute('data-units', 'cm');

  await entry(page, 'beta.xyz').click();
  await expect(page.getByTestId('file-browser-primary')).toHaveText('beta.xyz');
  await expect(units).toHaveAttribute('data-units', 'm', { timeout: 30_000 });

  // ...and come back with their file.
  await entry(page, 'alpha.xyz').click();
  await expect(units).toHaveAttribute('data-units', 'cm', { timeout: 30_000 });
  await page.getByTestId('file-browser-cancel').click();
});

test('a shift-click upward keeps the clicked file as the one whose options show', async () => {
  const { page } = session;
  await openBrowser(page);
  await goTo(page, dir);
  await entry(page, 'gamma.xyz').click();
  await entry(page, 'alpha.xyz').click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('file-browser-summary')).toContainText('3 selected');
  await expect(page.getByTestId('file-browser-primary')).toHaveText('gamma.xyz');
  await page.getByTestId('file-browser-cancel').click();
});

test('a file keeps its own column edits as a secondary, and the footer names it if X/Y/Z are missing', async () => {
  const { page } = session;
  await openBrowser(page);
  await goTo(page, dir);
  // Edit raw.txt's columns while it is the primary: take X away.
  await entry(page, 'raw.txt').click();
  const col0 = page.locator('[data-testid="import-wizard-column"][data-col-index="0"]');
  await expect(col0.getByTestId('import-wizard-role')).toHaveValue('x', { timeout: 30_000 });
  await col0.getByTestId('import-wizard-role').selectOption('skip');
  await expect(page.getByTestId('file-browser-unready')).toContainText('raw.txt');

  // Now make alpha (another layout) the primary and add raw.txt beside it.
  // raw.txt keeps the edit made on it, so the batch still can't import, and
  // the footer says which file to fix rather than pointing at alpha's panel.
  await entry(page, 'alpha.xyz').click();
  await entry(page, 'raw.txt').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(page.getByTestId('file-browser-primary')).toHaveText('alpha.xyz');
  await expect(page.getByTestId('file-browser-unready')).toContainText('raw.txt', { timeout: 30_000 });
  await expect(page.getByTestId('file-browser-unready')).not.toContainText('alpha.xyz');
  await expect(page.getByTestId('file-browser-import')).toBeDisabled();
  await page.getByTestId('file-browser-cancel').click();
});

test('a forged grant from the renderer cannot open a non-import file', async () => {
  // The browser runs in the renderer, so its IPCs can be called with no
  // browser on screen. Even after a real listing returned the file, a grant
  // for a non-importable one is refused and the fs bridge will not read it.
  const { page } = session;
  const result = await page.evaluate(async (folder) => {
    const api = (window as any).electronAPI;
    await api.fileBrowser.listDir(folder);
    const g = await api.fileBrowser.grant([`${folder}/secret.key`, `${folder}/alpha.xyz`]);
    let secretRead = 'refused';
    try { await api.fs.readText(`${folder}/secret.key`); secretRead = 'READ'; } catch { /* expected */ }
    const hidden = await api.fileBrowser.listDir(`${folder}/.hidden-dir`);
    return { refused: g.refused, granted: g.granted, secretRead, hiddenCode: hidden.code };
  }, dir);
  expect(result.refused).toEqual([join(dir, 'secret.key')]);
  expect(result.granted).toEqual([join(dir, 'alpha.xyz')]);
  expect(result.secretRead).toBe('refused');
  expect(result.hiddenCode).toBe('EHIDDEN');
});


test('Edit → Select All acts on the browser, not on the scene behind it', async () => {
  // The browser is in-page, so the native menu and its ⌘A accelerator stay
  // live while it is open. Before, Select All selected every scan behind it.
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', join(dir, 'alpha.xyz'));
  const scan = page.locator('[data-testid="scan-row"][data-scan-name="alpha"]');
  await expect(scan).toHaveAttribute('data-point-count', '10', { timeout: 30_000 });
  const send = (kind: string) => app.evaluate(({ BrowserWindow }, k) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: k });
  }, kind);
  // A new scan starts selected; with no browser open the menu acts on the scene.
  await send('deselect-all');
  await expect(scan).toHaveAttribute('data-selected', 'false');

  await openBrowser(page);
  await goTo(page, dir);

  // In the file list. (With the path bar focused, Select All selects its
  // text instead, as in any text field.)
  await page.getByTestId('file-browser-list').focus();
  await send('select-all');
  // Every file in view (alpha, beta, gamma, raw.txt), and not the scan.
  await expect(page.getByTestId('file-browser-summary')).toContainText('4 selected');
  await expect(scan).toHaveAttribute('data-selected', 'false');

  await send('deselect-all');
  await expect(page.getByTestId('file-browser-summary')).not.toContainText('selected');

  // A second File → Import while this one is open is ignored rather than
  // replacing it (the first import's promise would never settle).
  await send('import-mesh');
  await expect(page.getByTestId('file-browser')).toHaveCount(1);
  await expect(page.locator('h2', { hasText: 'Import point cloud' })).toBeVisible();
  await page.getByTestId('file-browser-cancel').click();
});

test('Back twice in quick succession walks back two folders', async () => {
  const { page } = session;
  const browser = await openBrowser(page);
  await goTo(page, dir);
  await entry(page, 'sub').dblclick();
  await expect(browser).toHaveAttribute('data-dir', join(dir, 'sub'));
  await page.getByTestId('file-browser-up').click();
  await expect(browser).toHaveAttribute('data-dir', dir);
  // History: [..., dir, dir/sub] -> now at dir. Two fast Backs must land on
  // dir/sub then on dir — not twice on the same entry.
  await page.getByTestId('file-browser-back').click();
  await page.getByTestId('file-browser-back').click();
  await expect(browser).toHaveAttribute('data-dir', dir);
  // And Forward retraces both steps.
  await page.getByTestId('file-browser-forward').click();
  await expect(browser).toHaveAttribute('data-dir', join(dir, 'sub'));
  await page.getByTestId('file-browser-forward').click();
  await expect(browser).toHaveAttribute('data-dir', dir);
  await page.getByTestId('file-browser-cancel').click();
});

test('type-ahead with nothing focused starts at the first row', async () => {
  const { page } = session;
  await openBrowser(page);
  await goTo(page, dir);
  await page.getByTestId('file-browser-list').focus();
  // alpha.xyz is the first "a" file; nothing is focused yet.
  await page.keyboard.type('a');
  await expect(entry(page, 'alpha.xyz')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('file-browser-cancel').click();
});
