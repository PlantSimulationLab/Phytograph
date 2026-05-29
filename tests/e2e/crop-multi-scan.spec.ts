import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
const TINY_OFFSET = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny-offset.xyz');

// Multi-scan crop end-to-end.
//
// Fixtures:
//   - tiny.xyz         — cylinder at origin, r=0.3 h=1.5, 5 z-layers × 12 pts = 60 pts.
//   - tiny-offset.xyz  — same cylinder translated by (+1, 0, 0): x ∈ [0.7, 1.3].
//
// World-space crop region (applied uniformly to both selected scans):
//   X ∈ [-0.5, 1.5]   — covers both cylinders' X extents fully
//   Y ∈ [-0.3, 0.3]   — initial bounds union, covers full Y
//   Z ∈ [0.3, 1.0]    — keeps only the z=0.375 and z=0.75 layers
//
// Expected per-scan result: 2 layers × 12 pts = 24 pts kept, down from 60.
//
// Per CLAUDE.md Testing rules:
//   1. Live backend — but cropping is client-side, so the backend just needs
//      to be up. No /api/crop call. launchApp() verifies it answers /version.
//   2. Drive the real UI — file picker for both imports, click+Shift-click
//      to select both rows, click the Crop tool, type into the dim/center
//      inputs, press Enter to apply. No reaching into window.
//   3. Correctness — read each row's `data-point-count` attribute after
//      apply; assert the exact post-crop count, not just "didn't throw".
test('multi-scan crop applies one world-space box across two selected scans', async () => {
  const { page, close } = await launchApp();

  try {
    await page.getByTestId('nav-viewer').click();

    // ── Import tiny.xyz ────────────────────────────────────────────────────
    await page.getByTestId('import-menu-button').click();
    const [chooser1] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser1.setFiles(TINY);

    const tinyRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(tinyRow).toBeVisible({ timeout: 20_000 });
    await expect(tinyRow).toHaveAttribute('data-point-count', '60');

    // ── Import tiny-offset.xyz ─────────────────────────────────────────────
    await page.getByTestId('import-menu-button').click();
    const [chooser2] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser2.setFiles(TINY_OFFSET);

    const offsetRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny-offset.xyz"]');
    await expect(offsetRow).toBeVisible({ timeout: 20_000 });
    await expect(offsetRow).toHaveAttribute('data-point-count', '60');

    // ── Select both scans (click + Shift-click) ────────────────────────────
    await tinyRow.click();
    await expect(tinyRow).toHaveAttribute('data-selected', 'true');
    await offsetRow.click({ modifiers: ['Shift'] });
    await expect(offsetRow).toHaveAttribute('data-selected', 'true');
    await expect(tinyRow).toHaveAttribute('data-selected', 'true');

    // The single-cloud Crop button shouldn't be in the toolbar when 2+ are
    // selected — the multi-cloud branch renders its own button instead.
    await expect(page.getByTestId('tool-crop')).toHaveCount(0);
    const cropBtn = page.getByTestId('tool-crop-multi');
    await expect(cropBtn).toBeVisible();
    await cropBtn.click();

    // Crop panel appears and shows the multi-scan hint with the right count.
    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-selection-count', '2');
    await expect(panel).toHaveAttribute('data-crop-mode', 'box');
    await expect(page.getByTestId('crop-multi-hint')).toContainText('Applies to 2 scans');

    // Initial cropBox is the union of both scans' bounds in world space:
    // tiny x∈[-0.3,0.3], tiny-offset x∈[0.7,1.3] → union x∈[-0.3,1.3].
    const initialMin = await panel.getAttribute('data-crop-min');
    const initialMax = await panel.getAttribute('data-crop-max');
    expect(initialMin).toBe('-0.300,-0.300,0.000');
    expect(initialMax).toBe('1.300,0.300,1.500');

    // ── Shape the box to keep z∈[0.3, 1.0] and widen X to [-0.5, 1.5]. ────
    // Y can stay at its initial range — both cylinders fit in y∈[-0.3,0.3].
    //
    // Fill + Tab to commit each value (Tab fires DebouncedNumberInput's
    // blur-commit synchronously; Enter on the input would also bubble to
    // the global Enter-applies-crop handler with stale state).
    async function setNumber(testId: string, value: number) {
      const input = page.getByTestId(testId);
      await input.click();
      await input.fill(String(value));
      await input.press('Tab');
    }

    // Z dimension first: size 0.7, center 0.65 → z∈[0.3, 1.0].
    await setNumber('crop-dim-z', 0.7);
    await setNumber('crop-center-z', 0.65);
    // X dimension second: size 2.0, center 0.5 → x∈[-0.5, 1.5].
    await setNumber('crop-dim-x', 2.0);
    await setNumber('crop-center-x', 0.5);

    // Wait for all four commits to land in the cropBox state. Anchored on
    // the live data-crop-min/max attributes — beats arbitrary sleeps.
    await expect(panel).toHaveAttribute('data-crop-min', '-0.500,-0.300,0.300');
    await expect(panel).toHaveAttribute('data-crop-max', '1.500,0.300,1.000');

    // ── Apply ──────────────────────────────────────────────────────────────
    // Enter inside an input only commits the input's value — applying is
    // bound to the explicit Apply button so the user can't trigger a crop
    // by accident while typing a coordinate.
    const applyBtn = page.getByTestId('crop-apply');
    await expect(applyBtn).toBeEnabled();
    await expect(applyBtn).toContainText('2 scans');
    await applyBtn.click();

    // Panel closes after apply.
    await expect(panel).toHaveCount(0, { timeout: 10_000 });

    // ── Assertions: both scans are cropped to their exact expected count ──
    // Each cylinder has 5 z-layers of 12 pts each. The crop keeps z=0.375
    // and z=0.75 only → 2 × 12 = 24 pts per scan. The X-widening step is a
    // no-op for either cylinder (both fit inside [-0.5, 1.5] either way),
    // which is exactly the point: we asserted the predicate doesn't crash
    // or drop points based on an irrelevant axis.
    await expect(tinyRow).toHaveAttribute('data-point-count', '24', { timeout: 5_000 });
    await expect(offsetRow).toHaveAttribute('data-point-count', '24', { timeout: 5_000 });
  } finally {
    await close();
  }
});

// Regression: Enter inside a dimension input must commit the value but
// must NOT also apply the crop. Apply is bound exclusively to the
// explicit Apply button.
test('Enter inside a dim input commits the value without applying the crop', async () => {
  const { page, close } = await launchApp();

  try {
    await page.getByTestId('nav-viewer').click();

    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(TINY);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '60');

    await row.click();
    await page.getByTestId('tool-crop').click();

    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();

    // Type into the Z dimension and commit with Enter. The value should
    // land in the cropBox state (data-crop-min/max updates) but the panel
    // must stay open and the cloud's point count must stay at 60.
    const dimZ = page.getByTestId('crop-dim-z');
    await dimZ.click();
    await dimZ.fill('0.7');
    await dimZ.press('Enter');

    // The data-crop-max attribute reflects the new Z value. Initial Z
    // max was 1.5 with center 0.75; size 0.7 around center 0.75 → max z = 1.1.
    await expect(panel).toHaveAttribute('data-crop-max', /,1\.100$/);
    // Panel still visible (no apply happened).
    await expect(panel).toBeVisible();
    // Cloud point count unchanged.
    await expect(row).toHaveAttribute('data-point-count', '60');
  } finally {
    await close();
  }
});

// Regression for limitation #2 in the original ask: the Crop Region panel
// must have an explicit close button so a user who entered crop mode by
// mistake can back out without applying.
test('crop panel × button dismisses without applying', async () => {
  const { page, close } = await launchApp();

  try {
    await page.getByTestId('nav-viewer').click();

    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(TINY);

    const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '60');

    await row.click();
    await page.getByTestId('tool-crop').click();

    const panel = page.getByTestId('crop-panel');
    await expect(panel).toBeVisible();
    // The default region is the full bounds — applying it would be a no-op
    // on points but would still bake translation / clear history. Closing
    // the panel must skip that path entirely.
    await page.getByTestId('crop-close').click();

    await expect(panel).toHaveCount(0);
    // Cloud's point count is untouched — no rows deleted, no crop applied.
    await expect(row).toHaveAttribute('data-point-count', '60');
  } finally {
    await close();
  }
});
