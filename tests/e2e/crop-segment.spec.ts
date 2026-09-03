import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Crop "Segment (keep both)" end-to-end.
//
// Fixture:
//   - tiny.xyz — cylinder at origin, r=0.3 h=1.5, 5 z-layers × 12 pts = 60 pts.
//
// World-space crop box keeps z∈[0.3, 1.0] (the z=0.375 and z=0.75 layers) →
// 2 layers × 12 = 24 pts kept inside. With Segment enabled, the cropped-out
// 36 pts (the other 3 layers) become a NEW "tiny.xyz (segment)" cloud instead
// of being discarded.
//
// Per CLAUDE.md Testing rules: live backend, real UI (file picker, real
// toggle + Apply button), and a correctness assertion on the exact point
// counts of BOTH resulting clouds — kept (24) + segment (36) = original (60),
// so no points are lost.
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).

// Count BLUE pixels — i.e. rendered cloud points, not the crop gizmo.
//
// The first imported scan is coloured #3b82f6 (blue) by SCAN_COLORS in App.tsx,
// while the crop box draws in green (#22c55e) over a large translucent face.
// Counting "blue dominates red and green" therefore isolates the points from
// the box: a plain brightness count is swamped by the box's ~100k fill pixels
// and cannot resolve a 60-point cloud at all (measured: the whole cloud is
// worth ~500 pixels against a ~102k background).
//
// Decoded in the browser because Node here has no image library — same trick as
// mesh-selection-outline.spec.ts.
async function countPointPixels(
  page: import('@playwright/test').Page,
  pngBuffer: Buffer,
): Promise<number> {
  const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;
  return page.evaluate(async (url) => {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej();
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (b > 90 && b > r + 30 && b > g + 20) n++;
    }
    return n;
  }, dataUrl);
}

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

test('crop Segment splits a scan in two without losing points', async () => {
  const { app, page } = session;

  // ── Import tiny.xyz ────────────────────────────────────────────────────
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(tinyRow).toBeVisible({ timeout: 20_000 });
  await expect(tinyRow).toHaveAttribute('data-point-count', '60');

  // ── Enter crop ─────────────────────────────────────────────────────────
  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(tinyRow).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('tool-crop').click();

  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-crop-mode', 'box');

  // ── Pick the Segment mode (third option in the Mode row) ───────────────
  const segmentMode = page.getByTestId('crop-mode-segment');
  await expect(segmentMode).toHaveAttribute('aria-pressed', 'false');
  await segmentMode.click();
  await expect(segmentMode).toHaveAttribute('aria-pressed', 'true');
  // The other two Mode options deselect — they're mutually exclusive.
  await expect(page.getByTestId('crop-mode-inside')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('crop-mode-outside')).toHaveAttribute('aria-pressed', 'false');
  // Apply button relabels to reflect the segment action.
  await expect(page.getByTestId('crop-apply')).toContainText('Segment');

  // ── Shape the box: keep z∈[0.3, 1.0] (size 0.7, center 0.65). ──────────
  // X/Y are set WIDER than the cylinder (r=0.3) so every point is strictly
  // interior on those axes and only Z selects the layers. Leaving X/Y at the
  // auto-fit extent (±0.3) put the 4 cardinal points of each layer exactly on
  // the box faces, where inclusion flips with sub-mm float rounding that
  // differs across platforms (macOS kept all 24; Linux CI dropped 2-4 → 20/22).
  // Widening removes that boundary ambiguity without weakening the 24/36/60
  // assertion.
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
  await expect(panel).toHaveAttribute('data-crop-max', /,1\.000$/);

  // ── Apply ──────────────────────────────────────────────────────────────
  const applyBtn = page.getByTestId('crop-apply');
  await expect(applyBtn).toBeEnabled();
  await applyBtn.click();

  // Panel closes and the crop finishes.
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

  // ── Assertions ─────────────────────────────────────────────────────────
  // Original scan keeps the in-region points: z=0.375 and z=0.75 → 24 pts.
  await expect(tinyRow).toHaveAttribute('data-point-count', '24', { timeout: 10_000 });

  // A new "tiny.xyz (segment)" cloud holds the cropped-out points: the
  // other 3 layers → 36 pts. No points lost (24 + 36 = 60).
  const segmentRow = page.locator(
    '[data-testid="scan-row"][data-scan-name="tiny (segment)"]',
  );
  await expect(segmentRow).toBeVisible({ timeout: 10_000 });
  await expect(segmentRow).toHaveAttribute('data-point-count', '36', { timeout: 10_000 });
});

// Regression: with Segment OFF, crop behaves exactly as before — the
// cropped-out points are discarded and no extra cloud is added.
test('crop without Segment discards cropped-out points (no new cloud)', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(tinyRow).toBeVisible({ timeout: 20_000 });
  await expect(tinyRow).toHaveAttribute('data-point-count', '60');

  // Freshly imported scan is auto-selected (no re-click — that would toggle off).
  await expect(tinyRow).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('tool-crop').click();

  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();
  // Mode defaults to Keep Inside; Segment is not selected.
  await expect(page.getByTestId('crop-mode-inside')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('crop-mode-segment')).toHaveAttribute('aria-pressed', 'false');
  // "Keep original cloud" defaults OFF, so this stays the destructive path.
  // (The retain path has its own spec.)
  await expect(page.getByTestId('crop-retain-original').locator('input')).not.toBeChecked();

  async function setNumber(testId: string, value: number) {
    const input = page.getByTestId(testId);
    await input.click();
    await input.fill(String(value));
    await input.press('Tab');
  }
  // Widen X/Y beyond the cylinder (r=0.3) so no point sits exactly on a box
  // face — see the note in the Segment test above. Only Z selects the layers.
  await setNumber('crop-dim-x', 1.0);
  await setNumber('crop-center-x', 0);
  await setNumber('crop-dim-y', 1.0);
  await setNumber('crop-center-y', 0);
  await setNumber('crop-dim-z', 0.7);
  await setNumber('crop-center-z', 0.65);
  await expect(panel).toHaveAttribute('data-crop-max', /,1\.000$/);

  await page.getByTestId('crop-apply').click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText('Cropping…')).toHaveCount(0, { timeout: 10_000 });

  // Original cropped to 24; no "(segment)" cloud exists.
  await expect(tinyRow).toHaveAttribute('data-point-count', '24', { timeout: 10_000 });
  await expect(
    page.locator('[data-testid="scan-row"][data-scan-name="tiny (segment)"]'),
  ).toHaveCount(0);
  // Exactly one scan row in total.
  await expect(page.getByTestId('scan-row')).toHaveCount(1);
});

// Preview semantics: Segment mode keeps the ENTIRE cloud visible while the crop
// box is being positioned — only the box outline marks where the split will
// fall. Keep Inside / Keep Outside still cull, because there the hidden points
// really are the ones about to be discarded; in Segment mode both halves
// survive, so hiding either one misrepresents the result.
//
// Measured against the rendered canvas rather than internal state: with a box
// that keeps only 1 of the 5 z-layers, Keep Inside must visibly drop points
// (fewer lit pixels than the uncropped cloud) while Segment must not.
test('Segment mode previews the whole cloud; Keep Inside culls', async () => {
  const { app, page } = session;

  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(tinyRow).toBeVisible({ timeout: 20_000 });
  await expect(tinyRow).toHaveAttribute('data-point-count', '60');

  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  // Settle the initial auto-frame before entering crop mode.
  await expect
    .poll(async () => countPointPixels(page, await canvas.screenshot()), { timeout: 15_000 })
    .toBeGreaterThan(0);

  await expect(tinyRow).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('tool-crop').click();
  const panel = page.getByTestId('crop-panel');
  await expect(panel).toBeVisible();

  async function setNumber(testId: string, value: number) {
    const input = page.getByTestId(testId);
    await input.click();
    await input.fill(String(value));
    await input.press('Tab');
  }
  // Keep only the z=0.375 layer (12 of 60 points) — a large, unambiguous
  // difference if culling is active. X/Y stay wide of the cylinder (r=0.3) so
  // only Z selects, matching the boundary-safety note in the tests above.
  await setNumber('crop-dim-x', 1.0);
  await setNumber('crop-center-x', 0);
  await setNumber('crop-dim-y', 1.0);
  await setNumber('crop-center-y', 0);
  await setNumber('crop-dim-z', 0.2);
  await setNumber('crop-center-z', 0.375);
  await expect(panel).toHaveAttribute('data-crop-max', /,0\.475$/);

  // Both measurements below are taken INSIDE crop mode with the box gizmo on
  // screen, and Segment leaves cropInvert false — so the CropBox renders with
  // identical geometry and identical (green) color in both. The gizmo therefore
  // contributes the same pixels to each, and the only difference between the
  // two counts is whether the 48 out-of-box points are drawn.
  //
  // (Keep Outside is deliberately not compared here: it flips the box to red,
  // which would change the gizmo's pixel contribution and confound the count.)
  // Settle on a stable Keep-Inside count rather than sleeping a fixed 800 ms —
  // a fixed sleep is exactly the shape that has flaked on slower CI before.
  await expect(page.getByTestId('crop-mode-inside')).toHaveAttribute('aria-pressed', 'true');
  let keepInsideBlue = -1;
  await expect
    .poll(async () => {
      const n = await countPointPixels(page, await canvas.screenshot());
      const stable = n === keepInsideBlue;
      keepInsideBlue = n;
      return stable;
    }, { timeout: 15_000 })
    .toBe(true);

  await page.getByTestId('crop-mode-segment').click();
  await expect(page.getByTestId('crop-mode-segment')).toHaveAttribute('aria-pressed', 'true');

  // Segment un-hides the 48 points the Keep-Inside preview was culling, so the
  // blue-pixel count must rise and then hold above the Keep-Inside figure.
  await expect
    .poll(async () => countPointPixels(page, await canvas.screenshot()), { timeout: 15_000 })
    .toBeGreaterThan(keepInsideBlue);

  // The box outline is still drawn — Segment suppresses culling, not the gizmo.
  await expect(panel).toHaveAttribute('data-crop-mode', 'box');
});
