import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// A committed ROTATION moves the session geometry immediately but leaves the
// octree in its old frame, drawn through a stored pose.
//
// The point is cost: reindexing the octree after a rotation is a full
// PotreeConverter run (~83 s on a 10 M-point scan, essentially all of it inside
// the converter's node-building stage), while moving the geometry — which is all
// any compute path reads — is one numpy pass. So the geometry is written eagerly
// and the display cache is posed instead.
//
// These drive the real UI against the live backend and assert on concrete
// values: that the octree really was NOT rebuilt, that the cloud is drawn where
// the rotation puts it, and that a screen-space edit forces the refresh it needs.
const ORCHARD = join(repoRoot, 'tests', 'e2e', 'fixtures', 'orchard-row.xyz');

test.describe('stored-pose transform', () => {
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

  const row = () => session.page.locator('[data-testid="scan-row"][data-scan-name="orchard-row.xyz"]');

  async function importOrchard() {
    const { app, page } = session;
    await importFiles(app, page, 'import-auto', ORCHARD);
    await completeImportWizard(page);
    await expect(row()).toBeVisible({ timeout: 30_000 });
    // Load-bearing: the stored pose only exists on the octree path.
    await expect(row()).toHaveAttribute('data-octree', 'true');
    // A freshly imported scan is auto-selected; re-clicking would toggle it off.
    await expect(row()).toHaveAttribute('data-selected', 'true');
    await page.waitForFunction(() => {
      const reg = (window as any).__octreePositions;
      return reg && Object.keys(reg).length >= 1;
    }, { timeout: 30_000 });
  }

  const bounds = async () => {
    const raw = await row().getAttribute('data-scan-bounds');
    if (!raw) throw new Error('scan row has no data-scan-bounds');
    const n = raw.split(',').map(Number);
    return { min: [n[0], n[1], n[2]], max: [n[3], n[4], n[5]] };
  };

  /** Rotate the selected cloud about Z through the real Transform panel. */
  async function rotateZ(deg: string) {
    const { page } = session;
    await page.getByTestId('tool-cloud-translate').click();
    await expect(page.getByTestId('translate-panel')).toBeVisible();
    const input = page.getByTestId('rotation-input-z');
    await input.fill(deg);
    await input.press('Enter');
    await page.getByTestId('translate-ok').click();
    await expect(page.getByTestId('translate-panel')).toBeHidden({ timeout: 120_000 });
  }

  test('a rotation commits without rebuilding the octree', async () => {
    await importOrchard();
    const before = await row().getAttribute('data-octree-cache-id');
    const b0 = await bounds();

    const started = Date.now();
    await rotateZ('30');
    const elapsed = Date.now() - started;

    // THE feature: the display cache was not reindexed.
    await expect(row()).toHaveAttribute('data-octree-cache-id', before!);

    // A regression to the reconvert path would put this in the tens of seconds
    // on a real scan. Generous so a slow CI box doesn't flake it — the point is
    // to catch an order-of-magnitude regression, not to benchmark.
    expect(elapsed, 'commit should not wait on a PotreeConverter run').toBeLessThan(30_000);

    // The cloud is DRAWN rotated: a 30 deg turn of a long row widens its Y span.
    const b1 = await bounds();
    const spanY0 = b0.max[1] - b0.min[1];
    const spanY1 = b1.max[1] - b1.min[1];
    expect(spanY1).toBeGreaterThan(spanY0 + 0.5);

    // And the octree object really carries the rotation (not just the row text).
    const m = await session.page.evaluate((id) => {
      const e = (window as any).__octreePositions?.[id];
      return e?.matrix ?? null;
    }, before!);
    expect(m, '__octreePositions must expose the object matrix').not.toBeNull();
    // Column-major: m[0] = cos(30 deg), m[1] = sin(30 deg).
    expect(m[0]).toBeCloseTo(Math.cos(Math.PI / 6), 3);
    expect(m[1]).toBeCloseTo(Math.sin(Math.PI / 6), 3);
  });

  test('the geometry really moved — a second rotation composes on the first', async () => {
    await importOrchard();
    const before = await row().getAttribute('data-octree-cache-id');

    await rotateZ('30');
    await rotateZ('30');

    // Still the same octree, now posed by the COMBINED 60 deg. If the second
    // commit had been applied to un-moved geometry, or the poses had replaced
    // rather than composed, this would read 30 deg.
    await expect(row()).toHaveAttribute('data-octree-cache-id', before!);
    const m = await session.page.evaluate((id) => {
      const e = (window as any).__octreePositions?.[id];
      return e?.matrix ?? null;
    }, before!);
    expect(m[0]).toBeCloseTo(Math.cos(Math.PI / 3), 3);
    expect(m[1]).toBeCloseTo(Math.sin(Math.PI / 3), 3);
  });

  test('a compute tool run on a posed cloud uses the MOVED geometry', async () => {
    // The correctness claim behind the whole design: compute reads the session
    // arrays, which were written eagerly, so it must see the rotated cloud even
    // though the octree on disk is still the original.
    //
    // Skeleton extraction is a real compute path through `buildPointSource`, and
    // its result is placed in world space — so if it had run against un-rotated
    // points the skeleton would sit visibly off the cloud.
    await importOrchard();
    const before = await row().getAttribute('data-octree-cache-id');
    await rotateZ('90');
    const posed = await bounds();

    const { page } = session;
    await page.getByTestId('tool-skeleton').click();
    const panel = page.getByTestId('skeleton-panel');
    await expect(panel).toBeVisible();
    await page.getByTestId('skeleton-extract-button').click();

    const skelRow = page.getByTestId('skeleton-row').first();
    await expect(skelRow).toBeVisible({ timeout: 240_000 });

    // The octree was never rebuilt for the compute — it is still the posed one.
    await expect(row()).toHaveAttribute('data-octree-cache-id', before!);
    // And the cloud's reported extent is still the rotated one.
    const after = await bounds();
    expect(after.min[0]).toBeCloseTo(posed.min[0], 3);
    expect(after.max[1]).toBeCloseTo(posed.max[1], 3);
  });

  test('a lasso crop refreshes the octree first, then applies in the right place', async () => {
    // Screen-space regions freeze the camera that was looking at the POSED
    // octree; the backend replays it against session positions. The two frames
    // have to be reconciled first, which is the one place the refresh is paid.
    await importOrchard();
    const before = await row().getAttribute('data-octree-cache-id');
    const countBefore = Number(await row().getAttribute('data-point-count'));
    await rotateZ('30');
    await expect(row()).toHaveAttribute('data-octree-cache-id', before!);

    const { page } = session;
    await page.getByTestId('tool-crop').click();
    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();
    // Rect is a SCREEN-SPACE region (a frozen camera), which is exactly the case
    // that cannot be evaluated against a posed octree.
    await page.getByTestId('crop-shape-rect').click();
    await expect(panel).toHaveAttribute('data-crop-mode', 'rect');

    const overlay = page.getByTestId('crop-rect-overlay');
    await expect(overlay).toBeVisible();
    const box = await overlay.boundingBox();
    if (!box) throw new Error('crop-rect-overlay has no bounding box');

    // A rectangle over the LEFT HALF only. A near-full-viewport box encloses the
    // whole cloud and the crop is a no-op, which says nothing about whether the
    // region landed in the right frame — the point of this test is that some
    // points survive and some do not.
    await page.mouse.move(box.x + box.width * 0.05, box.y + box.height * 0.05);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.95);
    await page.mouse.up();

    const applyBtn = page.getByTestId('crop-apply');
    await expect(applyBtn).toBeEnabled();
    await applyBtn.click();
    await expect(panel).toBeHidden({ timeout: 240_000 });

    // The refresh happened: the octree is no longer the posed original.
    await expect(row()).not.toHaveAttribute('data-octree-cache-id', before!, { timeout: 240_000 });
    // And the crop actually removed points rather than silently no-opping.
    await expect.poll(async () => Number(await row().getAttribute('data-point-count')), {
      message: 'crop should have removed points',
      timeout: 60_000,
    }).toBeLessThan(countBefore);
    // ...but not ALL of them. A region evaluated in the wrong frame would most
    // likely miss the cloud entirely, and "0 left" would otherwise satisfy the
    // assertion above.
    expect(Number(await row().getAttribute('data-point-count'))).toBeGreaterThan(0);
  });
});
