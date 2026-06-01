import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { completeImportWizard } from './helpers/importWizard';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Polygon (lasso) crop end-to-end.
//
// Fixture:
//   tiny.xyz — cylinder at origin, r=0.3 h=1.5, 5 z-layers × 12 pts = 60 pts.
//
// This is the screen-space lasso path, distinct from the world-space box
// crop covered by crop-multi-scan.spec.ts. The reported failure mode was
// "enable the polygon tool, click in the viewport, nothing happens" — so
// this test asserts each step of the interaction visibly takes effect:
//
//   1. Selecting the Polygon shape flips data-crop-mode and mounts the SVG
//      lasso overlay with pointer events ENABLED (the gate for clicks).
//   2. Each click in the viewport adds a polygon vertex — asserted by the
//      count of <circle> markers the overlay renders, not by "didn't throw".
//   3. Enter closes the polygon (≥3 verts), which enables the Apply button.
//   4. Apply runs the real screen-space predicate against the live camera.
//
// Correctness, not error-absence: we draw a polygon covering essentially
// the whole viewport, so a Keep-Inside crop must retain all 60 points
// (every point projects inside), and the panel must close. A regression
// that silently dropped the projection or the predicate would change the
// surviving count and fail here.
test('polygon lasso crop: clicks add vertices, Enter closes, Apply keeps enclosed points', async () => {
  const { page, close } = await launchApp();

  try {

    // ── Import tiny.xyz ────────────────────────────────────────────────────
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(TINY);
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '60');

    // ── Enter crop mode (single-cloud) ─────────────────────────────────────
    await row.click();
    await expect(row).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('tool-crop').click();

    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();
    // Crop defaults to box.
    await expect(panel).toHaveAttribute('data-crop-mode', 'box');

    // ── Switch to Polygon shape ────────────────────────────────────────────
    await page.getByTestId('crop-shape-polygon').click();
    await expect(panel).toHaveAttribute('data-crop-mode', 'polygon');

    // The lasso overlay mounts and — critically for the reported bug — must
    // accept pointer events while drawing. If pointer-events were 'none'
    // (or the overlay never mounted), clicks would fall through and "do
    // nothing", which is exactly the symptom we're guarding against.
    const overlay = page.getByTestId('crop-polygon-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toHaveCSS('pointer-events', 'auto');

    const box = await overlay.boundingBox();
    if (!box) throw new Error('crop-polygon-overlay has no bounding box');

    // Four vertices near the corners → a near-full-viewport quad. Inset by
    // a few px so clicks land inside the SVG, not on its edge.
    const inset = 8;
    const corners = [
      { x: box.x + inset, y: box.y + inset },
      { x: box.x + box.width - inset, y: box.y + inset },
      { x: box.x + box.width - inset, y: box.y + box.height - inset },
      { x: box.x + inset, y: box.y + box.height - inset },
    ];

    // ── Click to add vertices ──────────────────────────────────────────────
    // After each click a <circle> vertex marker must appear. This is the
    // direct assertion that "clicking in the viewport" registers.
    for (let i = 0; i < corners.length; i++) {
      await page.mouse.click(corners[i].x, corners[i].y);
      await expect(overlay.locator('circle')).toHaveCount(i + 1);
    }

    // ── Close the polygon ──────────────────────────────────────────────────
    // Apply is disabled until the polygon is closed (≥3 verts + Enter).
    const applyBtn = page.getByTestId('crop-apply');
    await expect(applyBtn).toBeDisabled();

    await page.keyboard.press('Enter');

    // Closing the polygon enables Apply.
    await expect(applyBtn).toBeEnabled();

    // ── Apply (Keep Inside) ────────────────────────────────────────────────
    // Default mode is Keep Inside. The quad covers the whole viewport, so
    // every projected point is enclosed → all 60 survive. We assert the
    // real predicate ran (panel closed, no crash) AND produced the correct
    // count — not merely that nothing threw.
    await applyBtn.click();

    await expect(panel).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

    await expect(row).toHaveAttribute('data-point-count', '60', { timeout: 5_000 });
  } finally {
    await close();
  }
});

// Companion: a full-viewport polygon with Keep Outside encloses every
// point and excludes all of them — i.e. the crop would empty the cloud.
// The app treats an emptying crop as a delete and asks for confirmation
// rather than silently dropping the cloud; confirming removes the row.
// This proves the invert path + projection predicate actually discriminate
// (the Keep-Inside test alone could pass for a trivial keep-all reason).
test('polygon lasso crop: Keep Outside enclosing all points empties the cloud (delete-confirm)', async () => {
  const { page, close } = await launchApp();

  try {

    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(TINY);
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '60');

    await row.click();
    await page.getByTestId('tool-crop').click();

    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();

    await page.getByTestId('crop-shape-polygon').click();
    await expect(panel).toHaveAttribute('data-crop-mode', 'polygon');

    // Keep Outside — exclude everything inside the lasso.
    await panel.getByText('Keep Outside', { exact: true }).click();

    const overlay = page.getByTestId('crop-polygon-overlay');
    await expect(overlay).toBeVisible();
    const box = await overlay.boundingBox();
    if (!box) throw new Error('crop-polygon-overlay has no bounding box');

    const inset = 8;
    const corners = [
      { x: box.x + inset, y: box.y + inset },
      { x: box.x + box.width - inset, y: box.y + inset },
      { x: box.x + box.width - inset, y: box.y + box.height - inset },
      { x: box.x + inset, y: box.y + box.height - inset },
    ];
    for (let i = 0; i < corners.length; i++) {
      await page.mouse.click(corners[i].x, corners[i].y);
      await expect(overlay.locator('circle')).toHaveCount(i + 1);
    }

    await page.keyboard.press('Enter');
    const applyBtn = page.getByTestId('crop-apply');
    await expect(applyBtn).toBeEnabled();
    await applyBtn.click();

    await expect(panel).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

    // Every point was inside the quad → Keep Outside excludes all of them,
    // which would empty the cloud. That surfaces a delete-confirm dialog
    // (an emptying crop == a delete, confirmed first) rather than a 0-point
    // cloud. Confirm it and assert the row is removed.
    const confirm = page.getByTestId('confirm-delete');
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await confirm.click();
    await expect(row).toHaveCount(0, { timeout: 5_000 });
  } finally {
    await close();
  }
});

// The strongest of the three: a lasso over only the LEFT half of the
// viewport must keep a STRICT SUBSET — neither all 60 nor 0. The cylinder
// straddles the viewport centre, so a half-cut splits it. This is what
// would fail if the polygon's pixel space and the crop projection's pixel
// space diverged again (the original bug): the surviving count would jump
// to 0 or 60 instead of landing in between.
test('polygon lasso crop: half-viewport lasso keeps a strict subset of points', async () => {
  const { page, close } = await launchApp();

  try {

    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(TINY);
    await completeImportWizard(page);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '60');

    await row.click();
    await page.getByTestId('tool-crop').click();

    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();
    await page.getByTestId('crop-shape-polygon').click();
    await expect(panel).toHaveAttribute('data-crop-mode', 'polygon');

    const overlay = page.getByTestId('crop-polygon-overlay');
    await expect(overlay).toBeVisible();
    const box = await overlay.boundingBox();
    if (!box) throw new Error('crop-polygon-overlay has no bounding box');

    // Left half of the viewport, full height. The crop panel floats over
    // the right edge (z-20, above the overlay), so cutting the LEFT half
    // keeps clicks well clear of it.
    const inset = 8;
    const midX = box.x + box.width / 2;
    const corners = [
      { x: box.x + inset, y: box.y + inset },
      { x: midX, y: box.y + inset },
      { x: midX, y: box.y + box.height - inset },
      { x: box.x + inset, y: box.y + box.height - inset },
    ];
    for (let i = 0; i < corners.length; i++) {
      await page.mouse.click(corners[i].x, corners[i].y);
      await expect(overlay.locator('circle')).toHaveCount(i + 1);
    }

    await page.keyboard.press('Enter');
    const applyBtn = page.getByTestId('crop-apply');
    await expect(applyBtn).toBeEnabled();
    await applyBtn.click();

    await expect(panel).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

    // Strict subset: 0 < kept < 60. A half-plane through a centred cloud
    // can't keep everything or nothing unless projection broke.
    await expect
      .poll(async () => {
        if ((await row.count()) === 0) return -1; // emptied → treated as failure
        return Number(await row.getAttribute('data-point-count'));
      }, { timeout: 8_000 })
      .toBeGreaterThan(0);
    const kept = Number(await row.getAttribute('data-point-count'));
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(60);
  } finally {
    await close();
  }
});
