import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// The octree disk cache can vanish out from under a loaded cloud: the OS clears
// the cache dir, a user deletes it, the cacheVersion bumps, or the in-RAM
// session that built it is evicted on a backend restart. When that happens the
// app:// protocol handler 404s and potree-core's loader rejects (historically a
// raw `... is not valid JSON` console error and a silently-blank cloud).
//
// The OctreeRef still carries the full rebuild descriptor (sourceXyzPath +
// asciiFormat + columnPlan), so the renderer now recovers: on load failure it
// re-creates the session from the source file. Because the cache key is
// deterministic, the rebuild produces the SAME cache id, so the cloud streams
// back in. This drives the real UI end-to-end against the live backend.
test('rebuilds an octree-backed cloud after its disk cache is deleted', async () => {
  const { app, page, octreeCacheRoot, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-octree', 'true');
    const pointCount = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(pointCount).toBeGreaterThan(0);

    // Wait until the octree has actually rendered: OctreePointCloud publishes its
    // live object into window.__octreePositions keyed by cacheId once the cloud
    // loads. Capture the cacheId so we can find its cache dir on disk.
    const cacheId = await page.waitForFunction(() => {
      const reg = (window as any).__octreePositions as Record<string, unknown> | undefined;
      const keys = reg ? Object.keys(reg) : [];
      return keys.length === 1 ? keys[0] : null;
    }, undefined, { timeout: 30_000 }).then((h) => h.jsonValue() as Promise<string>);

    const cacheDir = join(octreeCacheRoot, cacheId);
    expect(existsSync(cacheDir)).toBe(true);

    // Delete the cloud's octree cache dir while the app is running — exactly what
    // an OS cache clear / manual delete does.
    await rm(cacheDir, { recursive: true, force: true });
    expect(existsSync(cacheDir)).toBe(false);

    // Trigger a real reload of the cloud through the UI: toggling the color mode
    // remounts OctreePointCloud (its React key includes colorMode), so the loader
    // re-runs against the now-missing files and the recovery path fires.
    await page.getByRole('button', { name: 'Display' }).click();
    const colorMode = page.getByTestId('display-color-mode');
    await expect(colorMode).toBeVisible();
    // Drop the live-object hook first so the assertion below proves a FRESH load,
    // not the stale pre-delete entry.
    await page.evaluate((id) => {
      const reg = (window as any).__octreePositions;
      if (reg) delete reg[id];
    }, cacheId);
    await colorMode.selectOption('height');
    await expect(colorMode).toHaveValue('height');

    // Recovery: createCloudSession rebuilds the same deterministic cache id, the
    // cache dir reappears on disk, and the octree re-renders (its live object is
    // republished under the same cacheId). No silent blank cloud.
    await page.waitForFunction((id) => {
      const reg = (window as any).__octreePositions as Record<string, unknown> | undefined;
      return !!(reg && reg[id]);
    }, cacheId, { timeout: 60_000 });
    expect(existsSync(cacheDir)).toBe(true);

    // No "Point cloud unavailable" error toast — the rebuild succeeded.
    await expect(
      page.locator('[data-testid="toast-error"]', { hasText: 'Point cloud unavailable' }),
    ).toHaveCount(0);

    // The row still reports the same point count — the rebuilt cloud is the cloud.
    expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(pointCount);
  } finally {
    await close();
  }
});
