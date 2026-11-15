import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// Issue #7: a 13-scan orchard stitch outran a fixed 5-minute client deadline
// and failed after the backend had done all the work. A stitch now streams
// progress, can be canceled, asks before a merge past the cost guideline
// ("Large stitch"), and can leave sky/miss points out of the merged cloud.
//
// The cost guideline is pinned to 0 s for this app (PHYTOGRAPH_COST_WARNING_SECONDS
// reaches the backend through the supervisor's env), so EVERY stitch prompts and
// the prompt's three outcomes can be driven on small fixtures. Live backend, real
// dialogs; results read from the scan rows.
//
// Fixtures: both E57s carry sky/miss returns (structured-scan.e57 is 15 hits +
// 5 misses; see import-e57-misses.spec.ts). A scan row counts HITS only, and
// offers the "Show misses" toggle only when the cloud carries misses, which is
// how the spec tells a merge that kept misses from one that dropped them.
const E57_A = join(repoRoot, 'tests', 'e2e', 'fixtures', 'structured-scan.e57');
const E57_B = join(repoRoot, 'tests', 'e2e', 'fixtures', 'structured-scan-color.e57');

let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp({ PHYTOGRAPH_COST_WARNING_SECONDS: '0' });
});
test.afterAll(async () => {
  await session?.close();
});
test.beforeEach(async () => {
  await resetToFreshScene(session.app, session.page);
});

async function importBothAndOpenStitch(page: Page): Promise<number> {
  await importFiles(session.app, page, 'import-auto', [E57_A, E57_B]);
  await completeImportWizard(page);
  const rows = page.getByTestId('scan-row');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  let hits = 0;
  for (const row of await rows.all()) {
    const id = await row.getAttribute('data-scan-id');
    await expect(page.getByTestId(`scan-toggle-misses-${id}`)).toBeVisible();
    hits += Number(await row.getAttribute('data-point-count'));
  }
  expect(hits).toBeGreaterThan(15);
  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
  await page.getByTestId('tool-cloud-stitch').click();
  await expect(page.getByTestId('stitch-dialog')).toBeVisible();
  return hits;
}

async function mergedRowHasMisses(page: Page, hits: number): Promise<boolean> {
  const rows = page.getByTestId('scan-row');
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  const merged = rows.first();
  await expect(merged).toHaveAttribute('data-point-count', String(hits), { timeout: 30_000 });
  await expect(merged).toHaveAttribute('data-octree', 'true');
  const id = await merged.getAttribute('data-scan-id');
  return page.getByTestId(`scan-toggle-misses-${id}`).isVisible();
}

test('a large stitch asks first; "Stitch anyway" merges with misses kept', async () => {
  const { page } = session;
  const hits = await importBothAndOpenStitch(page);
  const dialog = page.getByTestId('stitch-dialog');
  // Offered because the selected clouds carry misses; on by default.
  await expect(dialog.getByTestId('stitch-include-misses').locator('input')).toBeChecked();
  await dialog.getByTestId('stitch-run').click();

  const prompt = page.getByTestId('stitch-cost-dialog');
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('stitch-cost-message')).toContainText('Stitching 2 clouds');
  await expect(page.getByTestId('stitch-cost-message')).toContainText('sky/miss');
  // Nothing was merged while the prompt is up.
  await expect(page.getByTestId('scan-row')).toHaveCount(2);

  await page.getByTestId('stitch-cost-confirm').click();
  await expect(prompt).toHaveCount(0);
  expect(await mergedRowHasMisses(page, hits)).toBe(true);
});

test('"Stitch without sky/miss points" merges the hits only', async () => {
  const { page } = session;
  const hits = await importBothAndOpenStitch(page);
  await page.getByTestId('stitch-dialog').getByTestId('stitch-run').click();

  await page.getByTestId('stitch-cost-without-misses').click();
  // The smaller request is estimated afresh (and, at a 0 s guideline, still
  // prompts) — this time with nothing left to leave out.
  const prompt = page.getByTestId('stitch-cost-dialog');
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('stitch-cost-message')).not.toContainText('sky/miss');
  await expect(page.getByTestId('stitch-cost-without-misses')).toHaveCount(0);
  await page.getByTestId('stitch-cost-confirm').click();

  expect(await mergedRowHasMisses(page, hits)).toBe(false);
});

test('unticking "Include sky/miss points" in the dialog drops them too', async () => {
  const { page } = session;
  const hits = await importBothAndOpenStitch(page);
  const dialog = page.getByTestId('stitch-dialog');
  await dialog.getByTestId('stitch-include-misses').locator('input').uncheck();
  await dialog.getByTestId('stitch-run').click();

  await expect(page.getByTestId('stitch-cost-dialog')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('stitch-cost-without-misses')).toHaveCount(0);
  await page.getByTestId('stitch-cost-confirm').click();

  expect(await mergedRowHasMisses(page, hits)).toBe(false);
});

test('canceling the prompt leaves both clouds untouched', async () => {
  const { page } = session;
  await importBothAndOpenStitch(page);
  await page.getByTestId('stitch-dialog').getByTestId('stitch-run').click();
  await page.getByTestId('stitch-cost-cancel').click();
  await expect(page.getByTestId('stitch-cost-dialog')).toHaveCount(0);
  await expect(page.getByTestId('scan-row')).toHaveCount(2);
  await expect(page.getByTestId('bulk-import-progress')).toHaveCount(0);
});
