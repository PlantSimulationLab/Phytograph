import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// The colorbar's domain must describe the CONTENT, not the noise.
//
// A colormap stretches its domain across the full ramp, so a domain taken from
// the raw bounding box is set by the single most extreme point in the cloud.
// outlier-extent.xyz is exactly the reported shape: 208 returns in a dense plot
// spanning z 0..3 m, plus ONE stray at z=400. Coloured by height on the raw
// box, every real point falls in the bottom 0.75% of the gradient — the plot
// renders as one flat colour and the height structure the user is looking for
// is invisible, with nothing on screen to explain why.
//
// The fix takes the 1st-99th percentile instead, so the ramp spans the plot and
// the stray clamps to the top colour. These tests assert the domain actually
// handed to the GPU material, not just the number printed on the legend: a
// colorbar that agreed while the shaders disagreed would be worse than the bug,
// because it would confidently describe a scale nothing is painted on.

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'outlier-extent.xyz');

// The plot's real vertical extent, and the lone outlier far above it.
const CONTENT_MAX_Z = 3.0;
const OUTLIER_Z = 400.0;

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

async function importAndColorByHeight() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', FIXTURE);
  await completeImportWizard(page);
  await expect(
    page.locator('[data-testid="scan-row"][data-scan-name="outlier-extent"]'),
  ).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Display' }).click();
  const colorMode = page.getByTestId('display-color-mode');
  await expect(colorMode).toBeVisible();
  await colorMode.selectOption('height');
  return page;
}

// The exact rangeMin/rangeMax each cloud's renderer receives.
async function paintedDomain(page: typeof session.page) {
  const domains = await page.evaluate(
    () => (window as unknown as {
      __cloudColorDomains?: () => Record<string, {
        mode: string;
        painted: { min: number; max: number } | null;
        visible: boolean;
      }>;
    }).__cloudColorDomains?.() ?? {},
  );
  const painted = Object.values(domains).filter(d => d.visible && d.painted);
  expect(painted).toHaveLength(1);
  expect(painted[0].mode).toBe('height');
  return painted[0].painted!;
}

test('the height colorbar spans the content, not the lone 400 m outlier', async () => {
  const page = await importAndColorByHeight();

  const colorbar = page.getByTestId('colorbar');
  await expect(colorbar).toBeVisible({ timeout: 20_000 });
  const cbMax = parseFloat((await colorbar.getAttribute('data-colorbar-max')) ?? 'NaN');

  // The decisive number. Raw-bounds behaviour puts this at 400.
  expect(cbMax).toBeLessThan(10);
  expect(cbMax).toBeGreaterThan(2.0);
  expect(cbMax).toBeCloseTo(CONTENT_MAX_Z, 1);

  // And the shaders are on the same scale the legend advertises.
  const painted = await paintedDomain(page);
  expect(painted.max).toBeCloseTo(cbMax, 4);
});

test('the painted domain gives the real data almost the whole ramp', async () => {
  const page = await importAndColorByHeight();
  await expect(page.getByTestId('colorbar')).toBeVisible({ timeout: 20_000 });

  const { min, max } = await paintedDomain(page);
  const span = max - min;

  // The property the user actually cares about, stated as resolution: on the
  // raw box the plot occupied span/OUTLIER_Z ≈ 0.75% of the gradient. It must
  // now occupy essentially all of it.
  const fractionOfRampUsedByContent = CONTENT_MAX_Z / span;
  expect(fractionOfRampUsedByContent).toBeGreaterThan(0.9);
  // Stated the other way: the domain is dramatically narrower than the raw box.
  expect(span).toBeLessThan(0.1 * OUTLIER_Z);
});

test('the robust domain SURVIVES an edit', async () => {
  // The regression a code review caught before this shipped. Both robust values
  // were emitted by the session-create endpoint alone; every edit rebuilds the
  // octree through `_session_rebuild`, whose metadata carried neither, and the
  // renderer's rebuild path reads them straight off that metadata. So the first
  // crop/filter/bake dropped them and every colorbar silently fell back to raw
  // extrema — the feature worked until the user touched anything.
  //
  // Driven through the real filter tool rather than the helper, because the
  // helper was never the broken part: the wiring was. A backend test that called
  // the helper directly passed with the wiring deleted.
  const page = await importAndColorByHeight();
  await expect(page.getByTestId('colorbar')).toBeVisible({ timeout: 20_000 });
  const before = (await paintedDomain(page)).max;
  expect(before).toBeLessThan(10);

  // Trim a thin slice off the X edge — an edit that rebuilds the octree while
  // keeping the cloud large and keeping the outlier in it.
  //
  // The dimensioning matters and is the trap this test fell into first. A 1st-99th
  // percentile can only reject a tail thinner than 1% of the cloud, so an edit
  // that shrinks 209 points to 57 makes the lone outlier 1.75% of the data and
  // p99 legitimately climbs to 177.68 — correct behaviour, but it looks exactly
  // like the regression and would make this test assert a falsehood. Keep the
  // survivor count high so the percentile still has the outlier outnumbered.
  //
  // The filter operates on the selection. `importAndColorByHeight` deselects
  // (choosing the colour mode with nothing selected is the "colour everything"
  // gesture), so select the row here — and only if it isn't already selected,
  // since clicking the sole selection toggles it OFF.
  const row = page.locator('[data-testid="scan-row"][data-scan-name="outlier-extent"]');
  if ((await row.getAttribute('data-selected')) !== 'true') {
    await row.click();
  }
  await expect(row).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('tool-filter').click();
  const fieldSelect = page.getByTestId('filter-field-select');
  await expect(fieldSelect).toBeVisible();
  await fieldSelect.selectOption('x');
  await page.getByTestId('filter-min-input').fill('0.05');
  await page.getByTestId('filter-max-input').fill('100');
  await page.getByTestId('filter-remove').click();

  // Wait for the REBUILD to land before reading anything.
  //
  // This must not be an `expect(...).toPass()` around the domain assertion.
  // `toPass` retries until it succeeds, and the domain still holds its correct
  // PRE-edit value for a moment after the click — so the first poll passes on
  // the stale number and the test never observes the rebuild at all. Verified:
  // with the backend wiring deleted, a toPass version of this test passed while
  // the domain really did go 3 -> 400. Gate on the point count (the edit's own
  // observable effect) instead, then assert exactly once.
  await expect(async () => {
    const n = parseInt((await row.getAttribute('data-point-count')) ?? '0', 10);
    // 195 of the fixture's 209 survive x >= 0.05 — an exact count, so this
    // cannot settle on a half-applied intermediate state.
    expect(n).toBe(195);
  }).toPass({ timeout: 30_000 });
  // The octree swap trails the count by a frame or two; let it settle so the
  // domain read below describes the rebuilt cloud rather than the outgoing one.
  await page.waitForTimeout(3_000);

  const after = (await paintedDomain(page)).max;
  // Raw-extrema fallback puts this at 400 — that is the regression, measured.
  expect(after, `domain reverted to raw extrema after the edit (was ${before})`)
    .toBeLessThan(10);
});

test('the manual range override still wins over the robust default', async () => {
  // Robust is the DEFAULT, not a cage: a user who wants the full extent (or any
  // other window) types it and gets it, and Reset returns to the robust range.
  const page = await importAndColorByHeight();
  await expect(page.getByTestId('colorbar')).toBeVisible({ timeout: 20_000 });

  const robustMax = (await paintedDomain(page)).max;
  expect(robustMax).toBeLessThan(10);

  const maxInput = page.getByTestId('display-range-max');
  await expect(maxInput).toBeVisible();
  await maxInput.fill(String(OUTLIER_Z));
  await maxInput.blur();

  await expect
    .poll(async () => (await paintedDomain(page)).max, { timeout: 10_000 })
    .toBeCloseTo(OUTLIER_Z, 1);

  // Reset restores the robust default rather than the raw extent.
  await page.getByTitle('Reset to data range').click();
  await expect
    .poll(async () => (await paintedDomain(page)).max, { timeout: 10_000 })
    .toBeCloseTo(robustMax, 4);
});
