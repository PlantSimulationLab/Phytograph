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
// A built scene, to prove the vegetation assumption is DETECTED and correctable
// rather than declared. Turned 90 deg — far outside the +/-30 deg window a
// scanner-heading prior would restrict the search to.
//
// The quarter turn is about the centre of a SQUARE ground patch, and that is
// load-bearing for the assertion below rather than incidental. `data-scan-bounds`
// on a registered streamed cloud reports the octree's BOUNDING BOX pushed
// through the stored pose, not the true extent of the points: registration
// deliberately does not reindex the octree (a rotation re-buckets every node),
// so the cloud is drawn through a pose until a crop/erase/label forces a
// rebuild. Re-bounding a rotated box inflates it — an earlier version of this
// fixture turned 35 deg and read 18.6 m "off" while the returned matrix was
// exactly right to 10 decimal places. A quarter turn of a square footprint
// leaves the box invariant, so the comparison measures registration rather than
// that artefact. orchard-row-rotated.xyz gets away with the same thing for the
// same reason; this note is here so the next fixture does not have to
// rediscover it.
const BUILT = join(repoRoot, 'tests', 'e2e', 'fixtures', 'built-site.xyz');
const BUILT_ROTATED = join(repoRoot, 'tests', 'e2e', 'fixtures', 'built-site-rotated.xyz');

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

/** Run Auto-Register with target = row `t`, source = row `s`.
 *
 *  Takes no options because the dialog offers none: every setting it used to
 *  expose either did nothing on the path that runs or made the result worse.
 *  That makes these tests exercise exactly what a user gets by default, which
 *  is the point — the previous version of this helper switched the estimator
 *  away from the default to reach a per-plant control, and that is precisely
 *  how a broken default survived here for weeks. */
async function autoRegister(page: typeof session.page, t: number, s: number) {
  await runTool(page, 'cloud-auto-register');
  const dialog = page.getByTestId('auto-register-dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByTestId('auto-register-target-picker').getByTestId('picker-row').nth(t).click();
  await dialog.getByTestId('auto-register-source-picker').getByTestId('picker-row').nth(s).click();

  await dialog.getByTestId('auto-register-run').click();
  await expect(dialog).toBeHidden();
}

// This is the regression test for the shipped default, and it earns that title
// with a number. The dialog used to tick "Use the scanner heading" by default
// and send a yaw prior of 0 regardless of whether the scans had recorded a pose
// — which these plain-XYZ fixtures have not. That prior clamps the coarse yaw
// sweep to +/-30 degrees, so the true 90-degree answer sat outside the search
// space: measured on exactly these two files, 89.93 degrees and 4.13 m wrong,
// returned with `confident: true`. With the prior correctly withheld the same
// pair registers to 0.00 degrees / 0.00 m.
//
// It went unnoticed because the old version of this test reached for a per-plant
// control, and doing so switched the estimator OFF the default and onto the
// landmark path, where the yaw prior is never read. A test that configures its
// way around the defaults cannot see a broken default.
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

  await autoRegister(page, 0, 1);

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

test('Auto-Register works on octree-backed (streamed) clouds', async () => {
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

  await autoRegister(page, 0, 1);

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

test('Auto-Register says whether the scans can validate each other', async () => {
  const { page } = session;
  await importBoth(page);

  await runTool(page, 'cloud-auto-register');
  const dialog = page.getByTestId('auto-register-dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByTestId('auto-register-target-picker').getByTestId('picker-row').nth(0).click();
  await dialog.getByTestId('auto-register-source-picker').getByTestId('picker-row').nth(1).click();

  // Two scans cannot cross-check each other: on a repetitive planting a wrong
  // alignment fits BETTER than the right one, and no measurement on a single
  // pair can tell them apart. The dialog has to say so rather than imply the
  // result was verified.
  const note = dialog.getByTestId('auto-register-validation-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText(/nothing to cross-check/i);
});

test('the dialog offers no setting that does not change the result', async () => {
  const { page } = session;
  await importBoth(page);

  await runTool(page, 'cloud-auto-register');
  const dialog = page.getByTestId('auto-register-dialog');
  await expect(dialog).toBeVisible();

  // Scene type, search method, match-on and detail size are all GONE, and this
  // asserts their absence rather than their behaviour on purpose. Each was
  // measured to be inert on the path that actually runs: the backend consults
  // the estimator and the anchor method only in its anchors-failed fallback,
  // and `natural` and `agriculture` are literally the same branch. A control
  // that cannot change the answer is worse than no control, because a user who
  // gets a bad result will spend their time on it.
  for (const dead of ['auto-register-scene', 'auto-register-estimator',
                      'auto-register-method', 'auto-register-voxel']) {
    await expect(dialog.getByTestId(dead), `${dead} should no longer exist`).toHaveCount(0);
  }

  // Run stays disabled until both clouds are chosen, so the tool can't be
  // fired with an incomplete setup.
  const run = dialog.getByTestId('auto-register-run');
  await expect(run).toBeDisabled();
  await dialog.getByTestId('auto-register-target-picker').getByTestId('picker-row').nth(0).click();
  await expect(run).toBeDisabled();
  await dialog.getByTestId('auto-register-source-picker').getByTestId('picker-row').nth(1).click();
  await expect(run).toBeEnabled();
});

test('the scanner-heading option is refused to scans that recorded no pose', async () => {
  const { page } = session;
  await importBoth(page);

  await runTool(page, 'cloud-auto-register');
  const dialog = page.getByTestId('auto-register-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('auto-register-target-picker').getByTestId('picker-row').nth(0).click();
  await dialog.getByTestId('auto-register-source-picker').getByTestId('picker-row').nth(1).click();

  // These fixtures are plain XYZ — no scanner position, so no heading. The
  // prior asserts "these clouds already sit in a common frame and differ by ~0
  // degrees of heading", which clamps the yaw sweep to +/-30 degrees. Asserting
  // that of data which never recorded a pose puts the correct answer OUTSIDE
  // the search space, and the result still comes back marked confident:
  // measured on this very fixture pair, 89.93 degrees and 4.13 m wrong. The
  // box being ticked-by-default with no check for a pose is what shipped, so
  // this test pins the gate rather than the checkbox's mere existence.
  const heading = dialog.getByTestId('auto-register-use-heading');
  await expect(heading).toBeDisabled();
  await expect(heading).not.toBeChecked();
  await expect(dialog.getByText(/did not record a scanner position/i)).toBeVisible();
});

test('a built scene is detected and offered surface matching', async () => {
  const { page } = session;
  // Four buildings, not plants. Nothing in the dialog declares that any more —
  // the scene type used to be a dropdown the user had to get right up front,
  // and is now measured from the geometry in ~0.05 s and confirmed.
  await importFiles(session.app, page, 'import-auto', BUILT);
  await completeImportWizard(page);
  await importFiles(session.app, page, 'import-auto', BUILT_ROTATED);
  await completeImportWizard(page);
  const rows = page.locator('[data-testid="scan-row"]');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });

  const targetId = await rows.nth(0).getAttribute('data-scan-id');
  const sourceId = await rows.nth(1).getAttribute('data-scan-id');

  await autoRegister(page, 0, 1);

  // It must stop and ask BEFORE the expensive stage rather than spending a
  // minute of segmentation looking for plants that do not exist.
  const prompt = page.getByTestId('scene-mismatch-dialog');
  await expect(prompt).toBeVisible({ timeout: 60_000 });
  await expect(prompt.getByTestId('scene-mismatch-keep')).toBeVisible();
  await prompt.getByTestId('scene-mismatch-switch').click();
  await expect(prompt).toBeHidden();

  const toast = page.locator('[data-testid="toast-success"], [data-testid="toast-warning"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText(/Auto-Register/i, { timeout: 120_000 });

  // Surface matching has to actually land it. The pair is 90 deg apart —
  // deliberately past the +/-30 deg a heading prior would have clamped the
  // search to, so this also fails if the prior ever comes back ungated.
  await expect.poll(async () => {
    const sb = await scanBounds(page, sourceId!);
    const tb = await scanBounds(page, targetId!);
    if (!sb || !tb) return Number.POSITIVE_INFINITY;
    return Math.max(...[0, 1, 2].flatMap(a => [
      Math.abs(sb.min[a] - tb.min[a]),
      Math.abs(sb.max[a] - tb.max[a]),
    ]));
  }, {
    message: 'the built scene should land on its target',
    timeout: 30_000,
  }).toBeLessThan(1.0);
});

// ── Registration provenance: the panel badge and Reset Registration ─────────
//
// Auto-Register BAKES its matrix into the geometry, so once the toast fades
// there is nothing about the resulting cloud that says it was ever moved. The
// badge is the only surviving record, and it is what Reset Registration reads
// to put the cloud back — which makes "the badge appeared" and "the reset
// worked" the same guarantee tested from two ends.

test('a registered scan is badged in the panel, and only the scan that moved', async () => {
  const { page } = session;
  const rows = await importBoth(page);

  const targetId = await rows.nth(0).getAttribute('data-scan-id');
  const sourceId = await rows.nth(1).getAttribute('data-scan-id');

  // Nothing is registered on import — otherwise the assertion after the run
  // would pass on a badge that was always there.
  await expect(rows.nth(0)).toHaveAttribute('data-registered', 'false');
  await expect(rows.nth(1)).toHaveAttribute('data-registered', 'false');

  await autoRegister(page, 0, 1);
  const toast = page.locator('[data-testid="toast-success"], [data-testid="toast-warning"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText(/Auto-Register/i, { timeout: 120_000 });

  const sourceRow = page.locator(`[data-testid="scan-row"][data-scan-id="${sourceId}"]`);
  const targetRow = page.locator(`[data-testid="scan-row"][data-scan-id="${targetId}"]`);

  // The SOURCE moved, so it carries the record...
  await expect(sourceRow).toHaveAttribute('data-registered', 'true', { timeout: 30_000 });
  const badge = sourceRow.getByTestId('scan-row-registered');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-registration-target', targetId!);
  await expect(badge).toHaveAttribute('data-registration-passes', '1');

  // ...and the TARGET did not move, so it must not be badged. A badge on both
  // would mean the record was being written against the wrong scan.
  await expect(targetRow).toHaveAttribute('data-registered', 'false');
  await expect(targetRow.getByTestId('scan-row-registered')).toHaveCount(0);

  // Expanding the row spells out what happened. The displacement is the part
  // that distinguishes a real registration from a no-op identity matrix: these
  // fixtures are 90° apart plus a (2, -1.5, 0) shift, so the cloud has to have
  // travelled a non-trivial distance.
  await sourceRow.getByTestId(`scan-expand-${sourceId}`).click();
  const detail = page.getByTestId(`scan-registration-${sourceId}`);
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(/registered: onto/i);
  const shift = Number(await detail.getAttribute('data-registration-shift'));
  expect(shift, 'a real registration displaces the cloud').toBeGreaterThan(0.5);
});

test('Reset Registration returns the scan to its pre-registration position', async () => {
  const { page } = session;
  const rows = await importBoth(page);

  const targetId = await rows.nth(0).getAttribute('data-scan-id');
  const sourceId = await rows.nth(1).getAttribute('data-scan-id');

  // Where the cloud sat BEFORE anything moved it — the coordinates the reset
  // has to reproduce. This is the whole assertion: a reset that merely clears
  // the badge, or that applies the forward matrix a second time, leaves the
  // cloud somewhere else and fails here.
  const before = await scanBounds(page, sourceId!);
  expect(before, 'scene debug bounds unavailable').not.toBeNull();
  const targetBounds = await scanBounds(page, targetId!);

  await autoRegister(page, 0, 1);
  const toast = page.locator('[data-testid="toast-success"], [data-testid="toast-warning"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText(/Auto-Register/i, { timeout: 120_000 });

  const sourceRow = page.locator(`[data-testid="scan-row"][data-scan-id="${sourceId}"]`);
  await expect(sourceRow).toHaveAttribute('data-registered', 'true', { timeout: 30_000 });

  // Sanity: the cloud actually moved onto the target, so "went back" below is
  // a real journey rather than a cloud that never left.
  const registered = await scanBounds(page, sourceId!);
  const movedBy = Math.max(...[0, 1, 2].map(a => Math.abs(registered!.min[a] - before!.min[a])));
  expect(movedBy, 'registration should have displaced the cloud').toBeGreaterThan(0.5);

  // The command is menu-bar/palette only — no toolbar button — so it is
  // dispatched through the same bridge the native Tools menu uses.
  await runTool(page, 'cloud-unregister');

  // It confirms first: the move is permanent and clears the matrix that would
  // let it be redone, so it must not fire on a single click.
  const confirm = page.getByTestId('reset-registration-confirm');
  await expect(confirm).toBeVisible();
  // It names the scans that are about to move — here exactly the one that did.
  const listed = confirm.getByTestId('reset-registration-scan');
  await expect(listed).toHaveCount(1);
  await expect(listed).toHaveAttribute('data-scan-id', sourceId!);

  await confirm.getByTestId('reset-registration-confirm-button').click();
  await expect(confirm).toBeHidden({ timeout: 120_000 });

  const resetToast = page.locator('[data-testid="toast-success"], [data-testid="toast-warning"]').last();
  await expect(resetToast.getByTestId('toast-title')).toContainText(/Reset Registration/i, { timeout: 120_000 });

  // The badge is gone...
  await expect(sourceRow).toHaveAttribute('data-registered', 'false', { timeout: 30_000 });
  await expect(sourceRow.getByTestId('scan-row-registered')).toHaveCount(0);

  // ...and the cloud is back where it started. The tolerance is tight because
  // this is an exact inverse of a rigid transform, not a re-fit: the only error
  // is float round-trip through the session rebuild.
  await expect.poll(async () => {
    const s = await scanBounds(page, sourceId!);
    if (!s) return Number.POSITIVE_INFINITY;
    return Math.max(...[0, 1, 2].flatMap(a => [
      Math.abs(s.min[a] - before!.min[a]),
      Math.abs(s.max[a] - before!.max[a]),
    ]));
  }, {
    message: 'reset should restore the pre-registration bounds',
    timeout: 60_000,
  }).toBeLessThan(0.05);

  // And it is genuinely back to its ORIGINAL pose, not still sitting on the
  // target — the two are far apart on these fixtures, so a reset that did
  // nothing but clear the badge would be caught here even if the poll above
  // were somehow satisfied.
  const after = await scanBounds(page, sourceId!);
  const gapToTarget = Math.max(...[0, 1, 2].map(a => Math.abs(after!.min[a] - targetBounds!.min[a])));
  expect(gapToTarget, 'the reset cloud should no longer coincide with the target')
    .toBeGreaterThan(0.5);

  // The target never carried a record and must be untouched throughout.
  const targetAfter = await scanBounds(page, targetId!);
  expect(Math.max(...[0, 1, 2].map(a => Math.abs(targetAfter!.min[a] - targetBounds!.min[a]))))
    .toBeLessThan(0.05);
});

/** Open the Cmd+K palette and return the row for one command id. Cmd+K is a
 *  TOGGLE, so press exactly one modifier combo; retry the other for Linux CI. */
async function paletteRow(page: typeof session.page, search: string, commandId: string) {
  const input = page.getByPlaceholder('Search commands...');
  await page.keyboard.press('Meta+k');
  if (!(await input.isVisible().catch(() => false))) {
    await page.keyboard.press('Control+k');
  }
  await expect(input).toBeVisible();
  await input.fill(search);
  return page.locator(`[data-testid="command-palette-item"][data-command-id="${commandId}"]`);
}

test('Reset Registration is disabled until something has actually been registered', async () => {
  const { page } = session;
  const rows = await importBoth(page);

  // Nothing registered yet: the command must be visibly unavailable rather than
  // live-looking, since it has no dialog in which to explain it had nothing to
  // do. The palette is the surface that renders this state; the native menu
  // item is greyed via the same predicate, pushed to the main process.
  let row = await paletteRow(page, 'Reset Registration', 'cloud-unregister');
  await expect(row).toHaveAttribute('data-available', 'false');
  await expect(row.getByTestId('command-unavailable-reason')).toBeVisible();

  // Clicking a disabled row does nothing — no confirmation opens.
  await row.click();
  await expect(page.getByTestId('reset-registration-confirm')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Register, and the same command becomes available.
  await autoRegister(page, 0, 1);
  const toast = page.locator('[data-testid="toast-success"], [data-testid="toast-warning"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText(/Auto-Register/i, { timeout: 120_000 });
  const sourceId = await rows.nth(1).getAttribute('data-scan-id');
  await expect(page.locator(`[data-testid="scan-row"][data-scan-id="${sourceId}"]`))
    .toHaveAttribute('data-registered', 'true', { timeout: 30_000 });

  row = await paletteRow(page, 'Reset Registration', 'cloud-unregister');
  await expect(row).toHaveAttribute('data-available', 'true');
  await expect(row.getByTestId('command-unavailable-reason')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('the reference scan is marked distinctly from the scan that moved', async () => {
  const { page } = session;
  const rows = await importBoth(page);

  const targetId = await rows.nth(0).getAttribute('data-scan-id');
  const sourceId = await rows.nth(1).getAttribute('data-scan-id');
  const targetRow = page.locator(`[data-testid="scan-row"][data-scan-id="${targetId}"]`);
  const sourceRow = page.locator(`[data-testid="scan-row"][data-scan-id="${sourceId}"]`);

  // Before registering, neither scan is a reference — otherwise the assertion
  // below would pass on a marker that was always there.
  await expect(targetRow).toHaveAttribute('data-registration-reference', 'false');

  await autoRegister(page, 0, 1);
  const toast = page.locator('[data-testid="toast-success"], [data-testid="toast-warning"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText(/Auto-Register/i, { timeout: 120_000 });

  // The reference is marked, but with the REFERENCE badge, not the moved one.
  // The distinction is what tells a user that this scan is part of a
  // registration yet is not affected by resetting it.
  await expect(targetRow).toHaveAttribute('data-registration-reference', 'true', { timeout: 30_000 });
  await expect(targetRow.getByTestId('scan-row-reference')).toBeVisible();
  await expect(targetRow.getByTestId('scan-row-registered')).toHaveCount(0);

  // ...and the mover carries the moved badge and is NOT a reference.
  await expect(sourceRow.getByTestId('scan-row-registered')).toBeVisible();
  await expect(sourceRow).toHaveAttribute('data-registration-reference', 'false');
  await expect(sourceRow.getByTestId('scan-row-reference')).toHaveCount(0);

  // Expanding the reference names the scans registered onto it, so the row that
  // will NOT move still says which rows would.
  await targetRow.getByTestId(`scan-expand-${targetId}`).click();
  const detail = page.getByTestId(`scan-reference-${targetId}`);
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute('data-reference-count', '1');
  await expect(detail).toContainText(/not moved/i);

  // Resetting removes BOTH marks: with the mover's record gone, nothing is
  // registered onto the reference, so it stops being one. This is the property
  // that a stored flag on the reference would have got wrong.
  await runTool(page, 'cloud-unregister');
  const confirm = page.getByTestId('reset-registration-confirm');
  await expect(confirm).toBeVisible();
  // Only the mover is listed — the reference is not moved by the reset.
  const listed = confirm.getByTestId('reset-registration-scan');
  await expect(listed).toHaveCount(1);
  await expect(listed).toHaveAttribute('data-scan-id', sourceId!);
  await confirm.getByTestId('reset-registration-confirm-button').click();
  await expect(confirm).toBeHidden({ timeout: 120_000 });

  await expect(sourceRow).toHaveAttribute('data-registered', 'false', { timeout: 30_000 });
  await expect(targetRow).toHaveAttribute('data-registration-reference', 'false');
  await expect(targetRow.getByTestId('scan-row-reference')).toHaveCount(0);
});
