import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { dismissToasts } from './helpers/canvasClick';
import { resetToFreshScene } from './helpers/resetApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'multi_tree.xyz');

// TreeIso trunk seeding drives the same kind of z-10 click overlay as the crop
// lasso, and inherited the same trap: the floating panels paint above it, so
// clicks in the right-hand strip go to the panels and no seed appears — with
// nothing on screen saying why.
//
// Same remedy as the crop tools (panels stay clickable; the dead area is made
// explicit): a ⊘ at the clamped cursor while the pointer is on a panel, plus
// panel copy that says so. The blockers are measured, never painted over.
//
// Shared session: one app + backend for the whole file; File → New resets the
// scene between tests (see helpers/resetApp.ts).

/**
 * The measured blocker rects, in viewer-local px, read from `data-zone-rects`.
 * Nothing paints them, so this attribute is the only view onto the geometry the
 * clamping actually uses.
 */
async function readZoneRects(zone: ReturnType<Page['getByTestId']>) {
  const raw = await zone.getAttribute('data-zone-rects');
  if (!raw) throw new Error('blocked zone exposed no data-zone-rects');
  return (JSON.parse(raw) as [number, number, number, number][])
    .map(([x, y, w, h]) => ({ x, y, w, h }));
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

async function startSeeding(session: LaunchedApp) {
  const { app, page } = session;
  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="multi_tree.xyz"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-tree-segment').click();
  const panel = page.getByTestId('tree-segment-panel');
  await expect(panel).toBeVisible();

  // No zone before seeding starts — it's tied to the tool, not the panel.
  await expect(page.getByTestId('tree-seed-blocked-zone')).toHaveCount(0);

  await page.getByTestId('tree-seed-mode').check();
  await expect(page.getByTestId('tree-seed-overlay')).toBeVisible();
  return { row, panel };
}

test('seeding marks the panels that swallow seed clicks, and drops the mode cleanly', async () => {
  const { page } = session;
  const { panel } = await startSeeding(session);

  const zone = page.getByTestId('tree-seed-blocked-zone');
  await expect(zone).toBeVisible();
  await expect(zone).toHaveCSS('pointer-events', 'none');
  await expect(page.getByTestId('tree-seed-blocked-hint')).toBeVisible();

  // The blocked rects must land on real panels: the scans panel (in the
  // right-hand stack) and the Tree Segmentation panel itself both cover the
  // viewport. Only the panels count — not the full-height stack around them.
  const zoneBox = await zone.boundingBox();
  const scansBox = await page.getByTestId('scans-panel').boundingBox();
  const panelBox = await panel.boundingBox();
  if (!zoneBox || !scansBox || !panelBox) throw new Error('missing bounding boxes');

  const rects = await readZoneRects(zone);
  const covered = (b: { x: number; y: number; width: number; height: number }) => {
    const x = b.x - zoneBox.x;
    const y = b.y - zoneBox.y;
    return rects.some(r =>
      x >= r.x - 1 && y >= r.y - 1 &&
      x + b.width <= r.x + r.w + 1 && y + b.height <= r.y + r.h + 1);
  };
  expect(covered(scansBox)).toBe(true);
  expect(covered(panelBox)).toBe(true);

  // Turning seeding off retires the zone (and the overlay) — it's transient.
  await page.getByTestId('tree-seed-mode').uncheck();
  await expect(page.getByTestId('tree-seed-overlay')).toHaveCount(0);
  await expect(zone).toHaveCount(0);
});

/**
 * Assert a point is owned by the seeding overlay itself.
 *
 * The generic expectPointsHitCanvas guard doesn't apply here: while seeding,
 * the overlay legitimately sits ON TOP of the canvas and is the click target.
 * What must NOT be there is a toast or a panel. Clears toasts first, then
 * checks the topmost element is the overlay (or a child of it).
 */
async function expectPointOwnedBySeedOverlay(
  page: LaunchedApp['page'],
  point: { x: number; y: number },
): Promise<void> {
  await dismissToasts(page);
  const owner = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(Math.round(x), Math.round(y)) as HTMLElement | null;
    if (!el) return 'null';
    const overlay = el.closest('[data-testid="tree-seed-overlay"]');
    return overlay ? 'tree-seed-overlay' : (el.dataset.testid || el.tagName.toLowerCase());
  }, point);
  expect(
    owner,
    `expected the seeding overlay to own (${Math.round(point.x)},${Math.round(point.y)}), ` +
    `but the topmost element was "${owner}" — the click would not place a seed`,
  ).toBe('tree-seed-overlay');
}

test('the seeding overlay never swallows the panel it is driven from', async () => {
  const { page } = session;
  const { panel } = await startSeeding(session);

  // The seed overlay covers the whole pane, so the Tree Segmentation panel must
  // out-rank it — otherwise the checkbox that turns seeding on can't turn it
  // off, and "Clear seeds" is unreachable while seeding.
  await page.getByTestId('tree-seed-count').waitFor();
  await expect(panel.getByTestId('tree-seed-count')).toHaveText('0 seeds');

  // Place a seed in open viewport, then use a panel control mid-seeding.
  const overlay = page.getByTestId('tree-seed-overlay');
  const box = await overlay.boundingBox();
  if (!box) throw new Error('tree-seed-overlay has no bounding box');
  const seedAt = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.55 };
  // Unlike most viewport specs this one clicks the seeding OVERLAY, which is
  // meant to be topmost — so the guard is that the overlay (not a toast, and
  // not a panel) owns the pixel. A toast is full-height and reaches here.
  await expectPointOwnedBySeedOverlay(page, seedAt);
  await page.mouse.click(seedAt.x, seedAt.y);
  await expect(panel.getByTestId('tree-seed-count')).toHaveText('1 seed');

  await panel.getByText('Clear seeds').click();
  await expect(panel.getByTestId('tree-seed-count')).toHaveText('0 seeds');
});

test('cursor over a panel is marked refused and the click places no seed', async () => {
  const { page } = session;
  const { panel } = await startSeeding(session);

  const zone = page.getByTestId('tree-seed-blocked-zone');
  const overlay = page.getByTestId('tree-seed-overlay');
  const box = await overlay.boundingBox();
  if (!box) throw new Error('tree-seed-overlay has no bounding box');

  // A seed in reachable viewport registers — the baseline. Guarded, because if
  // a toast were sitting here the baseline would fail and read as a seeding
  // regression rather than an occluded click.
  const seedAt = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.55 };
  await expectPointOwnedBySeedOverlay(page, seedAt);
  await page.mouse.click(seedAt.x, seedAt.y);
  await expect(panel.getByTestId('tree-seed-count')).toHaveText('1 seed');
  await expect(zone).toHaveAttribute('data-cursor-blocked', 'false');

  // Now aim at a trunk hidden behind the Tree Segmentation panel itself — its
  // bottom-left corner, which is panel surface with no control on it, so the
  // only thing this click could change is the seed count. (The empty tail of the
  // right-hand stack is NOT usable here: that space is click-through now, which
  // is exactly the fix.)
  const rects = await readZoneRects(zone);
  const panelBox = await panel.boundingBox();
  if (!panelBox) throw new Error('tree-segment-panel has no bounding box');
  const inPanel = { x: panelBox.x + 8, y: panelBox.y + panelBox.height - 8 };
  const local = { x: inPanel.x - box.x, y: inPanel.y - box.y };
  await page.mouse.move(inPanel.x, inPanel.y);
  await expect(zone).toHaveAttribute('data-cursor-blocked', 'true');

  // The ⊘ marker is drawn at the clamped point, outside every blocked rect —
  // the visible answer to "why is nothing happening here?".
  const marker = await zone.locator('circle').first().evaluate(el => ({
    x: Number(el.getAttribute('cx')), y: Number(el.getAttribute('cy')),
  }));
  const inside = (p: { x: number; y: number }) => rects.some(
    r => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h);
  expect(inside(local)).toBe(true);
  expect(inside(marker)).toBe(false);

  // Clicking there adds no seed — unchanged behavior, now explained.
  await page.mouse.click(inPanel.x, inPanel.y);
  await expect(panel.getByTestId('tree-seed-count')).toHaveText('1 seed');

  // Back over open viewport the cursor reads normal again.
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await expect(zone).toHaveAttribute('data-cursor-blocked', 'false');
});
