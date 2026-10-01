import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// Resample Point Cloud. It used to work only on in-memory (flat) clouds, which
// a normal import never produces — and a stale selection read in its guard
// meant clicking it lit the button and opened nothing, with no message. Now it
// is a picker tool that thins streamed clouds on the backend (mask + display
// rebuild) by a random fraction or by even spacing (one point per cube).
//
// tiny.xyz / tiny-offset.xyz: 60-point cylinders, imported as streamed clouds.
const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
const TINY_OFFSET = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny-offset.xyz');

/** Occupied cubes of edge `size`, grid anchored at the points' min corner. */
function occupiedCells(path: string, size: number): number {
  const pts = readFileSync(path, 'utf8').split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.trim().split(/\s+/).slice(0, 3).map(Number));
  const lo = [0, 1, 2].map(k => Math.min(...pts.map(p => p[k])));
  return new Set(pts.map(p => p.map((v, k) => Math.floor((v - lo[k]) / size)).join(','))).size;
}

let session: LaunchedApp;
test.beforeAll(async () => { session = await launchApp(); });
test.afterAll(async () => { await session?.close(); });
test.beforeEach(async () => { await resetToFreshScene(session.app, session.page); });

async function importBoth() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);
  await importFiles(app, page, 'import-auto', TINY_OFFSET);
  await completeImportWizard(page);
  const tiny = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  const offset = page.locator('[data-testid="scan-row"][data-scan-name="tiny-offset"]');
  await expect(tiny).toHaveAttribute('data-point-count', '60', { timeout: 20_000 });
  await expect(offset).toHaveAttribute('data-point-count', '60', { timeout: 20_000 });
  await expect(tiny).toHaveAttribute('data-octree', 'true');
  return { tiny, offset };
}

test('random: thins only the checked streamed cloud to the requested fraction', async () => {
  const { page } = session;
  const { tiny, offset } = await importBoth();
  await page.getByTestId('scans-panel').getByTitle('Deselect All').click();

  // Opens with nothing selected → nothing checked, Apply disabled.
  await page.getByTestId('tool-resample').click();
  const panel = page.getByTestId('resample-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-target-count', '0');
  await expect(page.getByTestId('resample-apply')).toBeDisabled();

  await page.locator('[data-testid="resample-target-row"][data-label="tiny-offset"]').click();
  await expect(panel).toHaveAttribute('data-target-count', '1');
  await page.getByRole('button', { name: '25%' }).click();
  // round(60 × 0.25) = 15 — the backend's own dry run, shown before committing.
  await expect(panel).toHaveAttribute('data-points-after', '15');
  await expect(page.getByTestId('resample-estimate')).toContainText('60 → 15');

  await page.getByTestId('resample-apply').click();
  await expect(offset).toHaveAttribute('data-point-count', '15', { timeout: 60_000 });
  await expect(tiny).toHaveAttribute('data-point-count', '60');
  await expect(panel).toBeHidden();
});

test('even spacing: keeps one point per occupied cube on every checked cloud', async () => {
  const { page } = session;
  const { tiny, offset } = await importBoth();
  await page.getByTestId('tool-resample').click();
  const panel = page.getByTestId('resample-panel');
  // The panel's own "select all" checks every cloud it lists.
  await page.getByTestId('resample-targets-select-all').check();
  await expect(panel).toHaveAttribute('data-target-count', '2');
  await page.getByTestId('resample-mode-voxel').click();
  await expect(panel).toHaveAttribute('data-mode', 'voxel');
  const size = 0.35;
  const input = page.getByTestId('resample-voxel-size');
  await input.fill(String(size));
  await input.press('Tab');

  const wantTiny = occupiedCells(TINY, size);
  const wantOffset = occupiedCells(TINY_OFFSET, size);
  expect(wantTiny).toBeGreaterThan(1);
  expect(wantTiny).toBeLessThan(60);
  await expect(panel).toHaveAttribute('data-points-after', String(wantTiny + wantOffset));

  await page.getByTestId('resample-apply').click();
  await expect(tiny).toHaveAttribute('data-point-count', String(wantTiny), { timeout: 60_000 });
  await expect(offset).toHaveAttribute('data-point-count', String(wantOffset), { timeout: 60_000 });
});
