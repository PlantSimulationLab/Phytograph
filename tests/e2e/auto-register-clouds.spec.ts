import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// Auto-Register drives the coarse global registration path end-to-end through
// the real UI and the live backend.
//
// The fixtures are a GROUND-TRUTH pair: `orchard-row-rotated.xyz` is
// `orchard-row.xyz` rotated 90° about Z and shifted by (2, -1.5, 0). So a
// correct registration has a known right answer, and "did it move?" can be
// checked against where the cloud is supposed to land rather than against a
// vague "something happened".
//
// The 90° angle is load-bearing. An earlier version of these fixtures used 25°,
// and the tests passed even with the coarse global search stubbed out to return
// identity — because plain ICP handles 25° on this data by itself, so the
// refinement stage silently repaired the sabotaged result. At 90° plain ICP
// fails hard (~90° residual) while the coarse stage recovers the pose exactly,
// so these tests can only pass if global registration actually works. Verified
// both ways against a deliberately broken backend.
//
// The scene is deliberately the hard one: nine near-identical plants on a
// regular 4 m lattice. A registration that grabs the wrong plant lands a whole
// spacing off while still looking plausible, so the assertions below check the
// cloud's actual extent, not just that a success toast appeared.
const ORCHARD = join(repoRoot, 'tests', 'e2e', 'fixtures', 'orchard-row.xyz');
const ORCHARD_ROTATED = join(repoRoot, 'tests', 'e2e', 'fixtures', 'orchard-row-rotated.xyz');

let session: LaunchedApp;
test.beforeAll(async () => { session = await launchApp(); });
test.afterAll(async () => { await session?.close(); });
test.beforeEach(async () => { await resetToFreshScene(session.app, session.page); });

// Registration tools are palette/menu-only, dispatched through the same bridge
// the native Tools menu uses. Dispatching also proves the command is available.
async function runTool(page: typeof session.page, id: string) {
  await page.evaluate((toolId) => {
    const run = (window as unknown as { __runToolCommand?: (id: string) => void }).__runToolCommand;
    if (!run) throw new Error('__runToolCommand bridge not available');
    run(toolId);
  }, id);
}

async function importBoth(page: typeof session.page) {
  await importFiles(session.app, page, 'import-auto', ORCHARD);
  await completeImportWizard(page);
  await importFiles(session.app, page, 'import-auto', ORCHARD_ROTATED);
  await completeImportWizard(page);
  const rows = page.locator('[data-testid="scan-row"]');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  return rows;
}

/** World-frame bounds of a scan, read off the rendered row's data attribute. */
async function scanBounds(page: typeof session.page, scanId: string) {
  const row = page.locator(`[data-testid="scan-row"][data-scan-id="${scanId}"]`);
  const raw = await row.getAttribute('data-scan-bounds');
  if (!raw) return null;
  const n = raw.split(',').map(Number);
  return { min: [n[0], n[1], n[2]], max: [n[3], n[4], n[5]] };
}

/** Run Auto-Register with target = row `t`, source = row `s`. */
async function autoRegister(
  page: typeof session.page,
  t: number,
  s: number,
  method?: 'crown' | 'trunk' | 'chm',
  sceneType?: 'agriculture' | 'natural' | 'urban',
) {
  await runTool(page, 'cloud-auto-register');
  const dialog = page.getByTestId('auto-register-dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByTestId('auto-register-target-picker').getByTestId('picker-row').nth(t).click();
  await dialog.getByTestId('auto-register-source-picker').getByTestId('picker-row').nth(s).click();
  if (sceneType) await dialog.getByTestId('auto-register-scene').selectOption(sceneType);
  if (method) {
    // The per-plant "match on" control only applies to the landmark estimator;
    // the default (canopy-pattern correlation) does not use landmarks at all.
    await dialog.getByTestId('auto-register-estimator').selectOption('ransac_fpfh');
    await dialog.getByTestId('auto-register-method').selectOption(method);
  }

  await dialog.getByTestId('auto-register-run').click();
  await expect(dialog).toBeHidden();
}

test('Auto-Register recovers a known rotation between two orchard scans', async () => {
  const { page } = session;
  const rows = await importBoth(page);

  const targetId = await rows.nth(0).getAttribute('data-scan-id');
  const sourceId = await rows.nth(1).getAttribute('data-scan-id');
  const targetBefore = await scanBounds(page, targetId!);
  const sourceBefore = await scanBounds(page, sourceId!);
  expect(targetBefore, 'scene debug bounds unavailable').not.toBeNull();

  // The rotated copy starts visibly displaced from the original — the thing
  // registration has to undo.
  const startGap = Math.abs(sourceBefore!.min[0] - targetBefore!.min[0]);
  expect(startGap).toBeGreaterThan(0.5);

  await autoRegister(page, 0, 1, 'crown');

  const toast = page.locator('[data-testid="toast-success"], [data-testid="toast-warning"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText(/Auto-Register/i, { timeout: 120_000 });

  // The real check: the moved cloud now occupies the same space as the target.
  // A wrong-plant match would leave a ~4 m (one plant spacing) discrepancy, so
  // this tolerance separates "registered" from "plausibly registered".
  // Polled, because the row's bounds attribute re-renders after the toast.
  await expect.poll(async () => {
    const s = await scanBounds(page, sourceId!);
    const t = await scanBounds(page, targetId!);
    if (!s || !t) return Number.POSITIVE_INFINITY;
    return Math.max(...[0, 1, 2].flatMap(a => [
      Math.abs(s.min[a] - t.min[a]),
      Math.abs(s.max[a] - t.max[a]),
    ]));
  }, {
    message: 'registered cloud should share the target\'s extent (a one-plant-off '
      + 'match would leave a ~4 m gap)',
    timeout: 30_000,
  }).toBeLessThan(1.0);
});

test('Auto-Register works with the trunk-bases method on octree-backed clouds', async () => {
  const { page } = session;
  const rows = await importBoth(page);
  // Imported clouds are octree/streamed — the source is moved by transforming
  // its backend session and rebuilding the octree, not by editing an in-RAM
  // array, so this covers the other half of the apply path.
  await expect(rows.nth(0)).toHaveAttribute('data-octree', 'true');
  await expect(rows.nth(1)).toHaveAttribute('data-octree', 'true');

  const sourceId = await rows.nth(1).getAttribute('data-scan-id');
  const targetId = await rows.nth(0).getAttribute('data-scan-id');
  const pointCountBefore = await rows.nth(1).getAttribute('data-point-count');

  await autoRegister(page, 0, 1, 'trunk');

  const toast = page.locator('[data-testid="toast-success"], [data-testid="toast-warning"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText(/Auto-Register/i, { timeout: 120_000 });

  // The cloud survived the session transform + octree rebuild intact...
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute('data-octree', 'true');
  await expect(rows.nth(1)).toHaveAttribute('data-point-count', pointCountBefore!);
  // ...and actually landed on the target.
  await expect.poll(async () => {
    const s = await scanBounds(page, sourceId!);
    const t = await scanBounds(page, targetId!);
    if (!s || !t) return Number.POSITIVE_INFINITY;
    return Math.max(Math.abs(s.min[0] - t.min[0]), Math.abs(s.max[1] - t.max[1]));
  }, { message: 'octree source should land on the target', timeout: 30_000 })
    .toBeLessThan(1.0);
});

test('Auto-Register dialog offers every anchor method and defaults to crowns', async () => {
  const { page } = session;
  await importBoth(page);

  await runTool(page, 'cloud-auto-register');
  const dialog = page.getByTestId('auto-register-dialog');
  await expect(dialog).toBeVisible();

  // The default matches the overall canopy pattern rather than individual
  // plants, so the per-plant control is not shown until that path is chosen.
  await expect(dialog.getByTestId('auto-register-estimator')).toHaveValue('correlation');
  await expect(dialog.getByTestId('auto-register-method')).toHaveCount(0);

  // Switching to landmark matching reveals all three extractors — they exist
  // because no single anchor works on every acquisition.
  await dialog.getByTestId('auto-register-estimator').selectOption('ransac_fpfh');
  const method = dialog.getByTestId('auto-register-method');
  await expect(method).toHaveValue('crown');
  await expect(method.locator('option')).toHaveCount(3);

  // Run stays disabled until both clouds are chosen, so the tool can't be
  // fired with an incomplete setup.
  const run = dialog.getByTestId('auto-register-run');
  await expect(run).toBeDisabled();
  await dialog.getByTestId('auto-register-target-picker').getByTestId('picker-row').nth(0).click();
  await expect(run).toBeDisabled();
  await dialog.getByTestId('auto-register-source-picker').getByTestId('picker-row').nth(1).click();
  await expect(run).toBeEnabled();
});

test('Scene type drives the method, and built-site hides the plant options', async () => {
  const { page } = session;
  await importBoth(page);

  await runTool(page, 'cloud-auto-register');
  const dialog = page.getByTestId('auto-register-dialog');
  await expect(dialog).toBeVisible();

  // Vegetated scenes are matched plant by plant, so the landmark choice applies.
  const scene = dialog.getByTestId('auto-register-scene');
  await expect(scene).toHaveValue('agriculture');
  await expect(scene.locator('option')).toHaveCount(3);

  // The per-plant control needs BOTH a vegetated scene and the landmark
  // estimator; the default correlation path does not use landmarks.
  await dialog.getByTestId('auto-register-estimator').selectOption('ransac_fpfh');
  await expect(dialog.getByTestId('auto-register-method')).toBeVisible();

  // A built site is matched on surface shape — no per-plant landmark exists,
  // so the control is hidden rather than shown disabled.
  await scene.selectOption('urban');
  await expect(dialog.getByTestId('auto-register-method')).toHaveCount(0);

  await scene.selectOption('natural');
  await expect(dialog.getByTestId('auto-register-method')).toBeVisible();
});

test('Choosing the wrong scene type prompts instead of registering', async () => {
  const { page } = session;
  await importBoth(page);

  // These fixtures are a planting. Asking for a built site is a strong enough
  // disagreement to change the algorithm, so it must stop and ask rather than
  // quietly running the wrong method — and it must ask BEFORE the slow stage.
  await autoRegister(page, 0, 1, undefined, 'urban');

  const prompt = page.getByTestId('scene-mismatch-dialog');
  await expect(prompt).toBeVisible({ timeout: 60_000 });

  // The user's choice always wins: keeping it re-runs with what they picked.
  // Switching runs the suggested one. Either way it is their decision.
  await expect(prompt.getByTestId('scene-mismatch-keep')).toBeVisible();
  await prompt.getByTestId('scene-mismatch-switch').click();
  await expect(prompt).toBeHidden();

  const toast = page.locator('[data-testid="toast-success"], [data-testid="toast-warning"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText(/Auto-Register/i, { timeout: 120_000 });
});
