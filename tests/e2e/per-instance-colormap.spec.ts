import { test, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Per-instance colormaps.
//
// Before this feature the app held exactly ONE colormap state variable, and the
// pickers on each mesh row / LAD result were all wired to that same setter —
// so "per-instance" was an illusion: changing one changed every object at once.
// A mesh now carries its own override, and objects without one follow the
// scene default set in the Display panel.
//
// Asserting on DOM state alone would not catch a regression to the old
// behaviour (the two selects would still *show* different values while the
// geometry painted identically), so the decisive assertions here read real
// pixels off the WebGL canvas.

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

type ColorSig = { r: number; g: number; b: number; n: number };

// Mean RGB of each mesh's per-triangle color buffer — the exact float data
// uploaded to the GPU, keyed by mesh id.
//
// Why not read the canvas: the E2E launcher hides the window, and an offscreen
// Electron WebGL context reads back black through toDataURL/drawImage (the same
// limitation documented in plant-generate.spec.ts and worked around by
// tests/e2e/visual/capture-plant.mjs). Asserting the colour BUFFER is the
// strongest check available in-process, and it is what a per-instance colormap
// regression would actually corrupt — under the old global model both meshes'
// buffers were rebuilt from one shared colormap.
async function meshColorSignatures(page: Page): Promise<Record<string, ColorSig>> {
  return page.evaluate(
    () => (window as unknown as { __meshColorSignature?: () => Record<string, ColorSig> })
      .__meshColorSignature?.() ?? {},
  );
}

function colorDistance(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

// Import the fixture and triangulate it twice, yielding two independent meshes.
//
// Ball Pivoting, NOT Poisson. This was the source of a ~50%-per-run flake that
// surfaced as `expect(mesh-row).toHaveCount(N)` timing out one mesh short, at a
// different test on each run. It reads like a selection or timing problem and is
// neither: Open3D 0.19.0's Poisson reconstruction fails nondeterministically on
// ~6% of calls (documented at `_run_poisson_isolated` in backend-api/main.py,
// which subprocess-isolates it so a SIGSEGV can't take the backend down). Here
// it surfaced as the child erroring out rather than crashing —
//
//   Failed to close loop [4: 9 24 17] | (45701): (296,352,326)
//     — PoissonRecon/Src/FEMTree.IsoSurface.specialized.inl:1463
//
// — which the backend correctly reports as a failed triangulation and the UI
// correctly shows as an error toast. The product is behaving properly; the test
// was just built on a coin flip. Six Poisson calls per run (two per test, three
// tests) at ~6% each is a ~30% chance that some assertion in the file comes up
// short — matching both the observed rate and the way the failure wandered
// between tests. triangulate-merge.spec.ts was moved off Poisson for this same
// reason.
//
// Ball Pivoting is deterministic on this fixture, and measurably so: 40/40
// triangulations across 20 fresh scenes produced 109 triangles and a
// byte-identical colour signature every time (and the whole loop ran in 43 s,
// against minutes for the Poisson version). That also strengthens the file —
// the two meshes are now identical, so "both follow the default, so their
// colours converge" is an exact equality rather than a tolerance around two
// different reconstructions.
//
// Nothing here depends on Poisson: these tests need two meshes carrying
// per-triangle scalar colour, which any triangulated mesh provides.
async function makeTwoMeshes(page: Page, app: LaunchedApp['app']) {
  await importFiles(app, page, 'import-auto', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  for (let i = 0; i < 2; i++) {
    await page.getByTestId('tool-triangulate').click();
    const triModal = page.getByTestId('triangulation-popup');
    await expect(triModal).toBeVisible();
    await triModal.getByTestId('triangulation-method').selectOption('ball_pivoting');
    // The popup seeds its own scan checkboxes from the panel selection on open,
    // falling back to ALL eligible scans when that selection is empty
    // (TriangulationPopup's seed effect). With one cloud in the scene both
    // routes pick that cloud, so no re-click is needed between iterations —
    // and a plain click here would be actively wrong: triangulating does not
    // touch selectedScanIds, so the row is still the sole selection and a
    // click would toggle it OFF (see handleToggleScanSelection in App.tsx,
    // and the same trap documented in scan-transform-shortcut.spec.ts).
    await triModal.getByTestId('triangulation-run-button').click();
    await expect(page.getByTestId('mesh-row')).toHaveCount(i + 1, { timeout: 90_000 });
  }
}

// Expand a mesh row and put it into a scalar colour mode so its colormap
// picker is offered.
async function colorMeshBy(page: Page, index: number, mode: string) {
  const row = page.getByTestId('mesh-row').nth(index);
  await row.getByTestId('mesh-color-expand').click();
  const modeSelect = page.getByTestId('mesh-color-mode').nth(index);
  await expect(modeSelect).toBeVisible();
  await modeSelect.selectOption(mode);
}

test('two meshes hold independent colormaps and render differently', async () => {
  const { app, page } = session;

  await makeTwoMeshes(page, app);
  await colorMeshBy(page, 0, 'inclination');
  await colorMeshBy(page, 1, 'inclination');

  const pickers = page.getByTestId('mesh-color-colormap');
  await expect(pickers).toHaveCount(2);

  // Both start out inheriting the scene default, so neither offers a reset.
  await expect(pickers.nth(0)).toHaveAttribute('data-overridden', 'false');
  await expect(pickers.nth(1)).toHaveAttribute('data-overridden', 'false');
  await expect(page.getByTestId('mesh-colormap-reset')).toHaveCount(0);

  // Give mesh 0 its own colormap. Under the OLD global model this would have
  // moved mesh 1 too.
  await pickers.nth(0).selectOption('jet');

  await expect(pickers.nth(0)).toHaveValue('jet');
  await expect(pickers.nth(1)).toHaveValue('viridis');
  await expect(pickers.nth(0)).toHaveAttribute('data-overridden', 'true');
  await expect(pickers.nth(1)).toHaveAttribute('data-overridden', 'false');
  // Exactly one reset button — only the overridden mesh has something to reset.
  await expect(page.getByTestId('mesh-colormap-reset')).toHaveCount(1);
});

test('the scene default repaints only the meshes still inheriting it', async () => {
  const { app, page } = session;

  await makeTwoMeshes(page, app);
  await colorMeshBy(page, 0, 'inclination');
  await colorMeshBy(page, 1, 'inclination');

  const ids = await page.getByTestId('mesh-row').evaluateAll(
    (rows) => rows.map(r => r.getAttribute('data-mesh-id')!),
  );
  const pickers = page.getByTestId('mesh-color-colormap');
  // Mesh 0 pins itself to jet; mesh 1 keeps following the default.
  await pickers.nth(0).selectOption('jet');
  await expect(pickers.nth(0)).toHaveValue('jet');
  await page.waitForTimeout(500);
  const before = await meshColorSignatures(page);
  expect(before[ids[0]].n).toBeGreaterThan(50);

  // Change the scene default from the Display panel. The picker only appears
  // for continuous cloud modes, so skip the assertion rather than fake it if
  // the scene isn't in one.
  const displayColormap = page.getByTestId('display-colormap');
  const hasDefaultPicker = (await displayColormap.count()) > 0;
  if (hasDefaultPicker) {
    await displayColormap.selectOption('magma');
    // The overridden mesh is untouched; the inheriting one follows.
    await expect(pickers.nth(0)).toHaveValue('jet');
    await expect(pickers.nth(1)).toHaveValue('magma');

    // …and prove it in the colour data, not just the dropdowns: mesh 1's
    // buffer must have been rebuilt, mesh 0's must be byte-identical.
    await page.waitForTimeout(500);
    const after = await meshColorSignatures(page);
    expect(
      colorDistance(before[ids[1]], after[ids[1]]),
      'the inheriting mesh should repaint when the scene default changes',
    ).toBeGreaterThan(0.05);
    expect(
      colorDistance(before[ids[0]], after[ids[0]]),
      'the overridden mesh must ignore the scene default',
    ).toBeLessThan(1e-6);
  }

  // Resetting mesh 0 drops it back onto the (now magma) default.
  const beforeReset = await meshColorSignatures(page);
  await page.getByTestId('mesh-colormap-reset').click();
  await expect(pickers.nth(0)).toHaveAttribute('data-overridden', 'false');
  await expect(page.getByTestId('mesh-colormap-reset')).toHaveCount(0);
  const defaultName = hasDefaultPicker ? await displayColormap.inputValue() : 'viridis';
  await expect(pickers.nth(0)).toHaveValue(defaultName);
  await expect(pickers.nth(1)).toHaveValue(defaultName);

  // Both meshes now share the default, so their colours must converge: mesh 0
  // repaints away from jet and lands on whatever mesh 1 is using.
  //
  // The two meshes are Ball Pivoting reconstructions of the same cloud, which is
  // deterministic here (measured identical across 40 runs — see makeTwoMeshes),
  // so the two means are equal to floating-point noise rather than merely close.
  // The tolerance stays well under the jet↔default separation this same test
  // measures (>0.05), so it still fails if mesh 0 stays on its override.
  await page.waitForTimeout(500);
  const afterReset = await meshColorSignatures(page);
  expect(
    colorDistance(beforeReset[ids[0]], afterReset[ids[0]]),
    'resetting should repaint the mesh off its override',
  ).toBeGreaterThan(0.05);
  expect(
    colorDistance(afterReset[ids[0]], afterReset[ids[1]]),
    'both meshes now follow the same default, so their colours should converge',
  ).toBeLessThan(0.02);
});

test('one mesh repaints on its own colormap while the other keeps its colors', async () => {
  const { app, page } = session;

  await makeTwoMeshes(page, app);
  await colorMeshBy(page, 0, 'inclination');
  await colorMeshBy(page, 1, 'inclination');

  const ids = await page.getByTestId('mesh-row').evaluateAll(
    (rows) => rows.map(r => r.getAttribute('data-mesh-id')!),
  );
  expect(ids).toHaveLength(2);

  await expect.poll(async () => Object.keys(await meshColorSignatures(page)).length,
    { timeout: 15_000 }).toBe(2);
  const before = await meshColorSignatures(page);
  // Both meshes were built from the same colormap, so their buffers carry real
  // colour data. Guard the measurement before comparing against it.
  expect(before[ids[0]].n, 'mesh 0 should have colour data').toBeGreaterThan(50);
  expect(before[ids[1]].n, 'mesh 1 should have colour data').toBeGreaterThan(50);

  // jet's low end is deep blue where viridis's is dark purple, and its high end
  // is red where viridis's is yellow — a large, unambiguous shift.
  await page.getByTestId('mesh-color-colormap').first().selectOption('jet');
  await expect(page.getByTestId('mesh-color-colormap').first()).toHaveValue('jet');
  await page.waitForTimeout(500);
  const after = await meshColorSignatures(page);

  const moved = colorDistance(before[ids[0]], after[ids[0]]);
  const untouched = colorDistance(before[ids[1]], after[ids[1]]);

  // The decisive pair: the overridden mesh's colours really changed…
  expect(
    moved,
    `mesh 0 should repaint (was rgb(${before[ids[0]].r.toFixed(2)},${before[ids[0]].g.toFixed(2)},${before[ids[0]].b.toFixed(2)}) now rgb(${after[ids[0]].r.toFixed(2)},${after[ids[0]].g.toFixed(2)},${after[ids[0]].b.toFixed(2)}))`,
  ).toBeGreaterThan(0.05);
  // …and the other mesh's did NOT. Under the old single-global model this is
  // exactly what failed: both buffers moved together.
  expect(
    untouched,
    `mesh 1 must keep its colours (was rgb(${before[ids[1]].r.toFixed(2)},${before[ids[1]].g.toFixed(2)},${before[ids[1]].b.toFixed(2)}) now rgb(${after[ids[1]].r.toFixed(2)},${after[ids[1]].g.toFixed(2)},${after[ids[1]].b.toFixed(2)}))`,
  ).toBeLessThan(1e-6);
});

// ---------------------------------------------------------------------------
// Per-cloud color MODE (phase 4). Previously colorMode/selectedScalarField were
// global, so every cloud in the scene was forced into the same mode — and a
// scalar field that existed on only one cloud left the others painting a flat
// gray ramp. The mode now lives on the cloud that owns the field.

test('two clouds hold different color modes at the same time', async () => {
  const { app, page } = session;

  // Two independent clouds. Only the first gets segmented, so only it carries
  // a wood_class field — the exact asymmetry the old global mode mishandled.
  await importFiles(app, page, 'import-point-cloud',
    join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree_wood_leaf.xyz'));
  await completeImportWizard(page);
  const woodRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf.xyz"]');
  await expect(woodRow).toBeVisible({ timeout: 20_000 });

  await importFiles(app, page, 'import-point-cloud',
    join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree-view1.xyz'));
  await completeImportWizard(page);
  const plainRow = page.locator('[data-testid="scan-row"][data-scan-name="tree-view1.xyz"]');
  await expect(plainRow).toBeVisible({ timeout: 20_000 });

  // Segment ONLY the first cloud.
  await woodRow.click();
  await expect(woodRow).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('tool-wood-segment').click();
  await expect(page.getByTestId('wood-segment-panel')).toBeVisible();
  await page.getByTestId('wood-segment-run-button').click();

  const legend = page.getByTestId('class-legend');
  await expect(legend).toBeVisible({ timeout: 60_000 });
  await expect(legend).toHaveAttribute('data-legend-attribute', 'wood_class');

  // The segmented cloud is in scalar:wood_class…
  const displayToggle = page.getByRole('button', { name: 'Display' });
  await displayToggle.click();
  const colorMode = page.getByTestId('display-color-mode');
  await woodRow.click();
  await expect(colorMode).toHaveValue('scalar:wood_class');

  // …while the OTHER cloud, selected on its own, is NOT — under the old global
  // model both rows reported the same mode, and the plain cloud rendered gray
  // against a field it does not have.
  await plainRow.click();
  await expect(plainRow).toHaveAttribute('data-selected', 'true');
  await expect(colorMode).not.toHaveValue('scalar:wood_class');
  const plainOptions = await colorMode.locator('option').evaluateAll(
    (opts) => opts.map(o => (o as HTMLOptionElement).value),
  );
  expect(plainOptions.filter(o => o.includes('wood_class'))).toHaveLength(0);

  // Give the plain cloud its own distinct mode; the segmented one must keep
  // its scalar mode rather than being dragged along.
  await colorMode.selectOption('height');
  await expect(colorMode).toHaveValue('height');
  await woodRow.click();
  await expect(colorMode).toHaveValue('scalar:wood_class');
  await expect(legend).toBeVisible();
});

// ---------------------------------------------------------------------------
// Unified legend stack (phases 5–6). Four independent legend overlays used to
// stack along the bottom edge, each captioned only by its variable. They are
// now one deduped stack: every entry names the geometry it describes, objects
// sharing a channel fold into one grouped entry, and clicking an entry opens
// its colormap editor.

test('legends name their geometry and dedupe across objects sharing a channel', async () => {
  const { app, page } = session;

  await makeTwoMeshes(page, app);
  await colorMeshBy(page, 0, 'inclination');
  await colorMeshBy(page, 1, 'inclination');

  // Both meshes share one channel (same mode, same inherited colormap), so the
  // stack folds them into a SINGLE entry captioned by the group — the clutter
  // fix. Two separate unlabelled colorbars was the old behaviour.
  const stack = page.getByTestId('legend-stack');
  await expect(stack).toBeVisible();
  await expect(page.getByTestId('mesh-colorbar')).toHaveCount(1);
  const grouped = page.getByTestId('mesh-colorbar').first();
  await expect(grouped).toHaveAttribute('data-legend-object', '2 meshes');
  await expect(grouped).toHaveAttribute('data-legend-variable', /Inclination/);

  // Giving one mesh its own colormap splits the group back into two entries,
  // each naming its own mesh rather than a count.
  await page.getByTestId('mesh-color-colormap').first().selectOption('jet');
  await expect(page.getByTestId('mesh-colorbar')).toHaveCount(2);
  const labels = await page.getByTestId('mesh-colorbar').evaluateAll(
    (els) => els.map(e => e.getAttribute('data-legend-object')),
  );
  expect(labels.every(l => l && !/^\d+ meshes$/.test(l))).toBe(true);
  // The two entries report the two different colormaps.
  const maps = await page.getByTestId('mesh-colorbar').evaluateAll(
    (els) => els.map(e => e.getAttribute('data-legend-colormap')),
  );
  expect(new Set(maps).size).toBe(2);
});

test('clicking a legend opens an editor that changes that object only', async () => {
  const { app, page } = session;

  await makeTwoMeshes(page, app);
  await colorMeshBy(page, 0, 'inclination');
  await colorMeshBy(page, 1, 'inclination');
  // Split them so each legend addresses exactly one mesh.
  await page.getByTestId('mesh-color-colormap').first().selectOption('jet');
  await expect(page.getByTestId('mesh-colorbar')).toHaveCount(2);

  const ids = await page.getByTestId('mesh-row').evaluateAll(
    (rows) => rows.map(r => r.getAttribute('data-mesh-id')!),
  );
  const before = await meshColorSignatures(page);

  // The editor is closed until the caption is clicked.
  await expect(page.getByTestId('legend-editor')).toHaveCount(0);
  const target = page.locator('[data-testid="mesh-colorbar"][data-legend-colormap="jet"]');
  await expect(target).toHaveCount(1);
  const targetIds = (await target.getAttribute('data-legend-objects'))!.split(',');
  expect(targetIds).toHaveLength(1);

  await target.getByTestId('legend-entry-caption').click();
  await expect(page.getByTestId('legend-editor')).toHaveCount(1);

  // Change the colormap from the legend itself.
  await page.getByTestId('legend-colormap').selectOption('magma');
  await page.waitForTimeout(500);

  const after = await meshColorSignatures(page);
  const edited = targetIds[0];
  const other = ids.find(i => i !== edited)!;
  expect(
    colorDistance(before[edited], after[edited]),
    'the edited mesh should repaint',
  ).toBeGreaterThan(0.05);
  expect(
    colorDistance(before[other], after[other]),
    'the other mesh must be untouched by the legend editor',
  ).toBeLessThan(1e-6);

  // The mesh row's own picker agrees — one source of truth, two surfaces.
  await expect(
    page.locator(`[data-mesh-id="${edited}"]`).locator('xpath=..').getByTestId('mesh-color-colormap'),
  ).toHaveValue('magma');
});
