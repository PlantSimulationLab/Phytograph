import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { resetToFreshScene } from './helpers/resetApp';
import { importFiles } from './helpers/importFiles';
import { stubSaveDialog } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).
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

// Drives the BFS skeleton extraction workflow end-to-end against the live
// backend. The fixture is a Y-shaped synthetic plant (stem + two branches,
// 900 points) — chosen because it produces a clearly multi-segment
// skeleton, which lets us assert on metrics that prove the algorithm
// actually ran (not just "no error").
test('extracts a skeleton from a Y-shaped plant cloud via the UI', async () => {
  const { app, page } = session;
  {

    // Import as point cloud (not auto) — exercises the non-default menu item.
    // The handler calls react-dropzone's open() which fires a real OS file
    // chooser; intercept it before the click so it never surfaces.
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-point-count', '900');

    // Freshly imported scan is auto-selected (no re-click — that would toggle off).
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Open skeleton panel.
    await page.getByTestId('tool-skeleton').click();
    const panel = page.getByTestId('skeleton-panel');
    await expect(panel).toBeVisible();

    // Set non-default options:
    //   - search_radius = 0.04 (default "Auto" / 0 fails on this fixture;
    //     verified directly against the backend before writing the test).
    //   - min_points_per_block = 1 (default 5 also fails for this density).
    // These are real user choices a researcher would make for sparse data.
    const radius = page.getByTestId('skeleton-search-radius');
    await radius.fill('0.04');
    await expect(radius).toHaveValue('0.04');

    const minPts = page.getByTestId('skeleton-min-points');
    await minPts.fill('1');
    await expect(minPts).toHaveValue('1');

    // Run extraction.
    await page.getByTestId('skeleton-extract-button').click();

    // A skeleton row should appear in the Skeletons panel within ~60s.
    const skelRow = page.getByTestId('skeleton-row').first();
    await expect(skelRow).toBeVisible({ timeout: 60_000 });

    // Read the metrics the backend computed and check they're sensible.
    // The Y-shape's bounding stem (~2m) + two branches (~0.3m each) puts the
    // total skeleton length somewhere in the 0.5-3m band depending on how
    // the BFS clusters the points. Assert on a robust band that catches
    // a zero/empty skeleton but allows for algorithmic variation.
    const lengthStr = await skelRow.getAttribute('data-total-length');
    const ptCountStr = await skelRow.getAttribute('data-point-count');
    expect(lengthStr).not.toBeNull();
    expect(ptCountStr).not.toBeNull();
    const length = parseFloat(lengthStr!);
    const ptCount = parseInt(ptCountStr!, 10);
    expect(length).toBeGreaterThan(0.3);
    expect(length).toBeLessThan(10);
    expect(ptCount).toBeGreaterThan(5);
    expect(ptCount).toBeLessThan(900);

    // Sanity: the visible stats row formats as "{N.NN}m · {count} pts".
    await expect(skelRow.getByTestId('skeleton-row-stats')).toContainText('m ·');

    // ---- Export the extracted skeleton to JSON ----
    // Skeleton export shares the save path that used to hand its bytes to an
    // `<a download>` click (serviced out-of-band by Electron, so nothing was
    // observable to the renderer). Assert the file actually lands on disk.
    const outDir = mkdtempSync(join(tmpdir(), 'phytograph-skelexport-'));
    const savePath = join(outDir, 'tree_skeleton.json');
    await stubSaveDialog(app, savePath);

    // The export modal shows the skeleton section only when a skeleton is the
    // current selection — the cloud is still selected from the import.
    await skelRow.click();

    await page.evaluate(() => (window as unknown as { __openExportPanel: () => void }).__openExportPanel());
    await expect(page.getByTestId('export-modal')).toBeVisible();
    await expect(page.getByTestId('export-skeleton-section')).toBeVisible();
    await page.getByTestId('export-skeleton-json').click();

    await expect.poll(() => (existsSync(savePath) ? statSync(savePath).size : 0), { timeout: 30_000 })
      .toBeGreaterThan(0);

    // The written JSON must describe the same skeleton the panel reported —
    // proving real data was serialized, not an empty stub.
    const exported = JSON.parse(readFileSync(savePath, 'utf8'));
    expect(Array.isArray(exported.nodes)).toBe(true);
    expect(exported.nodes.length).toBe(ptCount);
    expect(exported.metadata.nodeCount).toBe(ptCount);
    expect(exported.metadata.totalLength).toBeCloseTo(length, 5);
    expect(Array.isArray(exported.edges)).toBe(true);
    expect(exported.edges.length).toBeGreaterThan(0);
    // Nodes carry real finite coordinates, not placeholders.
    for (const c of ['x', 'y', 'z'] as const) {
      expect(Number.isFinite(exported.nodes[0][c])).toBe(true);
    }
  }
});

// The panel has its own Clouds picker, seeded from the Scans-pane selection,
// and extracts one skeleton per checked cloud. It used to require exactly ONE
// selected scan: with two selected the panel never mounted and the toolbar
// button was a dead click.
//
// The second cloud is the same plant moved 5 m in X, written at test time.
test('extracts one skeleton per checked cloud', async () => {
  const { app, page } = session;
  const SHIFTED = join(mkdtempSync(join(tmpdir(), 'phytograph-skel-')), 'tree_shifted.xyz');
  writeFileSync(SHIFTED, readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
    const [x, ...rest] = l.trim().split(/\s+/);
    // Comment and header lines pass through untouched.
    if (!Number.isFinite(Number(x))) return l;
    return [(Number(x) + 5).toFixed(4), ...rest].join(' ');
  }).join('\n') + '\n');

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  const rowA = page.locator('[data-testid="scan-row"][data-scan-name="tree"]');
  await expect(rowA).toHaveAttribute('data-point-count', '900', { timeout: 20_000 });
  await importFiles(app, page, 'import-point-cloud', SHIFTED);
  await completeImportWizard(page);
  const rowB = page.locator('[data-testid="scan-row"][data-scan-name="tree_shifted"]');
  await expect(rowB).toHaveAttribute('data-point-count', '900', { timeout: 20_000 });

  // Nothing selected: the tool still opens, on the picker alone.
  await page.getByTestId('scans-panel').getByTitle('Deselect All').click();
  await page.getByTestId('tool-skeleton').click();
  const panel = page.getByTestId('skeleton-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('skeleton-none-checked')).toBeVisible();
  await expect(page.getByTestId('skeleton-extract-button')).toHaveCount(0);

  const target = (name: string) =>
    panel.locator(`[data-testid="skeleton-target-row"][data-label="${name}"]`).locator('input');
  await target('tree').check();
  await expect(page.getByTestId('skeleton-extract-button')).toHaveText('Extract Skeleton');
  await target('tree_shifted').check();
  await expect(panel).toHaveAttribute('data-target-count', '2');
  await expect(page.getByTestId('skeleton-extract-button')).toHaveText('Extract 2 Skeletons');

  // The same fixture-tuned settings as the single-cloud test above.
  await page.getByTestId('skeleton-search-radius').fill('0.04');
  await page.getByTestId('skeleton-min-points').fill('1');
  await page.getByTestId('skeleton-extract-button').click();

  // One skeleton each, both real.
  const rows = page.getByTestId('skeleton-row');
  await expect(rows).toHaveCount(2, { timeout: 120_000 });
  for (let i = 0; i < 2; i++) {
    const length = parseFloat((await rows.nth(i).getAttribute('data-total-length')) ?? '0');
    const pts = parseInt((await rows.nth(i).getAttribute('data-point-count')) ?? '0', 10);
    expect(length).toBeGreaterThan(0.3);
    expect(length).toBeLessThan(10);
    expect(pts).toBeGreaterThan(5);
    expect(pts).toBeLessThan(900);
  }
  // A clean run closes the panel, and one summary names both clouds.
  await expect(panel).toHaveCount(0);
  const toast = page.getByTestId('toast-success').filter({ hasText: '2 Skeletons Extracted' }).last();
  await expect(toast).toContainText('tree: Length');
  await expect(toast).toContainText('tree_shifted: Length');
});
