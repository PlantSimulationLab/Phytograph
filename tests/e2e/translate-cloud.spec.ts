import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';

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

    // Capture the export blob (mesh OBJ export goes through a blob + anchor
    // click, not the Electron save dialog). Same interception as export-mesh.spec.
    await page.evaluate(() => {
      const textByUrl = new Map<string, Promise<string>>();
      const captured: { name: string; text: string }[] = [];
      (window as unknown as { __exportedBlobs: typeof captured }).__exportedBlobs = captured;

      const origCreate = URL.createObjectURL;
      URL.createObjectURL = function (obj: Blob | MediaSource): string {
        const url = origCreate.call(URL, obj);
        if (obj instanceof Blob) textByUrl.set(url, obj.text());
        return url;
      };
      const origAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        if (this.download) {
          const textPromise = textByUrl.get(this.href);
          if (textPromise) textPromise.then((text) => { captured.push({ name: this.download, text }); });
          return;  // suppress the real download
        }
        return origAnchorClick.call(this);
      };
    });

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

    // Export the mesh to OBJ and read its real vertex coordinates.
    await meshRow.click();
    await expect(meshRow).toHaveAttribute('data-selected', 'true');
    await page.evaluate(() => (window as any).__openExportPanel?.());
    await expect(page.getByTestId('export-modal')).toBeVisible();
    await page.getByTestId('export-mesh-obj').click();

    await expect.poll(async () => page.evaluate(
      () => ((window as unknown as { __exportedBlobs?: unknown[] }).__exportedBlobs ?? []).length,
    ), { timeout: 15_000, intervals: [100, 250, 500] }).toBeGreaterThan(0);

    const obj = await page.evaluate(
      () => (window as unknown as { __exportedBlobs: { name: string; text: string }[] })
        .__exportedBlobs[0].text,
    );

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
