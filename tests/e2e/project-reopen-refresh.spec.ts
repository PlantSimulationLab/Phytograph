import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { stubSaveDialog } from './helpers/stubSaveDialog';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubMessageBox } from './helpers/stubMessageBox';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'scalars.xyz');

// A cloud saved while its display refresh was still pending reopens drawing
// the old octree under the committed mask — and used to stay that way, since
// only a NEW edit ever queued the rebuild. Opening the project now queues it.
//
// The pending state is produced the way a user produces it: Remove points,
// then Cancel on the "Updating display…" pill before the rebuild lands. The
// cloud is already filtered (the backend deleted the points) and the mask
// hides them on the old octree; only the display is behind.
//
// One test, one app: the steps are one workflow.
let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});

async function menu(app: LaunchedApp['app'], kind: string) {
  await app.evaluate(({ BrowserWindow }, k) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: k });
  }, kind);
}

test('a project saved mid-refresh finishes the refresh when reopened', async () => {
  test.setTimeout(4 * 60_000);
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  const row = page.locator('[data-testid="scan-row"][data-scan-name="scalars"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-selected', 'true');
  const importedCacheId = (await row.getAttribute('data-octree-cache-id'))!;

  await page.getByTestId('tool-filter').click();
  await page.getByTestId('filter-field-select').selectOption('scalar:Deviation');
  await page.getByTestId('filter-min-input').fill('0');
  await page.getByTestId('filter-max-input').fill('2');
  await page.getByTestId('filter-remove').click();
  await page.getByTestId('octree-refresh-running-cancel').click({ timeout: 10_000 });
  await expect(page.getByTestId('octree-refresh-running')).toHaveCount(0, { timeout: 30_000 });

  // Filtered, but still drawn from the imported octree under the mask.
  await expect(row).toHaveAttribute('data-point-count', '36', { timeout: 30_000 });
  expect(await row.getAttribute('data-octree-cache-id'),
    'the refresh landed before Cancel could stop it, so there is nothing pending to save')
    .toBe(importedCacheId);

  const projectPath = join(tmpdir(), `phyto-reopen-refresh-${Date.now()}.phyto`);
  try {
    await stubSaveDialog(app, projectPath);
    await menu(app, 'save-project');
    await expect(page.locator('[data-testid="toast-success"]').filter({ hasText: 'Project Saved' }))
      .toBeVisible({ timeout: 120_000 });

    await stubMessageBox(app, 0);
    await stubOpenDialog(app, projectPath);
    await menu(app, 'open-project');
    await expect(page.locator('[data-testid="toast-success"]').filter({ hasText: 'Project Opened' }))
      .toBeVisible({ timeout: 120_000 });

    // The reopened cloud gets the octree the canceled refresh would have
    // built: a new display holding exactly the 36 kept points, with no edit.
    const reopened = page.locator('[data-testid="scan-row"][data-scan-name="scalars"]');
    await expect(reopened).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => reopened.getAttribute('data-octree-cache-id'), { timeout: 60_000 })
      .not.toBe(importedCacheId);
    await expect(page.getByTestId('octree-refresh-running')).toHaveCount(0, { timeout: 60_000 });
    await expect(reopened).toHaveAttribute('data-point-count', '36');
    const cid = (await reopened.getAttribute('data-octree-cache-id'))!;
    await expect.poll(() => page.evaluate((k) => {
      const s = (window as { __octreeMaskByCloud?: Record<string, { drawn: number; full: number }> })
        .__octreeMaskByCloud?.[k];
      return s ? { drawn: s.drawn, full: s.full } : null;
    }, cid), { timeout: 30_000 }).toEqual({ drawn: 36, full: 36 });
  } finally {
    rmSync(projectPath, { force: true });
  }
});
