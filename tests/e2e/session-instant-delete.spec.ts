import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { completeImportWizard } from './helpers/importWizard';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Family-1 mutable cloud model — instant erase + permanently-apply (bake).
//
// The cloud is imported into a backend SESSION (the in-RAM NumPy array is the
// source of truth). Erase sets a per-point mask on that array INSTANTLY — the
// scan row's point count drops immediately (driven by the backend-reported
// deleted count), with NO PotreeConverter rebuild. "Permanently apply
// deletions" then bakes a fresh octree from the surviving array points.
//
// This proves the core goal: edits don't re-read the source file or rebuild the
// octree on every stroke — the count reflects the deletion the moment it's
// applied, and the slow step is the explicit, one-time bake.

test('erase masks instantly (count drops with no rebuild), then bake applies', async () => {
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
    await expect(row).toHaveAttribute('data-selected', 'true');

    // Frame the cloud so it fills the viewport (cylinder side-on).
    await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
    await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));

    await page.getByTestId('tool-erase').click();
    const panel = page.getByTestId('erase-panel');
    await expect(panel).toBeVisible();
    await page.getByTestId('erase-mode-toggle').click();
    await expect(panel).toHaveAttribute('data-erase-active', 'true');
    await page.waitForTimeout(300);

    // Large brush so a single stamp removes an unambiguous chunk.
    const slider = panel.locator('input[type="range"]');
    const maxPx = await slider.getAttribute('max');
    await slider.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, maxPx ?? '150');

    const box = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect
      .poll(async () => Number(await panel.getAttribute('data-stamp-count')), { timeout: 5_000 })
      .toBeGreaterThan(0);

    // Apply erase: this is a session delete_region (instant mask). The point
    // count must drop QUICKLY — no PotreeConverter rebuild. Use a tight timeout
    // to prove it's instant, not a cold-start re-conversion.
    await page.getByTestId('erase-apply').click();
    await expect
      .poll(async () => {
        if ((await row.count()) === 0) return -1;
        return Number(await row.getAttribute('data-point-count'));
      }, { timeout: 8_000 })
      .toBeLessThan(60);
    const afterErase = Number(await row.getAttribute('data-point-count'));
    expect(afterErase).toBeGreaterThan(0);
    expect(afterErase).toBeLessThan(60);

    // The "Permanently apply deletions" (bake) button is now offered.
    const bakeBtn = page.getByTestId('erase-bake');
    await expect(bakeBtn).toBeVisible();
    await bakeBtn.click();

    // After bake the octree is rebuilt from the survivors; the count holds at
    // the post-erase value (now real on disk, not just masked).
    await expect
      .poll(async () => Number(await row.getAttribute('data-point-count')), { timeout: 60_000 })
      .toBe(afterErase);
  } finally {
    await close();
  }
});

// Undo: a committed (unbaked) erase can be undone, restoring the point count —
// proving the delete is a reversible mask, not a destructive rebuild.
test('undo last deletion restores the masked points', async () => {
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
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, maxPx ?? '150');

    const box = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect
      .poll(async () => Number(await panel.getAttribute('data-stamp-count')), { timeout: 5_000 })
      .toBeGreaterThan(0);

    await page.getByTestId('erase-apply').click();
    await expect
      .poll(async () => Number(await row.getAttribute('data-point-count')), { timeout: 8_000 })
      .toBeLessThan(60);

    // Undo the deletion → count returns to the full 60.
    await page.getByTestId('erase-undo-pending').click();
    await expect
      .poll(async () => Number(await row.getAttribute('data-point-count')), { timeout: 8_000 })
      .toBe(60);
  } finally {
    await close();
  }
});
