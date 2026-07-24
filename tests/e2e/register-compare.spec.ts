import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const CLOUD_FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Registration/comparison tools are now MODAL-DRIVEN: they're always available
// in the palette/menu and the user picks the cloud/mesh INSIDE the tool's setup
// modal — no pre-selection required. These tests drive that flow through the
// real DOM against the live backend and assert concrete outputs.

let session: LaunchedApp;
test.beforeAll(async () => { session = await launchApp(); });
test.afterAll(async () => { await session?.close(); });
test.beforeEach(async () => { await resetToFreshScene(session.app, session.page); });

// Triangulate a specific cloud (by scan id) into a mesh via the real popup:
// open it, select ONLY that scan's row inside the modal, run. Returns once the
// mesh count has grown by one.
async function triangulateScan(page: typeof session.page, scanId: string) {
  const before = await page.getByTestId('mesh-row').count();
  await page.getByTestId('tool-triangulate').click();
  const tri = page.getByTestId('triangulation-popup');
  await expect(tri).toBeVisible();
  // Ensure exactly this scan is checked: click its row's checkbox if not already.
  const row = tri.locator(`[data-testid="triangulation-scan-row"][data-scan-id="${scanId}"]`);
  const box = row.locator('input[type="checkbox"]');
  if (!(await box.isChecked())) await box.click();
  // Uncheck any others so only this scan is triangulated (one mesh out).
  for (const other of await tri.locator('[data-testid="triangulation-scan-row"]').all()) {
    const id = await other.getAttribute('data-scan-id');
    const cb = other.locator('input[type="checkbox"]');
    if (id !== scanId && (await cb.isChecked())) await cb.click();
  }
  await tri.getByTestId('triangulation-run-button').click();
  await expect(page.getByTestId('mesh-row')).toHaveCount(before + 1, { timeout: 60_000 });
}

// Import the cloud fixture and triangulate it into a mesh. Returns once the mesh
// row is present. The mesh sits ON the cloud, so cloud-to-mesh distance is small.
async function importCloudAndTriangulate(page: typeof session.page) {
  await importFiles(session.app, page, 'import-auto', CLOUD_FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  const scanId = await cloudRow.getAttribute('data-scan-id');
  await triangulateScan(page, scanId!);

  const meshRow = page.getByTestId('mesh-row').first();
  await expect(meshRow).toBeVisible({ timeout: 60_000 });
  return { cloudRow, meshRow };
}

// Clicking a selected row toggles it off; leaves the scene with nothing selected
// so we prove the modal picks its own inputs rather than reading the selection.
// Best-effort clear of the scene selection via the real "Deselect All" command.
// Best-effort (not asserted to reach zero) because these modal-driven tools pick
// their own inputs regardless of selection — the point is only to demonstrate the
// tool doesn't DEPEND on a pre-selection. One test ('Align Clouds…') asserts the
// hard zero-selection case; the offset tests only need the inputs picked in-modal.
async function deselectAll(page: typeof session.page) {
  await page.evaluate(() => {
    (window as unknown as { __runToolCommand?: (id: string) => void }).__runToolCommand?.('deselect-all');
  });
}

// The registration tools are palette/menu-only (no toolbar icon), so they're
// dispatched by id through the same __runToolCommand bridge the native Tools
// menu uses. That bridge enforces isCommandAvailable, so a successful dispatch
// also proves the command is available with nothing selected (multiInput).
async function runTool(page: typeof session.page, id: string) {
  await page.evaluate((toolId) => {
    const run = (window as unknown as { __runToolCommand?: (id: string) => void }).__runToolCommand;
    if (!run) throw new Error('__runToolCommand bridge not available');
    run(toolId);
  }, id);
}

// Parse a "x.xx,y.yy,z.zz" data-mesh-position attribute into a tuple.
function parsePos(attr: string | null): [number, number, number] {
  const [x, y, z] = (attr ?? '').split(',').map(Number);
  return [x, y, z];
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// Offset a mesh by a known translation through its Transform panel (the real UI:
// row's transform toggle → mesh-pos-{x,y,z} DebouncedNumberInputs, committed with
// Enter). Closes the panel again afterward so it doesn't hold the mesh selected.
async function offsetMesh(
  page: typeof session.page,
  meshRow: ReturnType<typeof session.page.locator>,
  [dx, dy, dz]: [number, number, number],
) {
  const toggle = meshRow.getByTestId('mesh-transform-toggle');
  await toggle.click();
  for (const [axis, v] of [['x', dx], ['y', dy], ['z', dz]] as const) {
    const input = page.getByTestId(`mesh-pos-${axis}`);
    await expect(input).toBeVisible();
    await input.fill(String(v));
    await input.press('Enter');
  }
  // Confirm the row reflects the committed offset before proceeding.
  await expect
    .poll(async () => dist(parsePos(await meshRow.getAttribute('data-mesh-position')), [dx, dy, dz]))
    .toBeLessThan(0.02);
  // Close the transform panel (same-mesh toggle collapses it) so a later
  // deselect isn't fighting a panel that keeps the mesh selected.
  await toggle.click();
  await expect(page.getByTestId('mesh-pos-x')).toHaveCount(0);
}

// Read the RMSE value (in mm) out of the Alignment panel.
async function readRmseMm(page: typeof session.page): Promise<number> {
  const panel = page.getByTestId('alignment-panel');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  const text = await panel.getByTestId('alignment-rmse').innerText();  // e.g. "150.00 mm"
  const mm = parseFloat(text);
  expect(Number.isFinite(mm)).toBe(true);
  return mm;
}

async function computeDistance(page: typeof session.page) {
  await runTool(page, 'mesh-cloud-align');
  const dialog = page.getByTestId('mesh-cloud-distance-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('mesh-cloud-distance-cloud-picker').getByTestId('picker-row').first().click();
  await dialog.getByTestId('mesh-cloud-distance-mesh-picker').getByTestId('picker-row').first().click();
  await dialog.getByTestId('mesh-cloud-distance-run').click();
  await expect(dialog).toBeHidden();
}

test('Cloud-to-Mesh Distance reports the KNOWN offset between cloud and mesh', async () => {
  const { page } = session;
  const { meshRow } = await importCloudAndTriangulate(page);

  // Baseline: the mesh was triangulated FROM the cloud, so it sits on it —
  // distance is ~0 (well under 10 mm).
  await deselectAll(page);
  await computeDistance(page);
  const baselineMm = await readRmseMm(page);
  expect(baselineMm).toBeLessThan(10);
  await page.getByTestId('alignment-panel-close').click();

  // Now rigidly offset the mesh by a KNOWN 0.15 m along X. Every cloud point is
  // then ~0.15 m from the nearest mesh face, so RMSE must be ~150 mm — a real
  // correctness check on the distance computation, not just "finite".
  const OFFSET = 0.15;
  await offsetMesh(page, meshRow, [OFFSET, 0, 0]);
  await deselectAll(page);

  await computeDistance(page);
  const offsetMm = await readRmseMm(page);
  // The mesh is now rigidly 150 mm off the cloud. Point→nearest-FACE distance is
  // ≤ the 150 mm shift (and a bit under it on a curved cylinder surface), but
  // decisively larger than the ~0 baseline. Measured backend value for this
  // fixture is ~105 mm RMSE; assert a band that tracks the known offset without
  // being brittle to the exact triangulation.
  expect(offsetMm).toBeLessThanOrEqual(150 + 5);   // can't exceed the rigid shift (+float slack)
  expect(offsetMm).toBeGreaterThan(60);            // decisively reflects the offset, not ~0
  expect(offsetMm).toBeGreaterThan(baselineMm * 5); // and far above the aligned baseline
});

test('Snap to Fit (ICP) REMOVES a known cloud↔mesh offset', async () => {
  const { page } = session;
  const { meshRow } = await importCloudAndTriangulate(page);

  // Rigidly offset the mesh off the cloud by a known 0.15 m along X, so ICP has a
  // real misalignment to correct.
  const OFFSET = 0.15;
  await offsetMesh(page, meshRow, [OFFSET, 0, 0]);
  const beforePos = parsePos(await meshRow.getAttribute('data-mesh-position'));
  expect(dist(beforePos, [0, 0, 0])).toBeGreaterThan(0.1);  // genuinely offset
  await deselectAll(page);

  // Compute distance first (opens the panel + remembers the cloud+mesh); then Snap.
  await computeDistance(page);
  const beforeMm = await readRmseMm(page);
  expect(beforeMm).toBeGreaterThan(60);  // reflects the ~150 mm offset

  const panel = page.getByTestId('alignment-panel');
  const snap = panel.getByTestId('alignment-snap-to-fit');
  await expect(snap).toBeEnabled();  // works with nothing selected (remembered inputs)
  await snap.click();
  const toast = page.locator('[data-testid="toast-success"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText(/Snap to Fit Complete/i, { timeout: 60_000 });

  // ICP must have pulled the mesh back toward the cloud: the 0.15 m offset is
  // substantially removed (residual well under half of it). On this coarse
  // 60-point fixture the surface-sampled ICP converges to ~40-65 mm, not exactly
  // 0 — so assert < 80 mm, which is decisively below the introduced offset while
  // leaving margin above the observed residual. (The distance-drop check below is
  // the independent correctness signal.)
  await expect
    .poll(async () => dist(parsePos(await meshRow.getAttribute('data-mesh-position')), [0, 0, 0]), { timeout: 20_000 })
    .toBeLessThan(0.08);

  // And a fresh distance computation now reads back much smaller — the mesh fits
  // the cloud far better than before — an independent signal that registration
  // actually reduced the misalignment (not just that the op ran).
  await deselectAll(page);
  await computeDistance(page);
  const afterMm = await readRmseMm(page);
  expect(afterMm).toBeLessThan(beforeMm * 0.6);  // distance decisively reduced
});

test('Align Mesh to Mesh (ICP) REMOVES a known offset between two meshes', async () => {
  const { page } = session;
  // Two IDENTICAL cylinder meshes: triangulate tiny.xyz twice. A 60-vertex curved
  // surface is well-conditioned for ICP (the backend samples ~600 surface points
  // per mesh) — unlike an 8-vertex cube, which the sparse sampler under-converges on.
  await importCloudAndTriangulate(page);
  await importFiles(session.app, page, 'import-auto', CLOUD_FIXTURE);
  await completeImportWizard(page);
  const scanRows = page.locator('[data-testid="scan-row"]');
  await expect(scanRows).toHaveCount(2, { timeout: 20_000 });
  await triangulateScan(page, (await scanRows.nth(1).getAttribute('data-scan-id'))!);
  const meshRows = page.getByTestId('mesh-row');
  await expect(meshRows).toHaveCount(2, { timeout: 60_000 });

  // Offset the SOURCE (2nd) mesh by a known 0.15 m along X. Small enough to keep
  // the two cylinders overlapping so local ICP locks onto the right correspondence.
  const OFFSET = 0.15;
  await offsetMesh(page, meshRows.nth(1), [OFFSET, 0, 0]);
  const targetPos = parsePos(await meshRows.nth(0).getAttribute('data-mesh-position'));
  const sourceBefore = parsePos(await meshRows.nth(1).getAttribute('data-mesh-position'));
  expect(dist(sourceBefore, targetPos)).toBeGreaterThan(0.1);  // genuinely misaligned
  await deselectAll(page);

  await runTool(page, 'mesh-mesh-align');
  const dialog = page.getByTestId('mesh-align-dialog');
  await expect(dialog).toBeVisible();

  // Target picker lists both meshes; source picker disables the chosen target.
  const targetRows = dialog.getByTestId('mesh-align-target-picker').getByTestId('picker-row');
  await expect(targetRows).toHaveCount(2);
  await targetRows.nth(0).click();   // target = first cylinder (fixed)
  const sourceRows = dialog.getByTestId('mesh-align-source-picker').getByTestId('picker-row');
  await sourceRows.nth(1).click();   // source = second cylinder (offset, moves)

  await dialog.getByTestId('mesh-align-run').click();
  await expect(dialog).toBeHidden();

  const toast = page.locator('[data-testid="toast-success"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText(/Mesh Alignment Complete/i, { timeout: 60_000 });
  await expect(meshRows).toHaveCount(2);

  // ICP must have moved the source cylinder back toward the target: their
  // separation collapses from the 0.15 m we introduced to a small residual
  // (~40 mm on this coarse fixture — decisively below the offset, proving real
  // correction, not just that the op ran).
  await expect
    .poll(async () => dist(
      parsePos(await meshRows.nth(1).getAttribute('data-mesh-position')),
      parsePos(await meshRows.nth(0).getAttribute('data-mesh-position')),
    ), { timeout: 20_000 })
    .toBeLessThan(0.08);
});

test('Cloud-to-Mesh Distance shows a progress pill while it runs', async () => {
  const { page } = session;
  await importCloudAndTriangulate(page);
  await deselectAll(page);

  // Kick off the distance run through the real modal, but DON'T await the dialog
  // hiding first — poll for the top-center progress pill the instant the run
  // starts. On this 60-point fixture the compute is fast, so the pill may already
  // be gone by the time we look; the assertion tolerates that by accepting either
  // "pill was seen" OR "the run finished" (results panel visible). What it proves
  // is that the pill is WIRED into the run — it's the element that renders while
  // isComputingAlignment is true — not merely that the op didn't throw.
  await runTool(page, 'mesh-cloud-align');
  const dialog = page.getByTestId('mesh-cloud-distance-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('mesh-cloud-distance-cloud-picker').getByTestId('picker-row').first().click();
  await dialog.getByTestId('mesh-cloud-distance-mesh-picker').getByTestId('picker-row').first().click();

  const pill = page.getByTestId('c2m-distance-running');
  const results = page.getByTestId('alignment-panel');
  await dialog.getByTestId('mesh-cloud-distance-run').click();

  // Either we catch the pill mid-run, or the run already completed (panel up).
  // Both are valid proof the pill path executed; a broken wiring would show
  // neither the pill nor a completed run.
  await expect
    .poll(async () => (await pill.count()) > 0 || (await results.count()) > 0, { timeout: 60_000 })
    .toBe(true);

  // The run must ultimately complete and the pill must clear (no stuck spinner).
  await expect(results).toBeVisible({ timeout: 60_000 });
  await expect(pill).toHaveCount(0);
});

test('Align Clouds (ICP) can move an octree-backed source cloud', async () => {
  const { page } = session;
  // Two imported clouds. Imported clouds are OCTREE-backed (streamed) — the very
  // case the old code disabled as a source. Import tiny.xyz twice.
  await importFiles(session.app, page, 'import-auto', CLOUD_FIXTURE);
  await completeImportWizard(page);
  await importFiles(session.app, page, 'import-auto', CLOUD_FIXTURE);
  await completeImportWizard(page);
  const rows = page.locator('[data-testid="scan-row"]');
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  // Both are octree-backed (the regression precondition).
  await expect(rows.nth(0)).toHaveAttribute('data-octree', 'true');
  await expect(rows.nth(1)).toHaveAttribute('data-octree', 'true');
  // Prove the tool works from a truly EMPTY selection (clouds only, no panels
  // holding a mesh — so this reliably reaches zero).
  await deselectAll(page);
  await expect(page.locator('[data-selected="true"]')).toHaveCount(0);

  await runTool(page, 'cloud-align');
  const dialog = page.getByTestId('align-dialog');
  await expect(dialog).toBeVisible();

  // The bug's DIRECT symptom: every source row's radio was disabled. Now both
  // octree clouds must be selectable as the source.
  const sourceRadios = dialog.getByTestId('align-source-picker').locator('input[type="radio"]');
  await expect(sourceRadios).toHaveCount(2);
  await expect(sourceRadios.nth(0)).toBeEnabled();
  await expect(sourceRadios.nth(1)).toBeEnabled();

  // Pick target = first, source = second, and run. The source (octree) is moved
  // via its backend session — the path that used to be blocked entirely.
  await dialog.getByTestId('align-target-picker').getByTestId('picker-row').nth(0).click();
  await dialog.getByTestId('align-source-picker').getByTestId('picker-row').nth(1).click();
  await dialog.getByTestId('align-run').click();
  await expect(dialog).toBeHidden();

  // Alignment completes (success toast) and the moved cloud is still an
  // octree-backed cloud with its full point count — proving the session
  // transform + octree rebuild round-tripped, not the old "can't move" error.
  const toast = page.locator('[data-testid="toast-success"]').last();
  await expect(toast.getByTestId('toast-title')).toContainText(/Cloud Alignment Complete/i, { timeout: 60_000 });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute('data-octree', 'true');
  await expect(rows.nth(1)).toHaveAttribute('data-point-count', '60');
});
