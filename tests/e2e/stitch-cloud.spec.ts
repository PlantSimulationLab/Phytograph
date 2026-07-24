import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// Stitch Clouds (merge) end-to-end against the LIVE backend. This is the
// regression guard for GitHub issue #3: the old renderer-side stitch concatenated
// each cloud's flat `data.positions`, which is EMPTY for octree-backed clouds, so
// the merged cloud collapsed every point to the origin — a green dot with a
// zero-size bounding box that the camera could never frame. The merge now runs in
// the backend (POST /api/cloud/session/merge) over the in-RAM session arrays.
//
// A count-only assertion (the old test) passed even while the geometry was
// destroyed. These tests assert the things that actually catch the collapse:
//   - the merged cloud is octree-backed (went through the backend session path),
//   - its point count is the SUM of the inputs, and
//   - its world bounds SPAN both inputs — i.e. NOT a zero-size box at the origin.
//
// Fixtures (exact extents verified):
//   tiny.xyz  60 pts,  x/y ∈ [-0.3, 0.3],      z ∈ [0, 1.5]
//   tree.xyz  900 pts, x/y ∈ [-0.02, 0.3185],  z ∈ [~0, ~1.996]
//   merged →  960 pts, x ∈ [-0.3, 0.3185], y ∈ [-0.3, 0.3185], z ∈ [0, ~1.996]

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
const TREE_FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

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

test('stitch merges two octree clouds into one cloud with correct count and bounds', async () => {
  const { app, page } = session;

  // Import both clouds through the real octree import pipeline.
  await importFiles(app, page, 'import-auto', [FIXTURE, TREE_FIXTURE]);
  await completeImportWizard(page);

  const rows = page.locator('[data-testid="scan-row"]');
  await expect(rows).toHaveCount(2, { timeout: 20_000 });

  // Both inputs are octree-backed (the real case the bug regressed).
  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
  const treeRow = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
  await expect(tinyRow).toHaveAttribute('data-point-count', '60');
  await expect(treeRow).toHaveAttribute('data-point-count', '900');
  await expect(tinyRow).toHaveAttribute('data-octree', 'true');
  await expect(treeRow).toHaveAttribute('data-octree', 'true');

  // Select both, open the stitch dialog (it seeds from the selection), run it.
  await tinyRow.click();
  await treeRow.click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('[data-testid="scan-row"][data-selected="true"]')).toHaveCount(2);

  await page.getByTestId('tool-cloud-stitch').click();
  const dialog = page.getByTestId('stitch-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('stitch-run').click();
  await expect(dialog).toHaveCount(0);

  // One merged cloud replaces the two originals. The backend merge + octree
  // rebuild takes a beat, so allow generous time for the row to settle.
  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  const merged = rows.first();

  // (1) Point count is the SUM (a count check alone was the old, insufficient test).
  await expect(merged).toHaveAttribute('data-point-count', '960', { timeout: 30_000 });
  // (2) The merged cloud is octree-backed — it went through the backend session
  //     path, not the flat-collapse path (a flat merge would report data-octree=false).
  await expect(merged).toHaveAttribute('data-octree', 'true');

  // (3) The world bounds SPAN both inputs — the assertion the collapse would fail.
  //     The broken merge produced a zero-size box at the origin; the correct merge
  //     spans z ≈ [0, 2] (tree's height) and x/y ≈ [-0.3, 0.32].
  const cam = await page.waitForFunction(() => {
    const s = (window as any).__getCameraState?.();
    if (!s || !s.framedContent) return null;
    const size = [
      s.bounds.max[0] - s.bounds.min[0],
      s.bounds.max[1] - s.bounds.min[1],
      s.bounds.max[2] - s.bounds.min[2],
    ];
    // Wait until the merged cloud's real (non-degenerate) bounds have registered.
    return size[2] > 1 ? s : null;
  }, { timeout: 30_000 }).then((h) => h.jsonValue() as Promise<{ bounds: { min: number[]; max: number[] } }>);

  const { min, max } = cam.bounds;
  // NOT collapsed to the origin: the vertical extent is the tree's ~2 m height.
  expect(max[2] - min[2]).toBeGreaterThan(1.8);
  expect(max[2]).toBeGreaterThan(1.8);
  // Horizontal extent spans tiny's cylinder radius (±0.3), ~0.6 m wide.
  expect(max[0] - min[0]).toBeGreaterThan(0.5);
  expect(max[1] - min[1]).toBeGreaterThan(0.5);
  // Lower corner reaches tiny's -0.3 (tree alone would start near -0.02).
  expect(min[0]).toBeLessThan(-0.1);
  expect(min[1]).toBeLessThan(-0.1);
});

test('stitch is undoable — undo restores both originals with their counts', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', [FIXTURE, TREE_FIXTURE]);
  await completeImportWizard(page);

  const rows = page.locator('[data-testid="scan-row"]');
  await expect(rows).toHaveCount(2, { timeout: 20_000 });

  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
  await page.getByTestId('tool-cloud-stitch').click();
  const dialog = page.getByTestId('stitch-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('stitch-run').click();

  await expect(rows).toHaveCount(1, { timeout: 30_000 });
  await expect(rows.first()).toHaveAttribute('data-point-count', '960', { timeout: 30_000 });

  // One Cmd+Z reverses the whole stitch: both originals return with their counts.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]'))
    .toHaveAttribute('data-point-count', '60', { timeout: 20_000 });
  await expect(page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]'))
    .toHaveAttribute('data-point-count', '900', { timeout: 20_000 });
});
