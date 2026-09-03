import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// Every supported point-cloud format imports through the UI as a streaming
// octree (not a flat in-renderer cloud). Before this, only the XYZ family
// went through the backend octree converter; PLY/PCD loaded flat via open3d
// and LAS/LAZ via the in-renderer parser / multipart upload. Now all formats
// route through convert_to_octree when dropped with a real disk path.
//
// Per CLAUDE.md Testing rules: live backend, drive the real UI via the file
// chooser, assert the concrete point count and octree-backing read from the
// rendered scan row. Each fixture is the same 60-point cylinder so the
// expected count is identical across formats.
//
// Shared session (CLAUDE.md E2E rule 6): one app + backend for the whole file,
// with File → New between formats. This spec previously called launchApp()
// per case, so the four formats started FOUR full Electron + PyInstaller
// instances (~1-1.5 GB RSS each). Nothing here is about launch lifecycle — the
// subject is which reader a format routes to — so that cost bought nothing and
// made the file a contention source: with `workers: 2` it ran beside another
// spec doing the same, and this file sits in the alphabetical `generate-*` /
// `import-*` shard next to the DEM and triangulation specs. That pairing is the
// documented flake shape in playwright.config.ts (heavy specs concurrent under
// a homogeneous shard, failing as timeouts rather than wrong answers), and it
// showed up here as an intermittent miss on the 20 s row-visibility wait.
const FIXTURES = join(repoRoot, 'tests', 'e2e', 'fixtures');

// The auto-name is the file's STEM, extension trimmed — so all four cases
// import as "tiny". They never collide: each test runs on a fresh scene.
const CASES = ['tiny.ply', 'tiny.pcd', 'tiny.las', 'tiny.laz']
  .map(file => ({ file, name: file.replace(/\.[^.]+$/, '') }));

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

for (const { file, name } of CASES) {
  test(`imports ${file} as an octree-backed cloud`, async () => {
    const { app, page } = session;

    await importFiles(app, page, 'import-point-cloud', [join(FIXTURES, file)]);
    await completeImportWizard(page);

    const row = page.locator(`[data-testid="scan-row"][data-scan-name="${name}"]`);
    await expect(row).toBeVisible({ timeout: 20_000 });

    // All four fixtures are the same 60-point cylinder.
    expect(parseInt((await row.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);
    // Load-bearing: the import went through the backend octree pipeline, not
    // a flat in-renderer parse.
    await expect(row).toHaveAttribute('data-octree', 'true');

    await expect(page.locator('canvas').first()).toBeAttached();
  });
}
