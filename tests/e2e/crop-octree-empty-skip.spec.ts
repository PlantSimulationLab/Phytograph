import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Regression: with an octree cloud in crop mode and "keep inside" (the default),
// moving the box so that ALL points fall outside it made the popup + viewport
// ultra-laggy. Cause: potree fills its point budget from UN-clipped nodes only,
// so when the box excludes everything the budget never fills and the LOD early-
// out is defeated — potree keeps descending + streaming the region every frame.
//
// Fix: OctreePointCloud detects a provably-empty crop (box disjoint from the
// cloud bounds for keep-inside) and skips the per-frame potree update, hiding
// the cloud instead. It restores the moment the box overlaps again.
//
// Observable: the renderer exposes __octreeCropHidden[cacheId] = true while the
// cloud is hidden by this guard. Per CLAUDE.md: live backend, real import +
// real crop UI, asserting concrete state (the guard engaged / disengaged), not
// merely "no error".
test('octree crop skips LOD streaming when the keep-inside box leaves all points', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', TINY);
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"]').first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    // Must be octree-backed for this code path to apply, and auto-selected so
    // crop targets it.
    await expect(row).toHaveAttribute('data-octree', 'true');
    await expect(row).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('tool-crop').click();
    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-crop-mode', 'box');

    const setNumber = async (testId: string, value: number) => {
      const input = page.getByTestId(testId);
      await input.click();
      await input.fill(String(value));
      await input.press('Tab');
    };
    // True when the empty-crop guard is hiding any octree cloud.
    const anyHidden = () =>
      page.evaluate(() =>
        Object.values((window as any).__octreeCropHidden ?? {}).some((v) => v === true),
      );

    // Box initialises to the cloud bounds → fully overlapping → NOT hidden.
    await expect.poll(anyHidden, { timeout: 10_000 }).toBe(false);

    // Move the box well off the cloud on X (tiny.xyz spans x∈[-0.3,0.3]); shrink
    // it first so center=100 puts it at x∈[99.5,100.5], disjoint from the cloud.
    await setNumber('crop-dim-x', 1);
    await setNumber('crop-center-x', 100);
    // The guard must engage: empty result → cloud hidden, potree update skipped.
    await expect.poll(anyHidden, { timeout: 10_000 }).toBe(true);

    // Bring the box back over the cloud → guard releases, streaming resumes.
    await setNumber('crop-center-x', 0);
    await expect.poll(anyHidden, { timeout: 10_000 }).toBe(false);
  } finally {
    await close();
  }
});
