import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const FIXTURES = join(repoRoot, 'tests', 'e2e', 'fixtures');
// Two clouds with deliberately DIFFERENT Z extents — that difference is the
// whole subject. tiny.xyz is a 1.5 m cylinder; ground_plants.xyz tops out at
// ~0.80 m. Under per-cloud scales the top of the short cloud and the top of the
// tall one were both painted the gradient's max colour despite being 0.7 m
// apart in the world.
const TALL = join(FIXTURES, 'tiny.xyz');           // z 0.000 .. 1.500
const SHORT = join(FIXTURES, 'ground_plants.xyz'); // z 0.000 .. 0.798

const TALL_MAX = 1.5;
const SHORT_MAX = 0.7981;

// One consistent Z-height colour scale across every visible scan.
//
// Each cloud used to derive its own height domain from its own bounding box, so
// a scene with several scans got one independent colour scale — and one separate
// colorbar — per scan. Two failures rode on that, and this file asserts both:
//
//   1. Colour stopped meaning anything scene-wide. A point at z=0.8 sat at the
//      very top of the short cloud's ramp and only halfway up the tall one's,
//      so identical heights were painted different colours in the same viewport.
//   2. The legend fragmented. `buildLegendEntries` keys an entry's identity on
//      its domain, so N scans with N domains could not fold and the viewer drew
//      N colorbars printing N different number pairs for one variable.
//
// Both are fixed upstream of the legend, by pooling the domain across the
// visible clouds that share the mode — so the scale that is PAINTED and the
// scale that is DRAWN come from one resolver and cannot disagree. The
// assertions below therefore check the rendered legend AND the height range
// actually handed to the GPU material.

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

function rowByName(page: Page, name: string) {
  return page.locator(`[data-testid="scan-row"][data-scan-name="${name}"]`);
}

// Import both clouds and put the whole scene on Z-height colouring, through the
// real Display panel.
//
// The deselect matters: with scans selected, the mode picker performs a SCOPED
// edit (per-cloud overrides). With nothing selected it moves the scene default
// and clears overrides, which is the "colour everything by height" gesture a
// user makes — and the one that used to produce a colorbar per scan.
async function importBoth(app: ElectronApplication, page: Page) {
  await importFiles(app, page, 'import-point-cloud', [TALL, SHORT]);
  await completeImportWizard(page);
  await expect(page.locator('[data-testid="scan-row"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(rowByName(page, 'tiny')).toHaveAttribute('data-visible', 'true');
  await expect(rowByName(page, 'ground_plants')).toHaveAttribute('data-visible', 'true');

  await page.getByTitle('Deselect All').click();
  await expect(page.locator('[data-testid="scan-row"][data-selected="true"]')).toHaveCount(0);

  // The default colour mode is 'per-scan', which maps no variable and raises no
  // colorbar at all — so the mode has to be chosen before there is anything to
  // assert on.
  await page.getByRole('button', { name: 'Display' }).click();
  const colorMode = page.getByTestId('display-color-mode');
  await expect(colorMode).toBeVisible();
  await colorMode.selectOption('height');
}

// The continuous CLOUD colorbars currently on screen. 'colorbar' is the legacy
// per-family test id LegendStack still emits for a cloud's continuous entry
// (meshes and LAD grids use 'mesh-colorbar' / 'lad-colorbar'), so this counts
// exactly the thing that used to multiply per scan. Height is the default
// colour mode, so importing is enough to raise it.
function heightColorbars(page: Page) {
  return page.locator('[data-testid="colorbar"]');
}

async function colorbarDomains(page: Page): Promise<{ min: number; max: number }[]> {
  return heightColorbars(page).evaluateAll((els) =>
    els.map((el) => ({
      min: parseFloat(el.getAttribute('data-colorbar-min') ?? 'NaN'),
      max: parseFloat(el.getAttribute('data-colorbar-max') ?? 'NaN'),
    })),
  );
}

test('two scans of different heights share ONE height colorbar spanning both', async () => {
  const { app, page } = session;
  await importBoth(app, page);

  const legend = page.getByTestId('legend-stack');
  await expect(legend).toBeVisible({ timeout: 20_000 });

  // Exactly one height colorbar for the two scans — not one per scan.
  const bars = heightColorbars(page);
  await expect(bars).toHaveCount(1);

  // It is captioned as the GROUP, which is how the user can tell it describes
  // both scans rather than whichever one happened to win.
  const entry = bars.first();
  await expect(entry).toHaveAttribute('data-legend-object', '2 scans');
  await expect(entry).toHaveAttribute('data-legend-variable', /Height/i);
  // Both scan ids fold into the single entry.
  const objects = (await entry.getAttribute('data-legend-objects'))!.split(',');
  expect(objects).toHaveLength(2);

  // The domain spans the UNION: the tall cloud's max, not the short one's.
  const [domain] = await colorbarDomains(page);
  expect(domain.min).toBeCloseTo(0, 2);
  expect(domain.max).toBeCloseTo(TALL_MAX, 2);
  // Guard the specific regression: the scale must NOT have stopped at the
  // shorter cloud's own extent.
  expect(domain.max).toBeGreaterThan(SHORT_MAX + 0.5);
});

test('both clouds are PAINTED on the shared domain, not their own', async () => {
  const { app, page } = session;
  await importBoth(app, page);
  await expect(page.getByTestId('legend-stack')).toBeVisible({ timeout: 20_000 });

  // The decisive check. A legend can agree while the shaders still disagree,
  // and that combination is worse than the original bug — the colorbar would be
  // confidently describing a scale nothing is painted on. __cloudColorDomains
  // reports the exact rangeMin/rangeMax each cloud's renderer receives.
  const domains = await page.evaluate(
    () => (window as unknown as {
      __cloudColorDomains?: () => Record<string, {
        mode: string;
        painted: { min: number; max: number } | null;
        own: { min: number; max: number } | null;
        visible: boolean;
      }>;
    }).__cloudColorDomains?.() ?? {},
  );

  const painted = Object.values(domains).filter(d => d.visible && d.painted);
  expect(painted).toHaveLength(2);
  expect(painted.every(d => d.mode === 'height')).toBe(true);

  // Both clouds map through ONE identical domain...
  const distinct = new Set(
    painted.map(d => `${d.painted!.min.toFixed(4)}:${d.painted!.max.toFixed(4)}`),
  );
  expect(distinct.size).toBe(1);
  expect(painted[0].painted!.max).toBeCloseTo(TALL_MAX, 2);

  // ...and that domain is genuinely wider than the short cloud's own extent,
  // which is what proves pooling happened rather than both clouds coincidentally
  // reporting the same numbers. The own-extents must still differ — if they
  // didn't, the fixtures stopped exercising the bug.
  const ownMaxes = painted.map(d => d.own!.max).sort((a, b) => a - b);
  expect(ownMaxes[0]).toBeCloseTo(SHORT_MAX, 2);
  expect(ownMaxes[1]).toBeCloseTo(TALL_MAX, 2);
  expect(painted[0].painted!.max).toBeGreaterThan(ownMaxes[0] + 0.5);
});

test('hiding the tall scan re-tightens the shared scale, and showing it widens back', async () => {
  const { app, page } = session;
  await importBoth(app, page);
  await expect(page.getByTestId('legend-stack')).toBeVisible({ timeout: 20_000 });

  // Starts pooled across both: ONE bar, spanning to the tall cloud's max.
  await expect(heightColorbars(page)).toHaveCount(1);
  expect((await colorbarDomains(page))[0].max).toBeCloseTo(TALL_MAX, 2);

  // Hide the tall cloud through the real UI (select it, then the header's hide).
  const tall = rowByName(page, 'tiny');
  await tall.click();
  await expect(tall).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('scans-bulk-hide').click();
  await expect(tall).toHaveAttribute('data-visible', 'false');

  // The scale now describes only what is on screen — a hidden outlier must not
  // permanently squash the colours of the cloud the user is looking at.
  await expect.poll(
    async () => (await colorbarDomains(page))[0]?.max,
    { timeout: 10_000 },
  ).toBeLessThan(SHORT_MAX + 0.2);

  // One visible scan left, so the legend captions it by name, not as a group.
  await expect(heightColorbars(page)).toHaveCount(1);
  await expect(heightColorbars(page).first())
    .toHaveAttribute('data-legend-object', 'ground_plants');

  // Show it again: the pool must WIDEN back and re-merge into one grouped bar.
  // This half is what makes the test specific to pooling — a per-cloud scale
  // also shrinks when the tall cloud is hidden (it was never in the short
  // cloud's domain to begin with), so shrinking alone proves nothing. Only a
  // shared domain grows again when the tall cloud returns.
  await page.getByTestId('scans-bulk-hide').click();
  await expect(tall).toHaveAttribute('data-visible', 'true');

  await expect.poll(
    async () => (await colorbarDomains(page))[0]?.max,
    { timeout: 10_000 },
  ).toBeGreaterThan(SHORT_MAX + 0.5);
  await expect(heightColorbars(page)).toHaveCount(1);
  await expect(heightColorbars(page).first())
    .toHaveAttribute('data-legend-object', '2 scans');
});
