import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
const TREE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// Regression: importing MULTIPLE point clouds at once through
// Import → Point Cloud used to fail. The multi-file handler
// (handleMultipleFiles) always called the in-renderer parser, while the
// single-file path routed XYZ-family files with a real disk path through the
// backend octree converter. The same large scans that imported fine one at a
// time threw when multi-selected. Now both paths share the path-first octree
// routing, so a multi-select of XYZ files goes through convert_to_octree.
//
// Per CLAUDE.md Testing rules: live backend, drive the real UI via the file
// chooser, assert concrete point counts read from the rendered scan rows.
test('imports multiple point clouds at once via Import → Point Cloud', async () => {
  const { app, page, close } = await launchApp();

  try {

    // Open Import menu, pick "Point Cloud", and feed the OS chooser BOTH
    // fixtures in one selection — this drives handleMultipleFiles.
    await importFiles(app, page, 'import-point-cloud', [TINY, TREE]);
    await completeImportWizard(page);

    // Both clouds must appear as scan rows with their exact point counts.
    // tiny.xyz = 60 pts, tree.xyz = 900 pts (comment/header lines skipped).
    // These come back from the octree metadata, proving the multi-select
    // routed through the same backend path the single-file import uses.
    const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
    const treeRow = page.locator('[data-testid="scan-row"][data-scan-name="tree"]');

    await expect(tinyRow).toBeVisible({ timeout: 20_000 });
    await expect(treeRow).toBeVisible({ timeout: 20_000 });

    expect(parseInt((await tinyRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);
    expect(parseInt((await treeRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(900);

    // Load-bearing assertion: both must be OCTREE-backed. The old multi-file
    // handler used the in-renderer parser unconditionally (→ data-octree
    // "false"); the fix routes XYZ-family files with a disk path through the
    // backend converter, exactly like single-file import. This is what was
    // broken — large scans imported fine one at a time but threw in a
    // multi-select because they never reached the octree path.
    await expect(tinyRow).toHaveAttribute('data-octree', 'true');
    await expect(treeRow).toHaveAttribute('data-octree', 'true');

    // Viewer mounted.
    await expect(page.locator('canvas').first()).toBeAttached();

    // Regression: per-scan (default) batch imports rendered as a flat z-height
    // grey ramp until the user toggled colour mode and back. Cause: when several
    // octrees mount at once, first paint can land before the material effect
    // overrides potree-core's DEFAULT pointColorType (elevation), so the cloud
    // shows the default elevation gradient instead of its per-scan swatch. The
    // one-shot first-paint recompile that cures this was gated to gradient modes
    // only, so per-scan clouds were never corrected.
    //
    // The offscreen E2E window returns a black WebGL buffer (pixel reads aren't
    // possible — see plant-generate.spec.ts), so we assert the MECHANISM: the
    // recompile must have fired once per octree cacheId, in the default
    // (per-scan) colour mode, with no manual toggle. Before the fix this set
    // was empty in per-scan mode.
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () => ((window as any).__octreeRepainted as string[] | undefined)?.length ?? 0,
          ),
        { timeout: 20_000 },
      )
      .toBe(2);

    // …and the recompile must leave the material in the mode the cloud is
    // actually supposed to be in. The assertion above only proves the event
    // fired; this reads the seam the material effect publishes from inside
    // itself, so it fails if the recompile stops rebuilding the material.
    //
    // This is the regression guard for HOW that recompile is delivered. It used
    // to be a REMOUNT: the parent bumped a per-cacheId generation that fed the
    // component's React key, so first paint destroyed and rebuilt the whole
    // OctreePointCloud. That is invisible with two clouds and awful with a
    // hundred — each remount unregisters the octree from the shared frame
    // driver and re-streams its nodes, so splitting a ~100-tree plot into
    // per-tree clouds made every child blink in and out as its own remount
    // landed (measured on a 3.6M-point orchard block: 109 children, 112
    // remounts, clouds unregistered across ~1.4s). The cure now rebuilds the
    // material IN PLACE inside the component, so the cloud never leaves the
    // scene. Both spellings satisfy the `__octreeRepainted` assertion above,
    // which is why this one reads the material state instead.
    const modes = await page.evaluate(
      () => (window as any).__octreeRenderMode as Record<string, { colorMode: string }> | undefined,
    );
    // 'per-scan' is passed to the octree renderer as 'single' (a uniform swatch
    // of the scan's own colour — there is no per-scan shader), so 'single' here
    // IS the default per-scan mode, and specifically not potree-core's default
    // elevation gradient that this whole mechanism exists to override.
    expect(Object.keys(modes ?? {}).length).toBe(2);
    for (const [cacheId, m] of Object.entries(modes ?? {})) {
      expect(m.colorMode, `octree ${cacheId} should render its per-scan swatch`)
        .toBe('single');
    }
  } finally {
    await close();
  }
});
