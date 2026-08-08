import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { stubSaveDialog } from './helpers/stubSaveDialog';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
// A Helios scan XML that carries a defined scanner origin (0.5, -1.0, 0.25) and
// references tiny.xyz alongside it, so the import attaches both params and data.
const SCAN_XML = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny-scan.xml');

// Translate tool on an octree-backed cloud. The tool is a DRAFT editor with an
// explicit OK/Cancel flow (the pop-up the user drives):
//
//   1. Typing a value (or dragging the gizmo, or the Blender-style T-modal)
//      updates the viewport LIVE but does NOT bake. The values do NOT auto-reset.
//   2. OK bakes the pending translation into real geometry, then closes.
//   3. Cancel / X→Discard revert to baseline; nothing is baked.
//   4. While the panel is open, other tools are locked (can't compute against a
//      half-applied draft).
//
// Two underlying correctness properties these tests also guard:
//
//  - The offset must REACH the rendered points: a PointCloudOctree attaches to
//    the SCENE ROOT, not the cloud's <group>, so an early bug left the points
//    put while the bounds/gizmo moved. `net.x` on the live octree checks this.
//  - OK must BAKE into geometry: the backend session held untranslated points,
//    and the Helios path (triangulate/LAD) had no translation field — so a
//    compute op silently ran against un-moved points. The triangulate test
//    asserts on real exported OBJ vertex coordinates, which a render-position
//    check cannot catch.
test.describe('translate cloud', () => {
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

  // Export the selected mesh to OBJ through the real Export dialog and return
  // the file's text. Mesh export writes through the native Save dialog + the
  // real fs IPC, so we redirect the dialog to a tmp file (an OS-native window
  // can't be clicked) and read back the bytes actually written.
  async function exportMeshObj(stem: string): Promise<string> {
    const { app, page } = session;
    const dir = mkdtempSync(join(tmpdir(), 'translate-export-'));
    try {
      const objPath = join(dir, `${stem}.obj`);
      await stubSaveDialog(app, objPath);
      await page.evaluate(() => (window as any).__openExportPanel?.());
      await expect(page.getByTestId('export-modal')).toBeVisible();
      await page.getByTestId('export-mesh-obj').click();
      await expect(page.getByTestId('toast-title').filter({ hasText: 'Export Complete' }))
        .toBeVisible({ timeout: 20_000 });
      return readFileSync(objPath, 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Import the fixture and wait for its octree to stream in.
  async function importTiny() {
    const { app, page } = session;
    await importFiles(app, page, 'import-auto', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    // Load-bearing: this must be an octree cloud, the path the bugs affected.
    await expect(cloudRow).toHaveAttribute('data-octree', 'true');
    // Freshly imported scan is auto-selected, so the transform tools target it.
    // (No re-click — a plain click on the sole selection toggles it off.)
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    await page.waitForFunction(() => {
      const reg = (window as any).__octreePositions;
      return reg && Object.keys(reg).length === 1;
    }, { timeout: 20_000 });
    return cloudRow;
  }

  // Read the live octree position entry for the cloud's CURRENT cacheId.
  //
  // Keying by the row's `data-octree-cache-id` (not `Object.keys(reg)[0]`) is
  // load-bearing: baking rebuilds the octree under a new cacheId, and during the
  // remount the outgoing entry can still be in the registry alongside the new
  // one. Reading an arbitrary key then returns the stale pre-bake entry — which
  // reports net.x === 5 and makes it look like nothing was baked.
  const readEntry = async () => {
    const cacheId = await session.page
      .locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]')
      .getAttribute('data-octree-cache-id');
    if (!cacheId) throw new Error('cloud row has no octree cache id');
    return session.page.evaluate((id) => {
      const reg = (window as any).__octreePositions;
      return (reg?.[id] ?? null) as {
        net: { x: number; y: number; z: number };
        world: { x: number; y: number; z: number };
      } | null;
    }, cacheId);
  };

  // readEntry, but fails the poll instead of throwing while the octree for a
  // freshly-rebuilt cacheId is still streaming in.
  const readEntryWhenReady = async () => {
    // Poll: right after import (and right after a bake rebuild) the row's
    // data-octree-cache-id and the registry entry for it can settle a frame
    // apart, so a one-shot read can miss. Retry until the current cacheId's
    // entry is present.
    let last: Awaited<ReturnType<typeof readEntry>> = null;
    await expect.poll(async () => {
      last = await readEntry();
      return last !== null;
    }, { timeout: 20_000, intervals: [100, 250, 500] }).toBe(true);
    if (!last) throw new Error('octree entry not registered yet');
    return last;
  };

  // Open the Translate tool (the OK/Cancel panel). Its toolbar button is
  // `tool-cloud-translate`; the panel appears with the selection targeted.
  async function openTranslateTool() {
    const { page } = session;
    await page.getByTestId('tool-cloud-translate').click();
    await expect(page.getByTestId('translate-panel')).toBeVisible();
  }

  // Type an exact axis value into the panel input. Updates the DRAFT + viewport
  // live; does NOT bake (that's the OK button). Requires the panel to be open.
  async function typeTranslate(axis: 'x' | 'y' | 'z', value: string) {
    const input = session.page.getByTestId(`translate-input-${axis}`);
    await input.fill(value);
    await input.press('Enter');  // commit the draft value (debounceMs=0, but be explicit)
  }

  // Set a translate value via the Blender-style T-modal (a separate input path
  // that now feeds the SAME draft — no bake on Enter). Requires the Translate
  // tool to be open first (the cloud T-gesture is gated on translate mode).
  async function tModalTranslate(axis: 'x' | 'y' | 'z', value: string) {
    const { page } = session;
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    // Move focus to <body> so the window keydown handler owns every key. Two
    // hazards this avoids: (a) a focused panel INPUT makes isInputFocused() true
    // and swallows the keys; (b) a focused BUTTON (e.g. the toolbar toggle just
    // clicked to open the tool) turns Enter into a button *click*, which would
    // toggle the tool instead of committing the modal. Focusing body neutralizes
    // both — the modal's own keydown handler then sees t / digits / Enter.
    const focusBody = () => page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
    });
    await focusBody();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    await page.keyboard.press('t');
    await expect(page.getByTestId('transform-hud')).toHaveAttribute('data-transform-op', 'translate');
    await page.keyboard.press(axis);
    await expect(page.getByTestId('transform-hud')).toHaveAttribute('data-transform-axis', axis);
    for (const ch of value) await page.keyboard.press(ch);
    // The HUD echoes the typed buffer; wait for it so we know the digits landed
    // in the modal before committing.
    await expect(page.getByTestId('transform-hud')).toContainText(value);
    // Commit the modal with a LEFT CLICK in the viewport (the HUD's "click ·
    // ↵ confirm" path), not Enter: a window-level mousedown listener commits
    // the modal regardless of focus, sidestepping the focus tug-of-war between
    // the panel inputs (which stopPropagation Enter) and the toolbar button
    // (where Enter would re-toggle the tool). updateModal prefers the typed
    // numericBuffer over the mouse position, so the click keeps the value.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // HUD gone → T-modal committed the draft; the panel stays open (not baked).
    await expect(page.getByTestId('transform-hud')).toHaveCount(0);
    await expect(page.getByTestId('translate-panel')).toBeVisible();
  }

  // Type an exact rotation value (degrees) into the panel. Updates the DRAFT +
  // viewport live; does NOT bake. Requires the panel to be open.
  async function typeRotate(axis: 'x' | 'y' | 'z', value: string) {
    const input = session.page.getByTestId(`rotation-input-${axis}`);
    await input.fill(value);
    await input.press('Enter');
  }

  // Open the Scene Origin panel and set an exact world origin via the numeric
  // inputs. Leaves the panel open; caller closes it (or opens Transform next).
  async function setSceneOrigin(x: string, y: string, z: string) {
    const { page } = session;
    await page.getByTestId('tool-set-scene-origin').click();
    await expect(page.getByTestId('scene-origin-panel')).toBeVisible();
    for (const [axis, v] of [['x', x], ['y', y], ['z', z]] as const) {
      const input = page.getByTestId(`scene-origin-input-${axis}`);
      await input.fill(v);
      await input.press('Enter');
    }
    await expect(page.getByTestId('scene-origin-panel')).toHaveAttribute('data-has-origin', 'true');
    // Close the origin panel so the Transform tool can open (panels are exclusive).
    await page.getByTestId('scene-origin-close').click();
    await expect(page.getByTestId('scene-origin-panel')).toBeHidden();
  }

  // Click OK and wait for the bake to finish (panel closes).
  async function clickOK() {
    const { page } = session;
    await page.getByTestId('translate-ok').click();
    await expect(page.getByTestId('translate-panel')).toBeHidden({ timeout: 60_000 });
  }

  test('typing a value updates the viewport as a draft, then OK bakes it', async () => {
    await importTiny();

    // Baseline: untranslated cloud has zero NET offset on top of its loader base.
    const before = await readEntryWhenReady();
    expect(before.net).toEqual({ x: 0, y: 0, z: 0 });

    // Regression guard for the "corner slammed to the origin" bug: the fixture
    // cylinder is centered at (x,y)=(0,0) spanning [-0.3,0.3], so its min-corner
    // (the octree's world position) must sit at clearly-negative x/y — NOT at the
    // origin, which is what overwriting the loader's base offset produced.
    expect(before.world.x).toBeLessThan(-0.05);
    expect(before.world.y).toBeLessThan(-0.05);

    await openTranslateTool();
    await typeTranslate('x', '5');

    // DRAFT phase: the viewport follows LIVE (net offset = +5) but the geometry
    // is NOT baked yet — this is the key UX the user asked for. The panel stays
    // open and reports it's dirty. Crucially, the value does NOT reset to 0.
    await expect.poll(async () => {
      const e = await readEntry();
      return e ? Math.round(e.net.x * 1000) / 1000 : null;
    }, { timeout: 10_000, intervals: [100, 250] }).toBe(5);
    await expect(session.page.getByTestId('translate-panel')).toHaveAttribute('data-dirty', 'true');
    // The draft is stable — it must NOT auto-bake/auto-reset after a delay.
    await session.page.waitForTimeout(800);
    expect(Math.round(((await readEntryWhenReady()).net.x) * 1000) / 1000).toBe(5);

    // COMMIT: OK bakes. Now the cloud is +5 in real WORLD position and the
    // render-only NET offset is back to zero (the move lives in geometry).
    await clickOK();
    await expect.poll(async () => {
      const e = await readEntry();
      if (!e) return null;
      return {
        netX: Math.round(e.net.x * 1000) / 1000,
        worldDx: Math.round((e.world.x - before.world.x) * 1000) / 1000,
      };
    }, { timeout: 60_000, intervals: [250, 500, 1000] }).toEqual({ netX: 0, worldDx: 5 });

    // Y/Z untouched.
    const after = await readEntryWhenReady();
    expect(Math.abs(after.world.y - before.world.y)).toBeLessThan(1e-3);
    expect(Math.abs(after.world.z - before.world.z)).toBeLessThan(1e-3);
  });

  test('Cancel discards the pending translation (viewport reverts, nothing baked)', async () => {
    await importTiny();
    const before = await readEntryWhenReady();

    await openTranslateTool();
    await typeTranslate('x', '5');
    // Draft applied live.
    await expect.poll(async () => {
      const e = await readEntry();
      return e ? Math.round(e.net.x * 1000) / 1000 : null;
    }, { timeout: 10_000, intervals: [100, 250] }).toBe(5);

    // Cancel: panel closes, offset reverts to baseline, NOTHING baked (world
    // position unchanged, net back to 0).
    await session.page.getByTestId('translate-cancel').click();
    await expect(session.page.getByTestId('translate-panel')).toBeHidden();
    const after = await readEntryWhenReady();
    expect(Math.abs(after.net.x)).toBeLessThan(1e-3);
    expect(Math.abs(after.world.x - before.world.x)).toBeLessThan(1e-3);
  });

  test('X-close with pending changes prompts, and Discard reverts', async () => {
    await importTiny();
    const before = await readEntryWhenReady();

    await openTranslateTool();
    await typeTranslate('x', '5');
    await expect.poll(async () => {
      const e = await readEntry();
      return e ? Math.round(e.net.x * 1000) / 1000 : null;
    }, { timeout: 10_000, intervals: [100, 250] }).toBe(5);

    // Clicking X with unsaved changes must PROMPT (not silently close/apply).
    await session.page.getByTestId('translate-close').click();
    await expect(session.page.getByTestId('translate-close-confirm')).toBeVisible();

    // Discard → revert to baseline, nothing baked.
    await session.page.getByTestId('translate-confirm-discard').click();
    await expect(session.page.getByTestId('translate-panel')).toBeHidden();
    const after = await readEntryWhenReady();
    expect(Math.abs(after.net.x)).toBeLessThan(1e-3);
    expect(Math.abs(after.world.x - before.world.x)).toBeLessThan(1e-3);
  });

  test('the T-modal (press T) feeds the same draft and OK bakes it', async () => {
    await importTiny();
    const before = await readEntryWhenReady();

    await openTranslateTool();
    await tModalTranslate('x', '5');
    // T-modal updated the DRAFT (net +5), panel still open, not baked.
    await expect.poll(async () => {
      const e = await readEntry();
      return e ? Math.round(e.net.x * 1000) / 1000 : null;
    }, { timeout: 10_000, intervals: [100, 250] }).toBe(5);

    await clickOK();
    await expect.poll(async () => {
      const e = await readEntry();
      if (!e) return null;
      return {
        netX: Math.round(e.net.x * 1000) / 1000,
        worldDx: Math.round((e.world.x - before.world.x) * 1000) / 1000,
      };
    }, { timeout: 60_000, intervals: [250, 500, 1000] }).toEqual({ netX: 0, worldDx: 5 });
  });

  // The bug that motivated baking: a translated cloud fed to a COMPUTE tool.
  // Triangulation reads points by session_id, and HeliosScanEntry/PointSource
  // carried no translation for the Helios path — so the mesh came back at the
  // cloud's ORIGINAL location while the user saw the cloud 5 m away. Asserting
  // on real exported OBJ vertex coordinates is what catches that.
  test('a translated cloud triangulates at its translated position', async () => {
    const { page } = session;

    const cloudRow = await importTiny();

    const before = await readEntryWhenReady();
    await openTranslateTool();
    await typeTranslate('x', '5');
    await clickOK();
    // Wait for the bake to land: the geometry moved +5 AND the render-only
    // offset is back to zero (i.e. the new, post-bake octree is the one mounted).
    await expect.poll(async () => {
      const e = await readEntry();
      if (!e) return null;
      return {
        netX: Math.round(e.net.x * 1000) / 1000,
        worldDx: Math.round((e.world.x - before.world.x) * 1000) / 1000,
      };
    }, { timeout: 60_000, intervals: [250, 500, 1000] }).toEqual({ netX: 0, worldDx: 5 });

    // Triangulate through the real UI (Poisson at non-default depth 7, matching
    // the other triangulation specs on this fixture).
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('tool-triangulate').click();
    const triModal = page.getByTestId('triangulation-popup');
    await expect(triModal).toBeVisible();
    await triModal.getByTestId('triangulation-method').selectOption('poisson');
    await triModal.getByTestId('triangulation-poisson-depth').fill('7');
    await triModal.getByTestId('triangulation-run-button').click();

    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });

    // Export the mesh to OBJ and read its real vertex coordinates off disk.
    await meshRow.click();
    await expect(meshRow).toHaveAttribute('data-selected', 'true');
    const obj = await exportMeshObj('translated');

    const xs = obj.split('\n')
      .filter((l) => l.startsWith('v '))
      .map((l) => parseFloat(l.slice(2).trim().split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n));
    expect(xs.length).toBeGreaterThan(0);

    // The fixture cylinder spans x ∈ [-0.3, 0.3]; translated by +5 the mesh must
    // span roughly [4.7, 5.3]. Before the fix it came back at [-0.3, 0.3] — the
    // silent failure this guards. Bounds are loose to tolerate Poisson's
    // surface-extraction overshoot, but nowhere near the untranslated range.
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    expect(minX).toBeGreaterThan(4.0);
    expect(maxX).toBeLessThan(6.0);
  });

  // A baked translate is a permanent, non-undoable commit (like a filter/erase).
  // Before the review fix, the commit points recorded an undo entry whose `after`
  // was the not-yet-baked render offset; the bake then zeroed it, leaving a stale
  // entry. This asserts the intended contract: after a translate + bake, Undo
  // does NOT snap the cloud back (the geometry move stands), and — critically —
  // it does not double-move it either. The bake's scene.boundary purges the
  // touching history, so Undo is a no-op on this cloud.
  test('undo after a baked translate leaves the cloud moved (non-undoable)', async () => {
    const before = await (async () => { await importTiny(); return readEntryWhenReady(); })();

    await openTranslateTool();
    await typeTranslate('x', '5');
    await clickOK();
    await expect.poll(async () => {
      const e = await readEntry();
      if (!e) return null;
      return Math.round((e.world.x - before.world.x) * 1000) / 1000;
    }, { timeout: 60_000, intervals: [250, 500, 1000] }).toBe(5);

    // Undo. If the stale-history bug were present, this would either snap the
    // render offset around or (on redo) double-move; the correct behavior is
    // that the baked +5 geometry stays put.
    await session.page.keyboard.press('Meta+z');
    await session.page.keyboard.press('Control+z');  // cross-platform under E2E

    // Give any (incorrect) undo a chance to take effect, then assert the world
    // position is STILL +5 and the net offset is STILL 0.
    await session.page.waitForTimeout(500);
    const after = await readEntryWhenReady();
    expect(Math.round((after.world.x - before.world.x) * 1000) / 1000).toBe(5);
    expect(Math.abs(after.net.x)).toBeLessThan(1e-3);
  });

  // Move to Origin is a canned cloud translation — it must bake too, or it
  // reintroduces the exact silent-offset bug for a different entry point. The
  // fixture cylinder is centered at (x,y)=(0,0), so to get a non-trivial recenter
  // we first translate it +5, bake, THEN Move to Origin and assert the cloud
  // returns to ~0 in real world position (net offset 0 = baked, not a render
  // offset).
  test('Move to Origin bakes the recentering into geometry', async () => {
    const before = await (async () => { await importTiny(); return readEntryWhenReady(); })();

    // First move it +5 and bake (so the recenter has something non-trivial to
    // undo). The Translate tool must be CLOSED before Move to Origin, which is
    // guarded (greyed out) while the Translate panel is open.
    await openTranslateTool();
    await typeTranslate('x', '5');
    await clickOK();
    await expect.poll(async () => {
      const e = await readEntry();
      return e ? Math.round((e.world.x - before.world.x) * 1000) / 1000 : null;
    }, { timeout: 60_000, intervals: [250, 500, 1000] }).toBe(5);

    // Invoke Move to Origin via the command palette (Cmd/Ctrl+K → type → Enter).
    // Cmd+K is a TOGGLE, so press exactly one modifier combo (pressing both would
    // open then immediately re-close it). Retry the other modifier only if the
    // first didn't surface the input (covers both macOS and Linux CI).
    const paletteInput = session.page.getByPlaceholder('Search commands...');
    await session.page.keyboard.press('Meta+k');
    if (!(await paletteInput.isVisible().catch(() => false))) {
      await session.page.keyboard.press('Control+k');
    }
    await expect(paletteInput).toBeVisible();
    await paletteInput.fill('Move to Origin');
    await paletteInput.press('Enter');

    // The cloud's real world center returns to ~origin AND the render offset is
    // zero — proving the recenter was baked, not left as a display transform.
    await expect.poll(async () => {
      const e = await readEntry();
      if (!e) return null;
      // The fixture min-corner sits at ~(-0.3,-0.3); after centering the cloud on
      // the origin its min-corner world x is ~ -0.3, and net offset is 0.
      return { worldNearZero: Math.abs(e.world.x) < 1.0, netZero: Math.abs(e.net.x) < 1e-3 };
    }, { timeout: 60_000, intervals: [250, 500, 1000] }).toEqual({ worldNearZero: true, netZero: true });
  });

  // While the Translate panel is open, other tools must be locked so the user
  // can't run a compute op against a half-applied (unbaked) draft. The toolbar
  // buttons for those tools disable; the button carries data-disabled/aria.
  test('other tools are locked while the Translate panel is open', async () => {
    await importTiny();

    // Triangulate is enabled before opening Translate.
    const triBtn = session.page.getByTestId('tool-triangulate');
    await expect(triBtn).toBeEnabled();

    await openTranslateTool();

    // Now it's disabled (the guard marks every non-translate tool unavailable).
    await expect(triBtn).toBeDisabled();

    // Closing Translate (Cancel) re-enables it.
    await session.page.getByTestId('translate-cancel').click();
    await expect(session.page.getByTestId('translate-panel')).toBeHidden();
    await expect(triBtn).toBeEnabled();
  });

  // A typed rotation is a DRAFT: the viewport rotates live but geometry is not
  // baked until OK. Cancel must revert it (net offset back to baseline, world
  // position unchanged) exactly like a translation draft.
  test('Cancel discards a pending rotation (nothing baked)', async () => {
    await importTiny();
    const before = await readEntryWhenReady();

    await openTranslateTool();
    // Rotate 90° about Z. The fixture cylinder is centered at (x,y)=(0,0), so a
    // rotation about its own bbox center leaves the octree object's WORLD position
    // essentially unchanged — the guard here is the Cancel/no-bake contract, which
    // the rotation-bakes test complements with a real geometry assertion.
    await typeRotate('z', '90');
    await expect(session.page.getByTestId('translate-panel')).toHaveAttribute('data-dirty', 'true');

    await session.page.getByTestId('translate-cancel').click();
    await expect(session.page.getByTestId('translate-panel')).toBeHidden();
    const after = await readEntryWhenReady();
    // Nothing baked: net offset ~0 and world position within a hair of baseline.
    expect(Math.abs(after.net.x)).toBeLessThan(1e-3);
    expect(Math.abs(after.world.x - before.world.x)).toBeLessThan(1e-2);
    expect(Math.abs(after.world.y - before.world.y)).toBeLessThan(1e-2);
  });

  // The motivating correctness property for rotation: a rotated cloud fed to a
  // COMPUTE tool must be computed at its rotated pose (same silent-offset class
  // of bug the translate test guards). We rotate 90° about Z around a scene
  // origin OFF the cloud center, bake, triangulate, and assert on real exported
  // OBJ vertex coordinates — which a render-only rotation could never produce.
  test('a rotated cloud (about a scene origin) triangulates at its rotated pose', async () => {
    const { page } = session;

    const cloudRow = await importTiny();

    // Set a scene origin at (2, 0, 0) — well off the cylinder (centered at origin,
    // x,y ∈ [-0.3, 0.3]). A +90° Z-rotation about (2,0,0) maps a world point
    // (x, y) → (2 − y, x − 2): new X ∈ [1.7, 2.3] (centered ~2) and new Y ∈
    // [-2.3, -1.7] (centered ~−2). That off-origin fingerprint is what we assert.
    await setSceneOrigin('2', '0', '0');

    await openTranslateTool();
    await typeRotate('z', '90');
    await clickOK();
    // Wait for the bake: the rotated octree rebuild lands (net back to ~0).
    await expect.poll(async () => {
      const e = await readEntry();
      return e ? Math.round(e.net.x * 1000) / 1000 : null;
    }, { timeout: 60_000, intervals: [250, 500, 1000] }).toBe(0);

    // Triangulate (Poisson depth 7, matching the other specs on this fixture).
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('tool-triangulate').click();
    const triModal = page.getByTestId('triangulation-popup');
    await expect(triModal).toBeVisible();
    await triModal.getByTestId('triangulation-method').selectOption('poisson');
    await triModal.getByTestId('triangulation-poisson-depth').fill('7');
    await triModal.getByTestId('triangulation-run-button').click();

    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });

    await meshRow.click();
    await expect(meshRow).toHaveAttribute('data-selected', 'true');
    const obj = await exportMeshObj('rotated');
    const verts = obj.split('\n')
      .filter((l) => l.startsWith('v '))
      .map((l) => l.slice(2).trim().split(/\s+/).map(Number))
      .filter((c) => c.length >= 2 && c.every((n) => Number.isFinite(n)));
    expect(verts.length).toBeGreaterThan(0);
    const xs = verts.map((c) => c[0]);
    const ys = verts.map((c) => c[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);

    // After the +90°-about-(2,0,0) rotation the mesh's X sits around 2 and its Y
    // around −2 (analytic centers; Poisson's surface extraction overshoots, so we
    // assert the band CENTERS rather than tight min/max) — decisively NOT the
    // original span (x,y ∈ [-0.3, 0.3], both centered ~0). Together these prove a
    // real rotation about the off-center origin was baked into geometry (a
    // render-only rotation would export the ORIGINAL coordinates).
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    expect(cx).toBeGreaterThan(1.5);
    expect(cx).toBeLessThan(2.5);
    expect(cy).toBeGreaterThan(-2.5);
    expect(cy).toBeLessThan(-1.5);
  });

  // The scene origin is viewport-level (rotation pivot + orbit center), NOT tied
  // to a selected scan — so its tool must be available on an EMPTY scene, and you
  // can set it by typing coordinates with nothing loaded. Guards against the tool
  // being (re)gated on a cloud selection.
  test('Set Scene Origin is available with no scan and accepts typed coordinates', async () => {
    const { page } = session;
    // beforeEach reset to a fresh (empty) scene; do NOT import anything.
    const btn = page.getByTestId('tool-set-scene-origin');
    await expect(btn).toBeEnabled();

    await btn.click();
    await expect(page.getByTestId('scene-origin-panel')).toBeVisible();
    // Type an origin with no geometry present.
    for (const [axis, v] of [['x', '3'], ['y', '-2'], ['z', '1']] as const) {
      const input = page.getByTestId(`scene-origin-input-${axis}`);
      await input.fill(v);
      await input.press('Enter');
    }
    await expect(page.getByTestId('scene-origin-panel')).toHaveAttribute('data-has-origin', 'true');
    expect(parseFloat(await page.getByTestId('scene-origin-input-x').inputValue())).toBeCloseTo(3, 3);
    expect(parseFloat(await page.getByTestId('scene-origin-input-y').inputValue())).toBeCloseTo(-2, 3);
    // Clean up so the shared-app next test starts without a lingering origin/panel.
    await page.getByTestId('scene-origin-clear').click();
    await page.getByTestId('scene-origin-close').click();
    await expect(page.getByTestId('scene-origin-panel')).toBeHidden();
  });

  // Click-to-place: opening the panel arms pick mode, and clicking the viewport
  // sets the origin and populates the panel's X/Y/Z fields (surface-snap or
  // ground-plane).
  test('Set Scene Origin — click-to-place sets the origin from a viewport click', async () => {
    const { page } = session;
    await importTiny();

    // Opening the panel ARMS click-to-place on its own — no second click on the
    // Pick button needed. Arming is not placing, so there is still no override.
    const panel = await openSceneOriginPanel();
    await expect(panel).toHaveAttribute('data-has-origin', 'false');

    // The Pick button is still a real toggle: off and back on again.
    await page.getByTestId('scene-origin-pick').click();
    await expect(panel).toHaveAttribute('data-place-mode', 'false');
    await page.getByTestId('scene-origin-pick').click();
    await expect(panel).toHaveAttribute('data-place-mode', 'true');
    await expect(panel).toHaveAttribute('data-has-origin', 'false');

    // Snapshot the camera BEFORE picking: placing an origin must NOT move the
    // view (it's the rotation pivot only, not an orbit re-target).
    const camState = () => page.evaluate(() => (window as any).__getCameraState?.());
    const camBefore = await camState();

    // Click OFF-center (so a would-be orbit re-target would be clearly visible)
    // — the cylinder still fills enough of the view to hit it.
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.45);

    // The pick set an origin (marker + fields populated) and disarmed place mode.
    await expect(page.getByTestId('scene-origin-panel')).toHaveAttribute('data-has-origin', 'true');
    await expect(page.getByTestId('scene-origin-panel')).toHaveAttribute('data-place-mode', 'false');
    // The X field now holds a finite number (the picked world X). The cylinder is
    // near the origin, so it should be within a small window of 0.
    const xVal = await page.getByTestId('scene-origin-input-x').inputValue();
    expect(Number.isFinite(parseFloat(xVal))).toBe(true);
    expect(Math.abs(parseFloat(xVal))).toBeLessThan(2);

    // The camera did NOT move: both its position and orbit target are unchanged.
    const camAfter = await camState();
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(dist(camBefore.position, camAfter.position)).toBeLessThan(1e-3);
    expect(dist(camBefore.target, camAfter.target)).toBeLessThan(1e-3);
  });

  // Open the Scene Origin panel. Opening AUTO-ARMS click-to-place (placing the
  // pivot by clicking is the common reason to open it), which mounts a
  // full-viewport picker plane that swallows every canvas click and makes the
  // marker itself non-interactive. Tests about the marker/gizmo therefore pass
  // `armed: false` to toggle it back off first — otherwise their very first
  // viewport click would be eaten by the picker.
  async function openSceneOriginPanel({ armed = true }: { armed?: boolean } = {}) {
    const { page } = session;
    await page.getByTestId('tool-set-scene-origin').click();
    const panel = page.getByTestId('scene-origin-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-place-mode', 'true');
    if (!armed) {
      await page.getByTestId('scene-origin-pick').click();
      await expect(panel).toHaveAttribute('data-place-mode', 'false');
    }
    return panel;
  }

  // Read the three origin inputs as numbers. Requires the panel to be open.
  async function readOriginFields(): Promise<[number, number, number]> {
    const { page } = session;
    const v = await Promise.all((['x', 'y', 'z'] as const).map(async (axis) =>
      parseFloat(await page.getByTestId(`scene-origin-input-${axis}`).inputValue())));
    return [v[0], v[1], v[2]];
  }

  // Project a WORLD point to viewport pixels through the live camera (the same
  // hook the gizmo-drag tests use), so a click lands exactly where the renderer
  // drew something.
  async function worldToScreen(world: [number, number, number]) {
    const p = await session.page.evaluate(
      (w) => (window as any).__worldToScreen(w),
      world,
    ) as { x: number; y: number; visible: boolean };
    if (!p.visible) throw new Error(`world point ${world} is not on screen`);
    return p;
  }

  // A viewport point that is (a) actually the canvas — the corners are covered by
  // the floating toolbars/panels, whose clicks never reach three.js at all — and
  // (b) far from the scene center, so nothing is drawn there. Used to test
  // click-on-empty-space behavior.
  async function emptyViewportPoint() {
    const { page } = session;
    const box = (await page.locator('canvas').first().boundingBox())!;
    const candidates: [number, number][] = [
      [0.15, 0.75], [0.15, 0.5], [0.3, 0.85], [0.5, 0.9], [0.7, 0.85],
    ];
    for (const [fx, fy] of candidates) {
      const x = box.x + box.width * fx;
      const y = box.y + box.height * fy;
      const onCanvas = await page.evaluate(
        ([px, py]) => document.elementFromPoint(px, py)?.tagName === 'CANVAS',
        [x, y],
      );
      if (onCanvas) return { x, y };
    }
    throw new Error('no uncovered canvas point found');
  }

  // The origin marker is drawn as a ring ~12 px in radius, and its PICK target is
  // the ring band only (the middle is deliberately click-through so the marker
  // can't steal centre clicks from cloud/mesh selection). So click 12 px off the
  // center, not on it.
  const RING_PX = 12;

  // Click the marker the way a HAND does: move onto it, let the pointer settle,
  // then press and release without travelling.
  //
  // `page.mouse.click()` teleports the pointer from wherever it last was (here,
  // a panel button hundreds of px away) and fires down/up with no intervening
  // move. r3f then reports that jump as the event's `delta`, and the marker's
  // own handler drops any click with `delta > 4` — the guard that stops the tail
  // of a camera orbit from selecting whatever it lands on. So a teleported click
  // is discarded even though the raycast hit the marker (the cursor does turn to
  // 'pointer'), and the test fails while the feature works.
  //
  // Whether the teleport is coalesced into a move first is timing-dependent,
  // which is why this passed on macOS and failed on CI's headless Linux for
  // MONTHS of green runs before it started failing — nothing about the marker
  // changed. Real users always generate the moves; only a synthetic click skips
  // them.
  async function clickMarkerAt(x: number, y: number) {
    const { page } = session;
    await page.mouse.move(x, y);
    // A second move at rest zeroes the accumulated travel r3f reports as delta.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.up();
  }

  // The origin now always exists — with no user placement it sits at the scene
  // center, and its marker is up from the moment content loads. Guards against a
  // regression to "invisible until you set one", and against the default drifting
  // off the scene.
  test('Scene Origin defaults to the ground-anchored scene center with no user placement', async () => {
    const { page } = session;
    await importTiny();

    await page.getByTestId('tool-set-scene-origin').click();
    const panel = page.getByTestId('scene-origin-panel');
    await expect(panel).toBeVisible();
    // No override yet, but the fields are populated and the marker is drawn.
    await expect(panel).toHaveAttribute('data-has-origin', 'false');
    await expect(panel).toHaveAttribute('data-marker-visible', 'true');

    const origin = await readOriginFields();
    const viewerEl = page.locator('[data-scene-bounds-size]');
    const sceneCenter = (await viewerEl.getAttribute('data-scene-center'))!
      .split(',').map(parseFloat);
    const sceneMinZ = parseFloat((await viewerEl.getAttribute('data-scene-min-z'))!);
    // Laterally the scene centre...
    // (the data attributes are rounded to 1 dp, hence the loose tolerance)
    expect(Math.abs(origin[0] - sceneCenter[0])).toBeLessThan(0.15);
    expect(Math.abs(origin[1] - sceneCenter[1])).toBeLessThan(0.15);
    // ...but vertically the FLOOR, not the mid-height: these scenes stand on the
    // ground, and this point is both the orbit pivot and the camera's default
    // look-at, so a mid-height default would put both in empty air.
    expect(Math.abs(origin[2] - sceneMinZ)).toBeLessThan(0.15);
    // Guard against the two coinciding and making the assertion vacuous — the
    // fixture must have real vertical extent for this to mean anything.
    expect(Math.abs(sceneCenter[2] - sceneMinZ)).toBeGreaterThan(0.2);

    // Reset is a no-op offer while the default is in force.
    await expect(page.getByTestId('scene-origin-clear')).toBeDisabled();

    // Typing an override flips data-has-origin and enables Reset; resetting puts
    // the origin back on the scene center.
    const xInput = page.getByTestId('scene-origin-input-x');
    await xInput.fill(String(origin[0] + 4));
    await xInput.press('Enter');
    await expect(panel).toHaveAttribute('data-has-origin', 'true');
    await page.getByTestId('scene-origin-clear').click();
    await expect(panel).toHaveAttribute('data-has-origin', 'false');
    expect(Math.abs((await readOriginFields())[0] - origin[0])).toBeLessThan(1e-3);

    await page.getByTestId('scene-origin-close').click();
  });

  // On an empty scene App draws its "Drag scan files here" hint across the middle
  // of the viewport, where the default origin projects. The marker must stay down
  // until something is loaded, then appear on its own.
  test('Scene Origin marker stays down while the empty-viewer hint is showing', async () => {
    const { page } = session;
    // beforeEach reset to a fresh (empty) scene; do NOT import yet.
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // Disarm click-to-place: this test's viewport clicks are about marker
    // selection, and an armed picker would swallow them.
    const panel = await openSceneOriginPanel({ armed: false });
    // The origin still exists and is editable — only its marker is suppressed.
    await expect(panel).toHaveAttribute('data-marker-visible', 'false');
    const viewer = page.locator('[data-scene-bounds-size]');
    // Empty scene: bounds fall back to a ±5 box at the world origin, so the
    // ground-anchored default origin is laterally (0,0) and vertically that
    // box's floor.
    expect(await readOriginFields()).toEqual([0, 0, -5]);
    // (__worldToScreen isn't installed on an empty scene, but the default camera
    // looks straight down its own -Z at the world origin, so the suppressed
    // marker would be drawn dead center.) Clicking there selects nothing.
    const box = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.click(box.x + box.width / 2 + RING_PX, box.y + box.height / 2);
    await expect(viewer).toHaveAttribute('data-origin-selected', 'false');

    // Loading content brings the marker up with no further interaction, and it
    // is a live click target from that moment. (Close the panel first — opening
    // the import tool would close it anyway, and the reopen re-reads the state.)
    await page.getByTestId('scene-origin-close').click();
    await importTiny();
    await expect(page.getByTestId('empty-viewer-hint')).toBeHidden();
    await openSceneOriginPanel({ armed: false });
    await expect(panel).toHaveAttribute('data-marker-visible', 'true');
    const loaded = await worldToScreen(await readOriginFields());
    await clickMarkerAt(loaded.x + RING_PX, loaded.y);
    await expect(viewer).toHaveAttribute('data-origin-selected', 'true');

    await page.getByTestId('scene-origin-close').click();
  });

  // The view turns about the scene origin, NOT about the pan-following
  // OrbitControls target. Stock OrbitControls translates its target on every pan,
  // which silently moved the rotation center away from the point the marker
  // claims is the pivot. The invariant here: after panning the view well off the
  // origin, an orbit keeps the camera's distance to the ORIGIN fixed (a rotation
  // about a point preserves distance to it) — under target-centered rotation that
  // distance changes.
  test('Scene Origin is the camera pivot: panning does not move the rotation center', async () => {
    const { page } = session;
    await importTiny();

    const camState = () => page.evaluate(() => (window as any).__getCameraState?.()) as Promise<{
      position: number[]; target: number[]; displayOffset: number[];
    }>;
    await page.getByTestId('tool-set-scene-origin').click();
    await expect(page.getByTestId('scene-origin-panel')).toBeVisible();
    const origin = await readOriginFields();
    await page.getByTestId('scene-origin-close').click();

    const box = (await page.locator('canvas').first().boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Pivot in DISPLAY space — the frame the camera lives in.
    const pivotDisplay = async () => {
      const s = await camState();
      return [
        origin[0] - s.displayOffset[0],
        origin[1] - s.displayOffset[1],
        origin[2] - s.displayOffset[2],
      ];
    };
    const dist = (a: number[], b: number[]) =>
      Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

    // Pan hard with the right button (OrbitControls' pan), which drags the orbit
    // target off the origin.
    const beforePan = await camState();
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 160, cy + 90, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    const afterPan = await camState();
    const P = await pivotDisplay();
    // The pan really moved the target (otherwise the test proves nothing)...
    expect(dist(afterPan.target, beforePan.target)).toBeGreaterThan(0.1);
    // ...and it is now well away from the pivot.
    expect(dist(afterPan.target, P)).toBeGreaterThan(0.1);
    // Panning must not drag the origin itself along.
    await page.getByTestId('tool-set-scene-origin').click();
    expect(await readOriginFields()).toEqual(origin);
    await page.getByTestId('scene-origin-close').click();

    // Now orbit with the left button.
    const radiusBefore = dist(afterPan.position, P);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 40, { steps: 10 });
    await page.mouse.up();
    const afterOrbit = await camState();

    // The camera moved (an orbit happened)...
    expect(dist(afterOrbit.position, afterPan.position)).toBeGreaterThan(0.05);
    // ...on a sphere centered on the ORIGIN, not on the panned target.
    const radiusAfter = dist(afterOrbit.position, P);
    expect(Math.abs(radiusAfter - radiusBefore)).toBeLessThan(radiusBefore * 0.02);
    // The view stayed rigid: camera→target distance is preserved too, so the
    // orbit is a rotation of the whole view rather than a re-target.
    expect(Math.abs(
      dist(afterOrbit.position, afterOrbit.target) - dist(afterPan.position, afterPan.target),
    )).toBeLessThan(1e-2);
  });

  // The marker can be hidden without disturbing the pivot — and once hidden it
  // is no longer a click target (no invisible hit zone left behind).
  test('Scene Origin marker can be hidden, which also disarms its click target', async () => {
    const { page } = session;
    await importTiny();

    // Disarm click-to-place — this test clicks the marker, not the picker.
    const panel = await openSceneOriginPanel({ armed: false });
    const origin = await readOriginFields();
    const viewer = page.locator('[data-scene-bounds-size]');

    // Visible: clicking the ring selects the origin (raises its gizmo).
    const p = await worldToScreen(origin);
    await clickMarkerAt(p.x + RING_PX, p.y);
    await expect(viewer).toHaveAttribute('data-origin-selected', 'true');

    // Hiding the marker drops the selection AND the hit target...
    await page.getByTestId('scene-origin-show-marker').uncheck();
    await expect(panel).toHaveAttribute('data-marker-visible', 'false');
    await expect(viewer).toHaveAttribute('data-origin-selected', 'false');
    await clickMarkerAt(p.x + RING_PX, p.y);
    await expect(viewer).toHaveAttribute('data-origin-selected', 'false');

    // ...while the origin itself is untouched.
    expect(await readOriginFields()).toEqual(origin);

    await page.getByTestId('scene-origin-show-marker').check();
    await expect(panel).toHaveAttribute('data-marker-visible', 'true');
    await page.getByTestId('scene-origin-close').click();
  });

  // Clicking the marker raises a translation gizmo; dragging an arrow MOVES the
  // origin along that axis (and only that axis); clicking empty space puts the
  // gizmo away. This is the drag-the-pivot path — the numeric fields are the
  // fallback, not the primary interaction.
  test('Scene Origin marker: click selects it, dragging its gizmo moves the origin', async () => {
    const { page } = session;
    await importTiny();

    // Disarm click-to-place — this test drags the marker's gizmo, and an armed
    // picker would eat the selecting click.
    await openSceneOriginPanel({ armed: false });
    const before = await readOriginFields();
    const viewer = page.locator('[data-scene-bounds-size]');

    // Select the marker by clicking its ring band.
    const center = await worldToScreen(before);
    await clickMarkerAt(center.x + RING_PX, center.y);
    await expect(viewer).toHaveAttribute('data-origin-selected', 'true');

    // Pick whichever axis projects longest on screen — the camera's default
    // three-quarter view leaves one axis nearly edge-on, and dragging an arrow
    // that's a few pixels long is not a meaningful test.
    const dirs = await Promise.all([0, 1, 2].map(async (i) => {
      const tip: [number, number, number] = [before[0], before[1], before[2]];
      tip[i] += 1;
      const q = await worldToScreen(tip);
      return { dx: q.x - center.x, dy: q.y - center.y };
    }));
    let best = 0;
    dirs.forEach((d, i) => {
      if (Math.hypot(d.dx, d.dy) > Math.hypot(dirs[best].dx, dirs[best].dy)) best = i;
    });
    const len = Math.hypot(dirs[best].dx, dirs[best].dy);
    const unit = { x: dirs[best].dx / len, y: dirs[best].dy / len };

    // Grab the ARROWHEAD (the widest part of the arrow, ~0.925 of the 90 px
    // gizmo) and drag 60 px further along the same screen direction.
    const grab = { x: center.x + unit.x * 83, y: center.y + unit.y * 83 };
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    // Several moves: the drag handler treats the first as the baseline sample.
    await page.mouse.move(grab.x + unit.x * 20, grab.y + unit.y * 20, { steps: 4 });
    await page.mouse.move(grab.x + unit.x * 60, grab.y + unit.y * 60, { steps: 6 });
    await page.mouse.up();

    // The dragged axis moved in the drag direction; the other two did not.
    const after = await readOriginFields();
    expect(after[best]).toBeGreaterThan(before[best] + 0.05);
    for (let i = 0; i < 3; i++) {
      if (i !== best) expect(Math.abs(after[i] - before[i])).toBeLessThan(1e-3);
    }
    // A drag counts as a user placement, so Reset is now live.
    await expect(page.getByTestId('scene-origin-panel')).toHaveAttribute('data-has-origin', 'true');
    // The drag must NOT have deselected (its mouse-up lands on empty space).
    await expect(viewer).toHaveAttribute('data-origin-selected', 'true');

    // Clicking empty space, well clear of the cloud and the gizmo, deselects.
    const empty = await emptyViewportPoint();
    await page.mouse.click(empty.x, empty.y);
    await expect(viewer).toHaveAttribute('data-origin-selected', 'false');
    // Deselecting leaves the origin where the drag put it.
    expect(await readOriginFields()).toEqual(after);

    await page.getByTestId('scene-origin-clear').click();
    await page.getByTestId('scene-origin-close').click();
  });

  // Import the Helios scan XML (params + attached tiny.xyz data), returning its
  // row. The scan carries a defined scanner origin (0.5, -1.0, 0.25).
  async function importScanWithOrigin() {
    const { app, page } = session;
    await stubOpenDialog(app, SCAN_XML);
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 15_000 });
    await completeImportWizard(page);

    // Find the origin-bearing row (the only one with a non-empty data-scan-origin
    // — works whether or not a plain target cloud was imported first), then
    // re-bind by its STABLE data-scan-id: the origin/cacheId attributes change
    // when a translate bakes, so a selector keyed on origin would go stale.
    const originRow = page.locator('[data-testid="scan-row"][data-scan-origin="0.500,-1.000,0.250"]');
    await expect(originRow).toBeVisible({ timeout: 20_000 });
    const scanId = await originRow.getAttribute('data-scan-id');
    const row = page.locator(`[data-testid="scan-row"][data-scan-id="${scanId}"]`);
    await expect(row).toHaveAttribute('data-has-params', 'true');
    // A freshly imported scan is auto-selected.
    await expect(row).toHaveAttribute('data-selected', 'true');
    // Wait for this row's octree to be registered (its cacheId keys the entry).
    await expect.poll(async () => {
      const cacheId = await row.getAttribute('data-octree-cache-id');
      if (!cacheId) return false;
      return page.evaluate((id) => {
        const reg = (window as any).__octreePositions;
        return !!(reg && reg[id]);
      }, cacheId);
    }, { timeout: 20_000, intervals: [100, 250, 500] }).toBe(true);
    return row;
  }

  // The scanner ORIGIN must travel WITH the cloud when a translate is baked —
  // otherwise the recorded scanner position no longer matches the points and
  // every origin-dependent op (LAD, triangulation crop, the panel readout) is
  // wrong. Translate +5 in X and assert the origin moves 0.5 → 5.5.
  test('a baked translate moves the scan origin with the cloud', async () => {
    const row = await importScanWithOrigin();

    // Capture the octree's pre-bake cacheId so we can prove the geometry bake
    // actually ran (a fresh cacheId) — not just that the origin metadata changed.
    const cacheBefore = await row.getAttribute('data-octree-cache-id');

    await openTranslateTool();
    await typeTranslate('x', '5');
    await clickOK();

    // The origin must shift by +5 in X: 0.5 → 5.5, Y/Z unchanged.
    await expect(row).toHaveAttribute('data-scan-origin', '5.500,-1.000,0.250', { timeout: 60_000 });

    // Sanity: the geometry bake actually happened (octree rebuilt → new cacheId),
    // so the origin moved WITH a real geometry change, not on its own.
    await expect(async () => {
      const cacheAfter = await row.getAttribute('data-octree-cache-id');
      expect(cacheAfter).toBeTruthy();
      expect(cacheAfter).not.toBe(cacheBefore);
    }).toPass({ timeout: 60_000 });
  });

  // Cloud-to-cloud ICP moves the whole source cloud by a rigid transform, so the
  // scanner origin must ride the SAME transform (not just a translation — ICP can
  // rotate). Setup: import the origin-bearing scan (source) AND a plain copy
  // (target) at the SAME place, then translate+bake the SOURCE +5 in X so it is
  // genuinely misaligned (origin now at 5.5). ICP should pull it back onto the
  // target (~ -5), returning the origin to ~0.5. Asserting the origin tracked the
  // recovered transform is what proves the ICP origin fix.
  test('cloud-to-cloud ICP moves the scan origin with the source cloud', async () => {
    const { app, page } = session;

    // Target: a plain copy of tiny.xyz (no origin needed), imported first.
    await importFiles(app, page, 'import-auto', FIXTURE);
    await completeImportWizard(page);
    // Source: the origin-bearing scan XML (origin 0.5,-1.0,0.25 + tiny.xyz data).
    const sourceRow = await importScanWithOrigin();

    // Misalign the SOURCE: translate +5 in X and bake. Origin → 5.5.
    await openTranslateTool();
    await typeTranslate('x', '5');
    await clickOK();
    await expect(sourceRow).toHaveAttribute('data-scan-origin', '5.500,-1.000,0.250', { timeout: 60_000 });

    // Deselect so the multi-input Align dialog opens cleanly, then run ICP.
    await page.evaluate(() => (window as any).__runToolCommand?.('deselect-all'));
    await page.evaluate(() => (window as any).__runToolCommand?.('cloud-align'));
    const dialog = page.getByTestId('align-dialog');
    await expect(dialog).toBeVisible();

    // target = the plain copy (row 0), source = the origin-bearing scan (row 1).
    await dialog.getByTestId('align-target-picker').getByTestId('picker-row').nth(0).click();
    await dialog.getByTestId('align-source-picker').getByTestId('picker-row').nth(1).click();
    await dialog.getByTestId('align-run').click();
    await expect(dialog).toBeHidden();

    // Alignment completes.
    const toast = page.locator('[data-testid="toast-success"]').last();
    await expect(toast.getByTestId('toast-title')).toContainText(/Cloud Alignment Complete/i, { timeout: 60_000 });

    // The origin rode the recovered transform back toward its original
    // (0.5, -1.0, 0.25). ICP on identical (offset) geometry recovers ~exactly
    // -5, so assert with a tolerance. The KEY assertion vs. the bug: the origin
    // is NOT still stranded at 5.5 — it followed the cloud.
    await expect.poll(async () => {
      const attr = await sourceRow.getAttribute('data-scan-origin');
      if (!attr) return null;
      const [x, y, z] = attr.split(',').map(Number);
      // "close to original AND far from the stranded 5.5" as a single boolean.
      return Math.abs(x - 0.5) < 0.5 && Math.abs(y + 1.0) < 0.5 && Math.abs(z - 0.25) < 0.5;
    }, { timeout: 60_000, intervals: [500, 1000] }).toBe(true);
  });
});
