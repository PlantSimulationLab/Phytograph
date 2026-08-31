import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { stubOpenDialog, getOpenDialogCalls, releaseOpenDialog } from './helpers/stubOpenDialog';
import { stubExportFolder } from './helpers/exportFolder';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// Data-only scan export (no XML) in a BINARY format — the "Export LAZ" path.
//
// The reported bug: clicking Export LAZ fired a success toast immediately, then
// opened the save picker, and after choosing a path showed no progress and no
// completion toast. So the only feedback the user got was a success message for
// work that hadn't started, and silence for the work that actually ran.
//
// The two properties asserted here are ORDERING ones, which is why the existing
// export-scan-xml.spec.ts missed this: it stubs the picker and asserts the files
// land, but never checks that nothing claims success BEFORE the picker fires, nor
// that a completion toast arrives AFTER.
let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});
test.beforeEach(async () => {
  await resetToFreshScene(session.app, session.page);
});

test('exports scan data as LAZ with no premature success toast and a real completion toast', async () => {
  const { app, page } = session;

  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-lazexport-'));

  const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', 'sphere.xml');
  await stubOpenDialog(app, xmlFixture);

  // Import the sphere scans (they carry scanner params, so they're exportable).
  await page.getByTestId('tool-add-scan').click();
  const popup = page.getByTestId('scan-parameters-popup');
  await expect(popup).toBeVisible();
  await page.getByTestId('scan-import-xml').click();
  await expect(popup).not.toBeVisible({ timeout: 20_000 });
  await completeImportWizard(page);

  const rows = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
  await expect(rows).toHaveCount(4, { timeout: 20_000 });

  await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
  await expect(page.getByTestId('export-modal')).toBeVisible();

  // Data-only mode → LAZ.
  await page.getByTestId('export-scan-mode-data').click();
  await expect(page.getByTestId('export-scan-mode-data')).toHaveAttribute('data-active', 'true');
  await page.getByTestId('export-scan-format-laz').click();
  await expect(page.getByTestId('export-scan-format-laz')).toHaveAttribute('data-active', 'true');

  // Clear the import's toasts so anything seen below is attributable to the
  // export. (Import toasts linger, so this can't just assert a zero count.)
  for (const close of await page.getByTestId('toast-close').all()) {
    await close.click().catch(() => {});
  }
  await expect(page.getByTestId('toast-title')).toHaveCount(0, { timeout: 15_000 });

  // Hold the folder picker open, mirroring a user who has been asked for a
  // destination and has not answered yet. This is what makes assertion (1)
  // deterministic: without it the stub records the call and returns the path in
  // the same breath, so by the time the poll below observes a call the export is
  // already running, and a ~236-point fixture can finish — and fire its
  // legitimate completion toast — inside a single poll interval. That is a race
  // no timeout can settle, and it is how this failed on a macOS runner
  // (run 33375915377) while the product ordering was correct all along.
  await stubExportFolder(app, page, outDir, 'scan', { hold: true });
  await page.getByTestId('export-scan-xml').click();

  // (1) NOTHING may claim success before the user has even chosen a path.
  await expect.poll(async () => (await getOpenDialogCalls(app)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  // The picker is genuinely still open here and stays open until released, so
  // this snapshot cannot be a post-write toast caught late.
  const titlesBeforeWrite = await page.getByTestId('toast-title').allTextContents();
  expect(
    titlesBeforeWrite.filter(t => /complete|success|exported/i.test(t)),
    `a success toast appeared before any file was written: ${JSON.stringify(titlesBeforeWrite)}`,
  ).toHaveLength(0);
  // Nothing may be on disk yet either — the destination has not been chosen.
  expect(
    readdirSync(outDir).filter(f => f.toLowerCase().endsWith('.laz')),
    'files were written before the folder picker was answered',
  ).toHaveLength(0);

  await releaseOpenDialog(app);

  // (2) The export must actually produce LAZ files on disk. Poll the SIZE, not
  // existence — the write isn't atomic, so a separate existence check followed
  // by a stat can observe a freshly-created but still-empty file.
  await expect.poll(
    () => {
      const laz = readdirSync(outDir).filter(f => f.toLowerCase().endsWith('.laz'));
      if (laz.length === 0) return 0;
      return Math.min(...laz.map(f => statSync(join(outDir, f)).size));
    },
    { timeout: 60_000, intervals: [200, 500, 1000] },
  ).toBeGreaterThan(0);

  // (3) A completion toast must arrive AFTER the write — an export that finishes
  // silently is indistinguishable from one that never ran.
  const toast = page.getByTestId('toast-title').filter({ hasText: /Export Complete/i });
  await expect(toast).toBeVisible({ timeout: 30_000 });

  // And the modal is dismissed, not left frozen behind the toast.
  await expect(page.getByTestId('export-modal')).not.toBeVisible({ timeout: 10_000 });
});
