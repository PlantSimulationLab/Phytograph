import { test, expect } from '@playwright/test';
import { rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');
// 60 data points; Deviation cycles 0..4, so [0,2] keeps exactly 36.
const SCALARS = join(repoRoot, 'tests', 'e2e', 'fixtures', 'scalars.xyz');

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

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree"]');
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

// A recovery must not poison the NEXT recovery.
//
// The rebuild used to be written back through `onUpdateScanData`, which drops
// `sourcePath` and force-sets `divergedFromSource: true` — correct when the
// caller is swapping in genuinely different points, wrong for a deterministic
// rebuild of the cloud's own source file. So the first recovery succeeded but
// left the cloud flagged as edited-since-import, and the SECOND cache loss hit
// the refusal branch: "Edited point cloud unavailable … this cloud has been
// edited since import", about a cloud the user had only imported and never
// touched. Reported from the field as a permanently blank viewer (issue #4,
// where a cache-root mismatch made every load fail and every import land on
// this message immediately).
//
// One cycle can't catch it — the flag is only set by the first recovery — so
// this drives two.
test('recovers repeatedly, and never claims an untouched cloud was edited', async () => {
  const { app, page, octreeCacheRoot, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    const pointCount = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(pointCount).toBeGreaterThan(0);

    const cacheId = await page.waitForFunction(() => {
      const reg = (window as any).__octreePositions as Record<string, unknown> | undefined;
      const keys = reg ? Object.keys(reg) : [];
      return keys.length === 1 ? keys[0] : null;
    }, undefined, { timeout: 30_000 }).then((h) => h.jsonValue() as Promise<string>);

    const cacheDir = join(octreeCacheRoot, cacheId);
    const colorModes = ['height', 'intensity'];

    for (const mode of colorModes) {
      expect(existsSync(cacheDir)).toBe(true);
      await rm(cacheDir, { recursive: true, force: true });
      expect(existsSync(cacheDir)).toBe(false);

      // Remount the loader through the real UI (the React key includes colorMode).
      // "Display" TOGGLES the panel, so only click it when the panel is closed —
      // on the second pass it is still open from the first.
      const colorMode = page.getByTestId('display-color-mode');
      if (!(await colorMode.isVisible())) {
        await page.getByRole('button', { name: 'Display' }).click();
      }
      await expect(colorMode).toBeVisible();
      await page.evaluate((id) => {
        const reg = (window as any).__octreePositions;
        if (reg) delete reg[id];
      }, cacheId);
      await colorMode.selectOption(mode);
      await expect(colorMode).toHaveValue(mode);

      // The cloud comes back, both times.
      await page.waitForFunction((id) => {
        const reg = (window as any).__octreePositions as Record<string, unknown> | undefined;
        return !!(reg && reg[id]);
      }, cacheId, { timeout: 60_000 });
      expect(existsSync(cacheDir)).toBe(true);
      expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(pointCount);
    }

    // The specific lie this test exists for: an imported-and-untouched cloud
    // must never be described as edited.
    await expect(
      page.locator('[data-testid="toast-error"]', { hasText: 'Edited point cloud unavailable' }),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="toast-error"]', { hasText: 'Point cloud unavailable' }),
    ).toHaveCount(0);
  } finally {
    await close();
  }
});

// An EDITED cloud must recover too — from its session, not from its source file.
//
// The two tests above cover an untouched cloud, where recovery re-reads the
// source file. That is exactly what must NOT happen once a cloud has diverged
// from that file (bake, crop, filter, split): the file still holds the original
// points, so rebuilding from it silently reverts the user's work. Recovery
// therefore refuses — and used to stop there, reporting "Edited point cloud
// unavailable" as unrecoverable data loss.
//
// It isn't unrecoverable. The backend's in-RAM session arrays are the actual
// source of truth for a cloud; the octree is a derived render cache, and
// `rebuild_octree` reconverts straight from those arrays without reading any
// file. While the session is alive the edited points still exist, so the cloud
// can come back exactly as edited.
//
// Field failure this pins: a second Electron instance sharing the userData dir
// wiped the octree cache mid-session (Chromium empties <userData>/Cache, which
// on case-insensitive APFS was the same directory), and the app declared the
// edits lost while the backend still held every one of those points.
//
// The load-bearing assertion is the POINT COUNT: 36 (edited) and never 60 (the
// file on disk). A recovery that silently re-read the source would show 60 and
// otherwise look like a success.
test('recovers an EDITED cloud from its live session, not from its source file', async () => {
  const { app, page, octreeCacheRoot, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', SCALARS);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="scalars"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);
    // The octree the filter starts from. The commit itself only deletes the
    // points (the row's count drops behind a per-tile mask) and hands the
    // reconversion to the background refresh queue, so the post-filter octree
    // is recognized by its id CHANGING, not merely by an id being present.
    await expect.poll(() => cloudRow.getAttribute('data-octree-cache-id'), { timeout: 30_000 }).not.toBeNull();
    const importedCacheId = await cloudRow.getAttribute('data-octree-cache-id');

    // Diverge the cloud from its file: keep Deviation in [0,2] → 36 of 60.
    await page.getByTestId('tool-filter').click();
    const fieldSelect = page.getByTestId('filter-field-select');
    await expect(fieldSelect).toBeVisible();
    await fieldSelect.selectOption('scalar:Deviation');
    await page.getByTestId('filter-min-input').fill('0');
    await page.getByTestId('filter-max-input').fill('2');
    await page.getByTestId('filter-remove').click();

    await expect(async () => {
      const n = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
      expect(n).toBe(36);
    }).toPass({ timeout: 30_000 });

    // The post-filter octree. Read the id off the row (not the window registry)
    // so this doesn't depend on how many octree objects are momentarily mounted.
    await expect.poll(async () => {
      const id = await cloudRow.getAttribute('data-octree-cache-id');
      return !!id && id !== importedCacheId && existsSync(join(octreeCacheRoot, id));
    }, { timeout: 30_000 }).toBe(true);
    const editedCacheId = (await cloudRow.getAttribute('data-octree-cache-id'))!;

    const cacheDir = join(octreeCacheRoot, editedCacheId);

    // Wait until the EDITED octree is actually on screen before pulling it out
    // from under the renderer.
    await page.waitForFunction((id) => {
      const reg = (window as any).__octreePositions as Record<string, unknown> | undefined;
      return !!(reg && reg[id]);
    }, editedCacheId, { timeout: 30_000 });

    // The cache loss.
    await rm(cacheDir, { recursive: true, force: true });
    expect(existsSync(cacheDir)).toBe(false);
    await page.evaluate((id) => {
      const reg = (window as any).__octreePositions;
      if (reg) delete reg[id];
    }, editedCacheId);

    // Remount the loader through the real UI (the React key includes colorMode).
    await page.getByRole('button', { name: 'Display' }).click();
    const colorMode = page.getByTestId('display-color-mode');
    await expect(colorMode).toBeVisible();
    await colorMode.selectOption('height');
    await expect(colorMode).toHaveValue('height');

    // Recovery: a rebuild from the session puts an octree back on disk and on
    // screen. The id may or may not match the deleted one (the reconvert is
    // deterministic over the same arrays), so track whatever the row now names.
    await expect.poll(async () => {
      const id = await cloudRow.getAttribute('data-octree-cache-id');
      if (!id || !existsSync(join(octreeCacheRoot, id))) return false;
      return page.evaluate((cid) => {
        const reg = (window as any).__octreePositions as Record<string, unknown> | undefined;
        return !!(reg && reg[cid]);
      }, id);
    }, { timeout: 90_000 }).toBe(true);

    // THE assertion: the cloud came back EDITED. 60 would mean the source file
    // was re-read and the user's filter silently undone.
    expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(36);

    // And it was a real recovery, not a dead end.
    await expect(
      page.locator('[data-testid="toast-error"]', { hasText: 'Edited point cloud unavailable' }),
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="toast-error"]', { hasText: 'Point cloud unavailable' }),
    ).toHaveCount(0);

    // The session log tells the whole story without the user's files (issue #7
    // had only a bare "Octree load failed"): the load failure names the
    // session, the renderer says which recovery it ran and how it ended, and
    // the backend says what that session held, with the deleted id MISSING.
    // All three name the same session, so they can be matched in an export.
    const logPath = await page.evaluate(() => (window as any).electronAPI.logs.getPath() as Promise<string>);
    let log = '';
    await expect.poll(async () => {
      log = await readFile(logPath, 'utf-8').catch(() => '');
      return /\[octree-recovery\].*rebuilt from the session as octree [0-9a-f]{40}/.test(log)
        && /rebuild_octree [0-9a-f]+: session held/.test(log);
    }, { timeout: 15_000 }).toBe(true);
    const start = /\[octree-recovery\] "scalars[^"]*" \(session ([0-9a-f]+), octree ([0-9a-f]{40}), edited=true\): octree missing; rebuilding it from the session/.exec(log);
    expect(start, 'renderer recovery start line').not.toBeNull();
    const [, sessionId, missingId] = start!;
    expect(missingId).toBe(editedCacheId);
    expect(log).toMatch(new RegExp(`Octree load failed for ${editedCacheId} \\(cloud "scalars[^"]*", session ${sessionId}\\)`));
    expect(log).toMatch(new RegExp(`rebuild_octree ${sessionId}: session held [^\\n]*${editedCacheId} \\(MISSING\\)`));
  } finally {
    await close();
  }
});

// An ERASE leaves the octree alone until "Apply deletions" (the scan row's count
// drops behind clip boxes), so nothing used to mark the cloud as edited. A lost
// octree was then rebuilt from the SOURCE FILE into a fresh session holding
// every erased point: the clip boxes kept hiding them, so the count looked
// right, while compute and export silently used them again. The recovery must
// take the edited path and rebuild from the live session.
test('recovers an ERASED cloud from its live session, not from its source file', async () => {
  const { app, page, octreeCacheRoot, close } = await launchApp();
  try {
    await importFiles(app, page, 'import-point-cloud', SCALARS);
    await completeImportWizard(page);
    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="scalars"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-point-count', '60');
    await expect.poll(() => cloudRow.getAttribute('data-octree-cache-id'), { timeout: 30_000 }).not.toBeNull();
    const cacheId = (await cloudRow.getAttribute('data-octree-cache-id'))!;
    await page.waitForFunction((id) => !!(window as any).__octreePositions?.[id], cacheId, { timeout: 30_000 });

    // Erase part of the cloud (instant session delete, no octree rebuild).
    await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
    await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));
    await page.getByTestId('tool-erase').click();
    const panel = page.getByTestId('erase-panel');
    await page.getByTestId('erase-mode-toggle').click();
    await expect(panel).toHaveAttribute('data-erase-active', 'true');
    await page.waitForTimeout(300);
    const slider = panel.locator('input[type="range"]');
    const maxPx = await slider.getAttribute('max');
    await slider.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, maxPx ?? '150');
    const box = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect.poll(async () => Number(await panel.getAttribute('data-stamp-count'))).toBeGreaterThan(0);
    await page.getByTestId('erase-apply').click();
    await expect.poll(async () => Number(await cloudRow.getAttribute('data-point-count')), { timeout: 8_000 })
      .toBeLessThan(60);
    const afterErase = await cloudRow.getAttribute('data-point-count');
    // Unapplied: the octree is still the imported one.
    expect(await cloudRow.getAttribute('data-octree-cache-id')).toBe(cacheId);

    // The cache loss, then a remount through the real UI.
    await rm(join(octreeCacheRoot, cacheId), { recursive: true, force: true });
    await page.evaluate((id) => { delete (window as any).__octreePositions?.[id]; }, cacheId);
    await page.getByRole('button', { name: 'Display' }).click();
    const colorMode = page.getByTestId('display-color-mode');
    await expect(colorMode).toBeVisible();
    await colorMode.selectOption('height');

    const logPath = await page.evaluate(() => (window as any).electronAPI.logs.getPath() as Promise<string>);
    let log = '';
    await expect.poll(async () => {
      log = await readFile(logPath, 'utf-8').catch(() => '');
      return /\[octree-recovery\] "scalars[^"]*" \([^)]*edited=(true|false)\): octree missing/.test(log);
    }, { timeout: 30_000 }).toBe(true);
    expect(log).toMatch(/\[octree-recovery\] "scalars[^"]*" \(session [0-9a-f]+, octree [0-9a-f]{40}, edited=true\): octree missing; rebuilding it from the session/);
    expect(log).not.toMatch(/octree missing; rebuilding it from the source file/);
    await expect(cloudRow).toHaveAttribute('data-point-count', afterErase!);
  } finally {
    await close();
  }
});
