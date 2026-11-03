import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { getMessageBoxCalls, stubMessageBox } from './helpers/stubMessageBox';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubSaveDialog } from './helpers/stubSaveDialog';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// A backend crash takes every session with it, while the project on disk still
// holds those clouds. Cmd+S names that same file, and used to replace it with a
// shell holding no clouds, say "Saved", and clear the unsaved-changes prompt.
//
// One app, because this kills the app's real backend and needs its respawn.
let session: LaunchedApp;
let dir: string;
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'project-after-crash-'));
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function menu(kind: string) {
  await session.app.evaluate(({ BrowserWindow }, k) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: k });
  }, kind);
}

test('saving after a backend crash cannot destroy the project on disk', async () => {
  test.skip(process.platform === 'win32', 'kills the backend with lsof/kill');
  test.setTimeout(4 * 60_000);
  const { app, page } = session;
  const project = join(dir, 'plot.phyto');
  const recovered = join(dir, 'recovered.phyto');

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);
  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(row).toHaveAttribute('data-point-count', '60', { timeout: 20_000 });

  await stubSaveDialog(app, project);
  await menu('save-project');
  await expect(page.locator('[data-testid="toast-success"]').filter({ hasText: 'Project Saved' }))
    .toBeVisible({ timeout: 60_000 });
  const good = readFileSync(project);
  expect(good.length).toBeGreaterThan(1000);

  // A real crash: SIGKILL whatever is listening, and wait for the respawn.
  const { url } = await page.evaluate(() => (window as any).electronAPI.backend.getInfo());
  const port = new URL(url).port;
  execSync(`kill -9 $(lsof -ti :${port} -sTCP:LISTEN)`, { shell: '/bin/sh' });
  await expect(page.locator('[data-testid="toast-title"]').filter({ hasText: 'The backend restarted' }))
    .toBeVisible({ timeout: 90_000 });

  // Cmd+S, and Cancel at the warning: the file is exactly what it was.
  await stubMessageBox(app, 1);
  await menu('save-project');
  await expect.poll(async () => (await getMessageBoxCalls(app)).length, { timeout: 30_000 }).toBe(1);
  const calls = await getMessageBoxCalls(app) as Array<{ message: string; detail: string }>;
  expect(calls[0].message).toContain('plot.phyto');
  expect(calls[0].detail).toContain('tiny');
  expect(readFileSync(project).equals(good)).toBe(true);
  await expect(page.locator('[data-testid="toast-success"]').filter({ hasText: 'Saved plot.phyto' }))
    .toHaveCount(0);

  // Cmd+S again, and Save As: a new file, and the original still untouched.
  await stubMessageBox(app, 0);
  await stubSaveDialog(app, recovered);
  await menu('save-project');
  await expect(page.locator('[data-testid="toast-warning"]').filter({ hasText: 'recovered.phyto' }))
    .toBeVisible({ timeout: 60_000 });
  expect(existsSync(recovered)).toBe(true);
  expect(readFileSync(project).equals(good)).toBe(true);

  // And the original really does still hold the cloud.
  await stubMessageBox(app, 0);
  await stubOpenDialog(app, project);
  await menu('open-project');
  await expect(page.locator('[data-testid="scan-row"][data-scan-name="tiny"]'))
    .toHaveAttribute('data-point-count', '60', { timeout: 60_000 });
  const { token } = await page.evaluate(() => (window as any).electronAPI.backend.getInfo());
  expect(token).toMatch(/^[0-9a-f]{64}$/);
});
