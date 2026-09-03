import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
const TREE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// Crop "Keep original cloud" end-to-end.
//
// Fixture:
//   - tiny.xyz — cylinder at origin, r=0.3 h=1.5, 5 z-layers × 12 pts = 60 pts.
//
// The same z∈[0.3, 1.0] box as crop-segment.spec.ts keeps 24 pts. With the
// retain box ticked, those 24 land in a NEW "tiny.xyz (cropped)" cloud and the
// source survives untouched at 60 pts — hidden, so the viewport is unchanged.
//
// The load-bearing assertion throughout is that the ORIGINAL still reads 60
// after the apply: it proves the backend `extract` built a child session
// without touching the parent's arrays (the destructive path would have run
// delete_region + bake, which compacts them irreversibly).
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).

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

// Shape the crop box to keep z∈[0.3, 1.0]. X/Y are set WIDER than the cylinder
// (r=0.3) so every point is strictly interior on those axes and only Z selects
// the layers — points sitting exactly on a box face flip inclusion with sub-mm
// float rounding that differs across platforms (see crop-segment.spec.ts).
async function setKeepZBox(page: LaunchedApp['page']) {
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
  await expect(page.getByTestId('crop-panel')).toHaveAttribute('data-crop-max', /,1\.000$/);
}

test('retained crop adds a new cloud and leaves the original intact but hidden', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(tinyRow).toBeVisible({ timeout: 20_000 });
  await expect(tinyRow).toHaveAttribute('data-point-count', '60');
  await expect(tinyRow).toHaveAttribute('data-visible', 'true');

  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(tinyRow).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('tool-crop').click();

  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();

  // Tick "Keep original cloud" — off by default, so the destructive path is
  // what an untouched panel still does.
  const retain = page.getByTestId('crop-retain-original').locator('input');
  await expect(retain).not.toBeChecked();
  await retain.check();
  await expect(retain).toBeChecked();

  await setKeepZBox(page);

  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

  // The original is UNTOUCHED at its full 60 points — proof the parent session
  // was never cropped — and hidden so the viewport matches a destructive crop.
  await expect(tinyRow).toHaveAttribute('data-point-count', '60', { timeout: 10_000 });
  await expect(tinyRow).toHaveAttribute('data-visible', 'false');

  // The kept points landed in a new, visible, octree-backed cloud.
  const croppedRow = page.locator(
    '[data-testid="scan-row"][data-scan-name="tiny (cropped)"]',
  );
  await expect(croppedRow).toBeVisible({ timeout: 10_000 });
  await expect(croppedRow).toHaveAttribute('data-point-count', '24', { timeout: 10_000 });
  await expect(croppedRow).toHaveAttribute('data-visible', 'true');
  await expect(croppedRow).toHaveAttribute('data-octree', 'true');

  // Exactly two rows: the retained original and the crop.
  await expect(page.getByTestId('scan-row')).toHaveCount(2);

  // Selection moved to the new cloud. A hidden-but-selected original would be
  // silently re-cropped by the next apply (handleApplyCrop gates on selection,
  // not visibility), so this is a correctness assertion, not cosmetics.
  await expect(croppedRow).toHaveAttribute('data-selected', 'true');
  await expect(tinyRow).toHaveAttribute('data-selected', 'false');
});

test('a retained crop is undoable — undo removes the crop and restores nothing else', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(tinyRow).toBeVisible({ timeout: 20_000 });
  await expect(tinyRow).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-crop').click();
  await expect(page.getByTestId('crop-panel')).toBeVisible();
  await page.getByTestId('crop-retain-original').locator('input').check();
  await setKeepZBox(page);
  await page.getByTestId('crop-apply').click();
  await expect(page.getByTestId('crop-panel')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('scan-row')).toHaveCount(2, { timeout: 10_000 });

  // A retained crop destroys nothing, so it enters history as an ordinary
  // invertible `add` — no scene.boundary is taken. (A DESTRUCTIVE crop does
  // take one and is therefore NOT undoable; that asymmetry is the point.)
  await page.keyboard.press('ControlOrMeta+z');

  await expect(page.getByTestId('scan-row')).toHaveCount(1, { timeout: 10_000 });
  await expect(tinyRow).toHaveAttribute('data-point-count', '60');
  await expect(
    page.locator('[data-testid="scan-row"][data-scan-name="tiny (cropped)"]'),
  ).toHaveCount(0);
});

test('the retain option is disabled in Segment mode', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(tinyRow).toBeVisible({ timeout: 20_000 });
  await expect(tinyRow).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('tool-crop').click();
  await expect(page.getByTestId('crop-panel')).toBeVisible();

  const retain = page.getByTestId('crop-retain-original').locator('input');
  await expect(retain).toBeEnabled();

  // Tick it, THEN switch to Segment: the box must read unchecked while
  // disabled, so the user can't believe a retain is pending when it isn't.
  await retain.check();
  await expect(retain).toBeChecked();
  await page.getByTestId('crop-mode-segment').click();
  await expect(retain).toBeDisabled();
  await expect(retain).not.toBeChecked();
  await expect(page.getByTestId('crop-panel')).toContainText('Segment already keeps both halves');

  // Back to a non-segment mode and it's live again.
  await page.getByTestId('crop-mode-inside').click();
  await expect(retain).toBeEnabled();
});

test('retained crop preserves the scanner origin on the new cloud', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(tinyRow).toBeVisible({ timeout: 20_000 });
  const originBefore = await tinyRow.getAttribute('data-scan-origin');

  await expect(tinyRow).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('tool-crop').click();
  await expect(page.getByTestId('crop-panel')).toBeVisible();
  await page.getByTestId('crop-retain-original').locator('input').check();
  await setKeepZBox(page);
  await page.getByTestId('crop-apply').click();
  await expect(page.getByTestId('crop-panel')).toHaveCount(0, { timeout: 10_000 });

  const croppedRow = page.locator(
    '[data-testid="scan-row"][data-scan-name="tiny (cropped)"]',
  );
  await expect(croppedRow).toBeVisible({ timeout: 10_000 });

  // A crop is a subset of the SAME scanner's returns, so the beam apex is still
  // valid and must ride along — dropping it would silently disable Backfill
  // Misses / Helios triangulation / LAD on the cropped cloud. Whatever the
  // original carried (a plain XYZ import carries none), the crop matches.
  await expect(croppedRow).toHaveAttribute('data-scan-origin', originBefore ?? '');
});

test('multi-scan retained crop derives one uniquely-named cloud per source', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', [TINY, TREE]);
  await completeImportWizard(page);

  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  const treeRow = page.locator('[data-testid="scan-row"][data-scan-name="tree"]');
  await expect(tinyRow).toBeVisible({ timeout: 20_000 });
  await expect(treeRow).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('scan-row')).toHaveCount(2);

  // Select both scans (click + Shift-click, as crop-multi-scan.spec.ts does).
  await tinyRow.click();
  await expect(tinyRow).toHaveAttribute('data-selected', 'true');
  await treeRow.click({ modifiers: ['Shift'] });
  await expect(treeRow).toHaveAttribute('data-selected', 'true');
  await expect(tinyRow).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-crop').click();
  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-selection-count', '2');
  await page.getByTestId('crop-retain-original').locator('input').check();
  await setKeepZBox(page);
  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 15_000 });

  // Four rows: both originals retained + one crop each. The distinct names are
  // the guard on reading the live cloud list per iteration — a stale snapshot
  // would hand both children the same label.
  await expect(page.getByTestId('scan-row')).toHaveCount(4, { timeout: 15_000 });
  await expect(
    page.locator('[data-testid="scan-row"][data-scan-name="tiny (cropped)"]'),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="scan-row"][data-scan-name="tree (cropped)"]'),
  ).toHaveCount(1);

  // Both originals survive, hidden and at their full counts.
  await expect(tinyRow).toHaveAttribute('data-visible', 'false');
  await expect(treeRow).toHaveAttribute('data-visible', 'false');
  await expect(tinyRow).toHaveAttribute('data-point-count', '60');
});
