import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Two crop-apply regressions, both about what the user sees AFTER Apply:
//
//  1. The camera must not move. Applying a crop added new clouds, and the
//     frame-on-add effect snapped the view to iso and fitted each one as it
//     appeared — so the view visibly jumped, once per cloud produced. The user
//     framed the region they were cropping; they expect to keep looking at it.
//     Fixed by registering derived ids in suppressFrameCloudIdsRef before the
//     add (the same opt-out tree segmentation already used).
//
//  2. Derived clouds must inherit the SOURCE scan's colour. Segment outputs
//     took a hardcoded amber and retained crops took the next free palette
//     entry, so a crop output looked unrelated to its parent — and in a
//     multi-scan crop a child could take a colour belonging to a DIFFERENT
//     source scan. Fixed by copying cloud.color at all derived-cloud sites.
//
// Per CLAUDE.md Testing rules: live backend, real UI, concrete assertions
// (exact camera vector equality, exact hex colour) rather than "didn't throw".

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

type CameraState = { position: number[]; target: number[] | null };

function readCamera(page: import('@playwright/test').Page): Promise<CameraState> {
  return page.evaluate(() => {
    const get = (window as unknown as { __getCameraState?: () => CameraState }).__getCameraState;
    if (!get) throw new Error('__getCameraState not registered');
    const s = get();
    return { position: s.position, target: s.target };
  });
}

// Shape the crop box to keep z∈[0.3, 1.0] — the z=0.375 and z=0.75 layers of
// the cylinder (24 of 60 pts). X/Y are set wider than the cylinder (r=0.3) so
// only Z selects, avoiding the on-the-face float ambiguity that made earlier
// crop specs platform-dependent (see the note in crop-segment.spec.ts).
async function setKeepMiddleLayers(page: import('@playwright/test').Page) {
  async function setNumber(testId: string, value: number) {
    const input = page.getByTestId(testId);
    await input.click();
    await input.fill(String(value));
    await input.press('Tab');
  }
  await setNumber('crop-dim-x', 1.0);
  await setNumber('crop-center-x', 0);
  await setNumber('crop-dim-y', 1.0);
  await setNumber('crop-center-y', 0);
  await setNumber('crop-dim-z', 0.7);
  await setNumber('crop-center-z', 0.65);
}

test('applying a Segment crop leaves the camera exactly where it was', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
  await expect(tinyRow).toBeVisible({ timeout: 20_000 });
  await expect(tinyRow).toHaveAttribute('data-point-count', '60');

  await expect(tinyRow).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('tool-crop').click();
  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();

  await page.getByTestId('crop-mode-segment').click();
  await expect(page.getByTestId('crop-mode-segment')).toHaveAttribute('aria-pressed', 'true');
  await setKeepMiddleLayers(page);

  // Snapshot the view the user is looking at, immediately before Apply.
  const before = await readCamera(page);

  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

  // Both output clouds exist — so the add path really ran (this test would be
  // vacuous if the crop silently no-oped).
  await expect(tinyRow).toHaveAttribute('data-point-count', '24', { timeout: 10_000 });
  const segmentRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz (segment)"]');
  await expect(segmentRow).toBeVisible({ timeout: 10_000 });

  // Give the (suppressed) frame-on-add effect its 50 ms timeout plus margin to
  // fire, so a regression has every chance to move the camera before we look.
  await page.waitForTimeout(500);

  const after = await readCamera(page);
  // The regression this guards is a crop RE-FRAMING the view — a visible jump
  // of order the scene size. Compare to a sub-micrometre tolerance rather than
  // with toEqual: OrbitControls recomputes the camera from its spherical state
  // every frame, so the doubles come back differing in the last bit or two
  // (observed 1.7999999999999967 vs 1.7999999999999958, ~1e-15) without the
  // camera having moved at all. Bit-exact equality is a property no float
  // pipeline promises; on macOS the recompute happened to land on identical
  // doubles, on headless Linux it did not. 1e-9 m is far below anything a
  // re-frame could produce and far above float noise.
  const EPS = 1e-9;
  expect(after.position).toHaveLength(before.position.length);
  for (let i = 0; i < before.position.length; i++) {
    expect(Math.abs(after.position[i] - before.position[i])).toBeLessThan(EPS);
  }
  expect(after.target === null).toBe(before.target === null);
  if (before.target && after.target) {
    for (let i = 0; i < before.target.length; i++) {
      expect(Math.abs(after.target[i] - before.target[i])).toBeLessThan(EPS);
    }
  }
});

test('a Segment cloud inherits its source scan colour', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
  await expect(tinyRow).toBeVisible({ timeout: 20_000 });

  // The first imported scan takes the first palette entry (blue).
  const sourceColor = await tinyRow.getAttribute('data-scan-color');
  expect(sourceColor).toBe('#3b82f6');

  await page.getByTestId('tool-crop').click();
  await expect(page.getByTestId('crop-panel')).toBeVisible();
  await page.getByTestId('crop-mode-segment').click();
  await setKeepMiddleLayers(page);
  await page.getByTestId('crop-apply').click();
  await expect(page.getByTestId('crop-panel')).toHaveCount(0, { timeout: 10_000 });

  const segmentRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz (segment)"]');
  await expect(segmentRow).toBeVisible({ timeout: 10_000 });

  // Regression: this was a hardcoded amber (#f59e0b) regardless of the parent.
  await expect(segmentRow).toHaveAttribute('data-scan-color', sourceColor!);
  // The source keeps its own colour too (the split doesn't recolour the parent).
  await expect(tinyRow).toHaveAttribute('data-scan-color', sourceColor!);
});

test('a retained crop inherits its source scan colour', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
  await expect(tinyRow).toBeVisible({ timeout: 20_000 });
  const sourceColor = await tinyRow.getAttribute('data-scan-color');
  expect(sourceColor).toBe('#3b82f6');

  await page.getByTestId('tool-crop').click();
  await expect(page.getByTestId('crop-panel')).toBeVisible();

  // Keep Inside + "Keep original cloud" → the kept points become a new
  // "(cropped)" cloud and the original survives, hidden.
  const retain = page.getByTestId('crop-retain-original').locator('input[type="checkbox"]');
  await retain.check();
  await expect(retain).toBeChecked();

  await setKeepMiddleLayers(page);
  await page.getByTestId('crop-apply').click();
  await expect(page.getByTestId('crop-panel')).toHaveCount(0, { timeout: 10_000 });

  const croppedRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz (cropped)"]');
  await expect(croppedRow).toBeVisible({ timeout: 10_000 });
  // Regression: this took allocateScanColor's next free entry (green) instead
  // of the parent's blue.
  await expect(croppedRow).toHaveAttribute('data-scan-color', sourceColor!);
});
