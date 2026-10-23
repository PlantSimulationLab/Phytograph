import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tent_normals.xyz');

// Normals are shown without rebuilding the octree, their values fetched PER
// TILE as each tile loads (octreeOverlayColumns.ts): five float32 columns are
// 915 MB on the 45.7 M-point scan, too big to fetch whole. A real cloud that
// big is too big to commit, so this launch lowers the whole-column limit
// (PHYTOGRAPH_OVERLAY_WHOLE_MAX_MB) until the tent's 3000-point columns count
// as big — the per-tile path is then the only one in play.
//
// tent_normals.xyz is two planar faces each tilted exactly 30° (the ridge
// between them is not), and the tile values are checked through the filter
// mask. A tile still waiting for its values holds NaN, which fails EVERY
// range, so a 0-90° filter — which keeps any real verticality — draws every
// loaded point only once every loaded tile has its values. 29-31° then keeps
// the faces (most of the cloud) and 0-10° almost nothing.
//
// One test, one app: the launch env is what is under test.
let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp({ PHYTOGRAPH_OVERLAY_WHOLE_MAX_MB: '0.001' });
});
test.afterAll(async () => {
  await session?.close();
});

async function maskStats(page: Page, key: string) {
  return page.evaluate((k) => {
    const s = (window as { __octreeMaskByCloud?: Record<string, { drawn: number; full: number }> })
      .__octreeMaskByCloud?.[k];
    return s ? { drawn: s.drawn, full: s.full } : null;
  }, key);
}

test('normals are shown per tile, with no rebuild, and filter correctly', async () => {
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);
  const row = page.locator('[data-testid="scan-row"][data-scan-name="tent_normals"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-selected', 'true');
  const importedCacheId = (await row.getAttribute('data-octree-cache-id'))!;

  await page.getByTestId('tool-compute-normals').click();
  await page.getByTestId('compute-normals-orientation').selectOption('up');
  await page.getByTestId('compute-normals-run-button').click();
  await expect(page.getByTestId('compute-normals-panel')).toHaveCount(0, { timeout: 120_000 });

  // Nothing was rebuilt: the five columns are overlays on the imported octree.
  await expect(row).toHaveAttribute('data-overlay-columns', /verticality:/, { timeout: 30_000 });
  await expect(row).toHaveAttribute('data-octree-cache-id', importedCacheId);
  for (const slug of ['nx', 'ny', 'nz', 'curvature', 'verticality']) {
    await expect(row).toHaveAttribute('data-overlay-columns', new RegExp(`(^|,)${slug}:`));
  }
  // Colored by curvature from the values the tiles fetched.
  await expect(page.getByTestId('colorbar')).toHaveAttribute('data-colorbar-label', 'Curvature');

  await page.getByTestId('tool-filter').click();
  await page.getByTestId('filter-field-select').selectOption('scalar:verticality');
  const ratio = async () => {
    const st = await maskStats(page, importedCacheId);
    return st && st.full > 0 ? st.drawn / st.full : -1;
  };
  // Every loaded tile has real values (NaN would fail this range).
  await page.getByTestId('filter-min-input').fill('0');
  await page.getByTestId('filter-max-input').fill('90');
  await expect.poll(async () => {
    const st = await maskStats(page, importedCacheId);
    return !!st && st.full > 2000 && st.drawn === st.full;
  }, { timeout: 30_000 }).toBe(true);

  // ...and they are the right values: the 30° faces are most of the cloud.
  await page.getByTestId('filter-min-input').fill('29');
  await page.getByTestId('filter-max-input').fill('31');
  await expect.poll(ratio, { timeout: 30_000 }).toBeGreaterThan(0.85);
  await page.getByTestId('filter-min-input').fill('0');
  await page.getByTestId('filter-max-input').fill('10');
  await expect.poll(ratio, { timeout: 30_000 }).toBeLessThan(0.05);
});
