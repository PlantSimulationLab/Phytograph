import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const TREE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');
const TREE2 = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree2.xyz');
// Two complementary VIEWS of one tree (even/odd points of tree.xyz, 450 each).
// Each alone is a sparse half; only their fusion is the full 900-point tree —
// the multi-view-of-one-tree case aggregate mode is for.
const TREE_VIEW1 = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree-view1.xyz');
const TREE_VIEW2 = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree-view2.xyz');

// Batch QSM: multi-select two scans and build one QSM per scan in a single
// run. Drives the LIVE backend (no mocks) through the real UI — multi-select
// via ctrl/cmd-click, the Build QSM panel button, the progress modal, and the
// rendered QSM result rows. Asserts TWO separate QSMs land, each named after
// its own source scan with a real (non-zero) cylinder count.
test('batch-builds one QSM per selected scan via the UI', async () => {
  const { app, page, close } = await launchApp();

  try {
    // The renderer keeps a full-screen splash up (intercepting all pointer
    // events) until its own backend-ready poll succeeds — which can lag the
    // /version check launchApp already waited on. Wait for it to unmount
    // before driving the UI, otherwise the first click races a cold start.
    await expect(page.getByTestId('backend-splash')).toHaveCount(0, { timeout: 60_000 });

    // Import both fixtures at once (drives handleMultipleFiles).
    await importFiles(app, page, 'import-point-cloud', [TREE, TREE2]);
    await completeImportWizard(page);

    const treeRow = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
    const tree2Row = page.locator('[data-testid="scan-row"][data-scan-name="tree2.xyz"]');
    await expect(treeRow).toBeVisible({ timeout: 20_000 });
    await expect(tree2Row).toBeVisible({ timeout: 20_000 });

    // --- Fix 1: multi-import frames ALL new clouds, not just the first ---
    // tree.xyz sits at X≈0, tree2.xyz is the same shape translated +5m in X, so
    // their union center is X≈2.5. snapToView sets the orbit target to the
    // framed center, so reading it back tells us what got framed. The range
    // 1.5–3.5 rejects BOTH the old first-only bug (target X≈0) and a
    // second-only regression (target X≈5) — only the true union lands here.
    const targetX = await (async () => {
      let v: number | null = null;
      await expect.poll(async () => {
        const state = await page.evaluate(() => (window as any).__getCameraState?.());
        v = state?.target?.[0] ?? null;
        return v;
      }, { timeout: 10_000 }).toBeGreaterThan(1.5);
      return v!;
    })();
    expect(targetX).toBeLessThan(3.5);

    // Select BOTH scans: click the first, ctrl/cmd-click the second to add it
    // to the selection (multi-select, not replace).
    await treeRow.click();
    await tree2Row.click({ modifiers: ['ControlOrMeta'] });
    await expect(treeRow).toHaveAttribute('data-selected', 'true');
    await expect(tree2Row).toHaveAttribute('data-selected', 'true');

    // Open the QSM panel — the multi-scan mode chooser must appear.
    await page.getByTestId('tool-qsm').click();
    const panel = page.getByTestId('qsm-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('qsm-multi-mode')).toBeVisible();

    // Explicitly pick "one QSM per scan" and confirm the button label follows.
    await page.getByTestId('qsm-mode-per-scan').check();
    await expect(page.getByTestId('qsm-build-button')).toContainText('2 scans');

    // Run the batch. The build progress modal appears, counts, then clears.
    await page.getByTestId('qsm-build-button').click();
    await expect(page.getByTestId('bulk-import-progress')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('bulk-import-progress')).toContainText('Building QSMs');

    // TWO QSM rows land — one per scan — within the batch window.
    const qsmRows = page.getByTestId('qsm-row');
    await expect(qsmRows).toHaveCount(2, { timeout: 120_000 });
    await expect(page.getByTestId('bulk-import-progress')).toHaveCount(0);

    // Each QSM is named after its own source scan and has real cylinders —
    // proving they were built separately, not a single merged model.
    const names = await page.getByTestId('qsm-row-name').allInnerTexts();
    expect(names.sort()).toEqual(['tree.xyz', 'tree2.xyz']);

    for (let i = 0; i < 2; i++) {
      const row = qsmRows.nth(i);
      const cyl = parseInt((await row.getAttribute('data-cylinder-count'))!, 10);
      const trunk = parseInt((await row.getAttribute('data-trunk-count'))!, 10);
      expect(cyl).toBeGreaterThan(10);
      expect(trunk).toBe(1);
    }
  } finally {
    await close();
  }
});

// Aggregate QSM: select two VIEWS of one tree and fuse them into a SINGLE QSM.
// Drives the live backend through the real UI: multi-select, pick "One QSM from
// all scans", build. Asserts exactly ONE QSM row lands, labelled as fused, with
// a clean 1-trunk structure — proving the points were merged, not built apart.
test('aggregates multiple scans into a single fused QSM via the UI', async () => {
  const { app, page, close } = await launchApp();

  try {
    await expect(page.getByTestId('backend-splash')).toHaveCount(0, { timeout: 60_000 });

    await importFiles(app, page, 'import-point-cloud', [TREE_VIEW1, TREE_VIEW2]);
    await completeImportWizard(page);

    const view1Row = page.locator('[data-testid="scan-row"][data-scan-name="tree-view1.xyz"]');
    const view2Row = page.locator('[data-testid="scan-row"][data-scan-name="tree-view2.xyz"]');
    await expect(view1Row).toBeVisible({ timeout: 20_000 });
    await expect(view2Row).toBeVisible({ timeout: 20_000 });

    // Both auto-select on multi-import; ensure the selection holds.
    await expect(view1Row).toHaveAttribute('data-selected', 'true');
    await expect(view2Row).toHaveAttribute('data-selected', 'true');

    // Open QSM, choose aggregate, confirm the button reflects fusion.
    await page.getByTestId('tool-qsm').click();
    await expect(page.getByTestId('qsm-panel')).toBeVisible();
    await page.getByTestId('qsm-mode-aggregate').check();
    await expect(page.getByTestId('qsm-build-button')).toContainText('1 QSM from 2 scans');

    await page.getByTestId('qsm-build-button').click();

    // Exactly ONE fused QSM appears — not two.
    const qsmRows = page.getByTestId('qsm-row');
    await expect(qsmRows).toHaveCount(1, { timeout: 120_000 });

    // Its name marks it as fused from multiple scans.
    await expect(page.getByTestId('qsm-row-name')).toContainText('tree-view1.xyz + 1 more');

    // Structurally it's still one clean tree: a real trunk + cylinders.
    const row = qsmRows.first();
    const cyl = parseInt((await row.getAttribute('data-cylinder-count'))!, 10);
    const trunk = parseInt((await row.getAttribute('data-trunk-count'))!, 10);
    expect(cyl).toBeGreaterThan(10);
    expect(trunk).toBe(1);
  } finally {
    await close();
  }
});
