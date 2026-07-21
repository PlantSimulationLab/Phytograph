import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

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
test('crop Segment splits a scan in two without losing points', async () => {
  const { app, page, close } = await launchApp();

  try {

    // ── Import tiny.xyz ────────────────────────────────────────────────────
    await importFiles(app, page, 'import-auto', TINY);
    await completeImportWizard(page);

    const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
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
      '[data-testid="scan-row"][data-scan-name="tiny.xyz (segment)"]',
    );
    await expect(segmentRow).toBeVisible({ timeout: 10_000 });
    await expect(segmentRow).toHaveAttribute('data-point-count', '36', { timeout: 10_000 });
  } finally {
    await close();
  }
});

// Regression: with Segment OFF, crop behaves exactly as before — the
// cropped-out points are discarded and no extra cloud is added.
test('crop without Segment discards cropped-out points (no new cloud)', async () => {
  const { app, page, close } = await launchApp();

  try {

    await importFiles(app, page, 'import-auto', TINY);
    await completeImportWizard(page);

    const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
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
      page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz (segment)"]'),
    ).toHaveCount(0);
    // Exactly one scan row in total.
    await expect(page.getByTestId('scan-row')).toHaveCount(1);
  } finally {
    await close();
  }
});
