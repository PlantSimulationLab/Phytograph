import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// Drives the BFS skeleton extraction workflow end-to-end against the live
// backend. The fixture is a Y-shaped synthetic plant (stem + two branches,
// 900 points) — chosen because it produces a clearly multi-segment
// skeleton, which lets us assert on metrics that prove the algorithm
// actually ran (not just "no error").
test('extracts a skeleton from a Y-shaped plant cloud via the UI', async () => {
  const { page, close } = await launchApp();

  try {

    // Import as point cloud (not auto) — exercises the non-default menu item.
    // The handler calls react-dropzone's open() which fires a real OS file
    // chooser; intercept it before the click so it never surfaces.
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-pointcloud').click(),
    ]);
    await chooser.setFiles(FIXTURE);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-point-count', '900');

    // Select.
    await cloudRow.click();
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
  } finally {
    await close();
  }
});
