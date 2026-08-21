import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'scalars.xyz');

// The colorbar / class legend is a PASSIVE readout that must never outrank an
// interactive tool panel.
//
// Its expanded cards are `pointer-events-auto` (clicking one opens the colormap
// editor), they anchor bottom-right, and they grow upward and leftward as
// entries are added — into the `right-[280px]` lane every tool panel occupies.
// The legend used to sit at z-20, the same tier as those panels, so the tie was
// broken by DOM order and the legend (rendered last) won: it swallowed clicks
// meant for the panel underneath.
//
// That shipped as a real bug and showed up as a CI-only test failure —
// generate-dem-cancel timed out clicking Run with "scalar-overlay subtree
// intercepts pointer events", while passing locally where the legend happened
// to be narrow enough that only the button's right edge was covered and the
// centre click landed clear. The fix puts the legend at z-[15], below the
// panels; this spec pins that ordering.
test('a legend card cannot swallow a tool panel button', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);
    await expect(page.locator('[data-testid="scan-row"]').first()).toBeVisible({ timeout: 20_000 });

    // Colour by a scalar so the continuous colorbar actually renders.
    await page.getByRole('button', { name: 'Display' }).click();
    await page.getByTestId('display-color-mode').selectOption('scalar:timestamp');
    await expect(page.getByTestId('legend-stack')).toBeVisible({ timeout: 10_000 });

    // Toasts are a separate full-height blocker; clear them so this spec is
    // measuring the legend and nothing else.
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('[data-testid="toast-close"]')
        .forEach((b) => b.click());
    });

    await page.getByTestId('tool-dem').click();
    await expect(page.getByTestId('dem-panel')).toBeVisible();

    // Park the real legend card squarely over the Run button's centre. On CI a
    // taller legend does this on its own; forcing it makes the ordering
    // assertion deterministic on every machine instead of depending on how many
    // entries the scene happens to produce.
    const moved = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="dem-run-button"]') as HTMLElement | null;
      const card = document.querySelector('[data-legend-key]') as HTMLElement | null;
      const overlay = document.querySelector('[data-testid="scalar-overlay"]') as HTMLElement | null;
      if (!btn || !card || !overlay) return false;
      const b = btn.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      overlay.style.transform =
        `translate(${Math.round(b.left + b.width / 2 - (c.left + c.width / 2))}px, ` +
        `${Math.round(b.top + b.height / 2 - (c.top + c.height / 2))}px)`;
      return true;
    });
    expect(moved, 'expected a legend card and the DEM run button to be present').toBe(true);

    // The legend now geometrically covers the button. Stacking order — not
    // geometry — must decide who gets the click.
    const [covered, topmost] = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="dem-run-button"]') as HTMLElement;
      const card = document.querySelector('[data-legend-key]') as HTMLElement;
      const b = btn.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const cx = Math.round(b.left + b.width / 2);
      const cy = Math.round(b.top + b.height / 2);
      const overlaps = c.left <= cx && c.right >= cx && c.top <= cy && c.bottom >= cy;
      const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
      return [overlaps, el?.dataset.testid ?? el?.tagName ?? 'null'] as const;
    });
    expect(covered, 'the legend card should be sitting over the button centre').toBe(true);
    expect(topmost, 'the panel button must win the hit test, not the legend').toBe('dem-run-button');

    // And the click must actually reach it: with the legend at the panels' own
    // z-20 this threw "scalar-overlay subtree intercepts pointer events".
    await page.getByTestId('dem-run-button').click({ timeout: 10_000 });
    await expect(page.getByTestId('dem-cancel-button')).toBeVisible({ timeout: 30_000 });
  } finally {
    await close();
  }
});
