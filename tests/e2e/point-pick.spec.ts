import { test, expect, type Locator } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { resetToFreshScene } from './helpers/resetApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURES = join(repoRoot, 'tests', 'e2e', 'fixtures');

// CloudCompare-style point picker: arm the tool, click a point, get a label
// anchored to it showing the point's coordinates and every scalar attribute.
//
// scalars.xyz is the fixture that matters here — a comma-headered,
// space-delimited XYZ whose three named scalar columns (Timestamp[s],
// Deviation[], Target Index[]) survive import as LAS extra dimensions in the
// octree and decode into named potree-core buffers. Its rows are a regular
// ramp, so a picked point's expected values are known exactly:
//
//   row 0: 0.0 0.0 0.00  ts=100.0  dev=0  target=1
//   row 1: 0.2 0.0 0.15  ts=102.5  dev=1  target=2
//   row 2: 0.4 0.0 0.30  ts=105.0  dev=2  target=3
//
// That exactness is the point: it's what proves potree hands back the REAL
// attribute values (not normalised or rescaled ones) at the picked index.
test.describe('point picker', () => {
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

  // Project a WORLD point to viewport pixels through the renderer's own camera,
  // so a click targets geometry wherever the current framing actually draws it.
  // Re-deriving the projection here instead would only have to disagree with the
  // real camera by a few pixels to miss a point.
  async function worldToScreenPx(world: [number, number, number]) {
    const pt = await session.page.evaluate(
      (w) => (window as any).__worldToScreen?.(w) ?? null,
      world,
    );
    if (!pt) throw new Error('__worldToScreen hook unavailable (camera not mounted?)');
    if (!pt.visible) {
      throw new Error(
        `world point ${JSON.stringify(world)} is outside the frustum ` +
        `(projected to ${pt.x.toFixed(1)},${pt.y.toFixed(1)})`,
      );
    }
    // A click that lands on a panel is swallowed by the DOM and never reaches
    // the picker, which reads as "clicked and nothing happened".
    const tag = await session.page.evaluate(
      (p) => (document.elementFromPoint(p.x, p.y) as HTMLElement | null)?.tagName?.toLowerCase() ?? null,
      { x: pt.x, y: pt.y },
    );
    if (tag !== 'canvas') {
      throw new Error(
        `projected ${JSON.stringify(world)} to (${pt.x.toFixed(1)}, ${pt.y.toFixed(1)}) but that ` +
        `pixel belongs to <${tag}>, not the canvas`,
      );
    }
    return pt as { x: number; y: number };
  }

  // Wait for the camera to stop moving before projecting: the auto-frame
  // animates after import, so a pixel computed mid-flight is stale by the time
  // the click lands.
  async function waitForCameraSettled() {
    // The auto-frame only runs once the cloud's bounds have registered, so wait
    // for it before checking for stability — otherwise "two identical polls" is
    // satisfied by the DEFAULT camera and every projection is computed against
    // a view that is about to move.
    await session.page.waitForFunction(
      () => (window as any).__getCameraState?.()?.framedContent === true,
      null,
      { timeout: 30_000 },
    );
    let last = '';
    for (let i = 0; i < 40; i++) {
      const now = await session.page.evaluate(
        () => JSON.stringify((window as any).__getCameraState?.() ?? null),
      );
      if (now !== 'null' && now === last) return;
      last = now;
      await session.page.waitForTimeout(100);
    }
  }

  // Click a viewport pixel the way a real pointer arrives at it: move first,
  // yield a frame, then press and release. The picker's drag guard measures
  // press→release travel, so press and release must be at the same pixel.
  async function clickViewport(x: number, y: number) {
    await session.page.mouse.move(x, y);
    await session.page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await session.page.mouse.down();
    await session.page.mouse.up();
  }

  const labels = () => session.page.getByTestId('picked-point-label');

  // Read one label's attribute rows as a slug → displayed-value map.
  async function attributesOf(label: Locator): Promise<Record<string, string>> {
    const rows = label.getByTestId('picked-point-attribute');
    const entries = await rows.evaluateAll((els) =>
      els.map((el) => [
        el.getAttribute('data-slug') ?? '',
        (el.lastElementChild?.textContent ?? '').trim(),
      ]),
    );
    return Object.fromEntries(entries);
  }

  // Read one label's coordinate rows as [X, Y, Z] world strings. The block is
  // [optional world/(local) header], X, Y, Z — so the last three rows are the
  // axes whether or not the cloud carries a global shift.
  async function worldCoordsOf(label: Locator): Promise<string[]> {
    return label.evaluate((el) => {
      const block = el.querySelector('[data-testid="picked-point-coords"]')!;
      return Array.from(block.children)
        .slice(-3)
        .map((r) => (r.children[1]?.textContent ?? '').trim());
    });
  }

  async function armPicker() {
    await session.page.getByTestId('tool-point-pick').click();
    await expect(session.page.getByTestId('point-picker-panel')).toHaveAttribute('data-armed', 'true');
  }

  async function importScalars() {
    await importFiles(session.app, session.page, 'import-point-cloud', join(FIXTURES, 'scalars.xyz'));
    await completeImportWizard(session.page);
    const row = session.page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '60');
    await waitForCameraSettled();
  }

  test('labels a clicked point with its coordinates and every scalar attribute', async () => {
    await importScalars();
    await armPicker();

    // Row 2 of the fixture, chosen over row 0 so a wrong-row pick can't be
    // masked by all-zero coordinates.
    const px = await worldToScreenPx([0.4, 0.0, 0.3]);
    await clickViewport(px.x, px.y);

    await expect(labels()).toHaveCount(1, { timeout: 10_000 });
    const label = labels().first();
    await expect(label.getByTestId('picked-point-scan')).toHaveText('scalars.xyz');

    // Coordinates: the fixture has no global shift, so world is the only column
    // and it must reproduce the source row to millimetre precision.
    expect(await worldCoordsOf(label)).toEqual(['0.400', '0.000', '0.300']);

    // Attributes: the exact values from that row. 'Timestamp[s]' and
    // 'Target Index[]' auto-detect into the canonical multi-return slugs;
    // 'Deviation[]' takes the generic sanitised slug.
    const attrs = await attributesOf(label);
    expect(attrs).toMatchObject({
      timestamp: '105',
      Deviation: '2',
      target_index: '3',
    });
  });

  test('reports true intensity while a scalar colour mode is active', async () => {
    // Colouring by a scalar ALIASES that scalar's buffer into each tile's
    // `intensity` attribute (that's how the potree gradient shader reaches it).
    // potree's picker reports a value for every named attribute, so without the
    // saved-original backup the picker would read the aliased scalar and label
    // it "intensity" — silently wrong, and only while a scalar mode is on.
    await importScalars();

    await session.page.getByRole('button', { name: 'Display' }).click();
    const colorMode = session.page.getByTestId('display-color-mode');
    await expect(colorMode).toBeVisible();
    await colorMode.selectOption('scalar:timestamp');
    // The octree remounts with a fresh material on a colour-mode change.
    await session.page.waitForTimeout(1500);
    await waitForCameraSettled();

    await armPicker();
    const px = await worldToScreenPx([0.4, 0.0, 0.3]);
    await clickViewport(px.x, px.y);
    await expect(labels()).toHaveCount(1, { timeout: 10_000 });

    const attrs = await attributesOf(labels().first());
    // The scalar itself still reads correctly under its own slug…
    expect(attrs.timestamp).toBe('105');
    // …and intensity is NOT that value. scalars.xyz carries no intensity
    // column, so PotreeConverter's default LAS schema leaves it at 0.
    expect(attrs.intensity).toBe('0');
  });

  test('accumulates labels, dismisses one, and clears all', async () => {
    await importScalars();
    await armPicker();

    for (const world of [[0.2, 0, 0.15], [0.4, 0, 0.3], [0.6, 0, 0.45]] as [number, number, number][]) {
      const px = await worldToScreenPx(world);
      await clickViewport(px.x, px.y);
    }
    await expect(labels()).toHaveCount(3, { timeout: 10_000 });
    await expect(session.page.getByTestId('point-picker-panel'))
      .toHaveAttribute('data-picked-count', '3');

    // Dismissing one leaves the others alone — and specifically leaves the
    // RIGHT ones: the middle label goes, the outer two stay.
    const middle = labels().nth(1);
    const middleCoords = (await worldCoordsOf(middle)).join(',');
    await middle.getByTestId('picked-point-dismiss').click();
    await expect(labels()).toHaveCount(2);
    const remaining = await Promise.all([
      worldCoordsOf(labels().nth(0)),
      worldCoordsOf(labels().nth(1)),
    ]);
    expect(remaining.map((c) => c.join(','))).not.toContain(middleCoords);

    await session.page.getByTestId('point-picker-clear-all').click();
    await expect(labels()).toHaveCount(0);
    await expect(session.page.getByTestId('point-picker-panel'))
      .toHaveAttribute('data-picked-count', '0');
  });

  test('a drag orbits the camera instead of dropping a label', async () => {
    await importScalars();
    await armPicker();

    const px = await worldToScreenPx([0.4, 0.0, 0.3]);
    await session.page.mouse.move(px.x, px.y);
    await session.page.mouse.down();
    await session.page.mouse.move(px.x + 60, px.y + 40, { steps: 8 });
    await session.page.mouse.up();

    await session.page.waitForTimeout(300);
    await expect(labels()).toHaveCount(0);
  });

  test('reports both world and local coordinates for a globally shifted cloud', async () => {
    // utm-tree.xyz sits at X≈545000, Y≈4183000, so the wizard auto-suggests a
    // global shift and leaves it enabled. The stored/local frame is then small
    // while the world frame still matches the source file — the picker must
    // show both, and they must differ by exactly the shift.
    await importFiles(session.app, session.page, 'import-point-cloud', join(FIXTURES, 'utm-tree.xyz'));
    await completeImportWizard(session.page);
    const row = session.page.locator('[data-testid="scan-row"][data-scan-name="utm-tree.xyz"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '192');
    await waitForCameraSettled();

    // IMPORTANT: the scene renders the STORED frame. `worldShift` is subtracted
    // from the points at import, so the true file coordinate (545000.3, …) is
    // nowhere near where the cloud is drawn, and __worldToScreen (which only
    // undoes the render-only displayOffset) can't be fed a file coordinate.
    // Aim in the stored frame instead, using the bounds the camera reports.
    //
    // Fixture geometry: a 12-point ring per z-layer, 16 layers 0.1 m apart, with
    // each ring's first vertex at +X and centre Y. So (max X, centre Y,
    // min Z + 0.7) is a real vertex, mid-height on the shell facing the default
    // isometric camera. Its true file coordinate is (545000.3, 4183000, 100.7).
    const cam = await session.page.evaluate(() => (window as any).__getCameraState?.());
    const target: [number, number, number] = [
      cam.bounds.max[0],
      (cam.bounds.min[1] + cam.bounds.max[1]) / 2,
      cam.bounds.min[2] + 0.7,
    ];

    await armPicker();
    const px = await worldToScreenPx(target);
    await clickViewport(px.x, px.y);
    await expect(labels()).toHaveCount(1, { timeout: 10_000 });

    const label = labels().first();
    // Both columns are present: each coordinate row carries world then (local).
    const both = await label.evaluate((el) => {
      const block = el.querySelector('[data-testid="picked-point-coords"]')!;
      return Array.from(block.children).slice(-3).map((r) => ({
        world: (r.children[1]?.textContent ?? '').trim(),
        local: (r.children[2]?.textContent ?? '').trim().replace(/[()]/g, ''),
      }));
    });
    expect(both).toHaveLength(3);

    // World X/Y must be at UTM magnitude and match the source file; the local
    // frame must be small (that is what the shift bought). The difference is
    // the integer shift the importer applied.
    const worldX = parseFloat(both[0].world);
    const localX = parseFloat(both[0].local);
    const worldY = parseFloat(both[1].world);
    const localY = parseFloat(both[1].local);
    expect(worldX).toBeGreaterThan(5e5);
    expect(worldY).toBeGreaterThan(4e6);
    expect(Math.abs(localX)).toBeLessThan(1e4);
    expect(Math.abs(localY)).toBeLessThan(1e4);
    // The shift the importer applied is an integer per axis, so world − local
    // must come out whole.
    expect(Math.abs((worldX - localX) - Math.round(worldX - localX))).toBeLessThan(1e-2);
    expect(Math.abs((worldY - localY) - Math.round(worldY - localY))).toBeLessThan(1e-2);

    // The world readout must reproduce the SOURCE FILE row — that is the whole
    // point of adding the shift back. Tolerance is a centimetre: potree stores
    // positions quantised to the octree's scale.
    expect(Math.abs(worldX - 545000.3)).toBeLessThan(0.01);
    expect(Math.abs(worldY - 4183000.0)).toBeLessThan(0.01);
    expect(Math.abs(parseFloat(both[2].world) - 100.7)).toBeLessThan(0.01);

    // The local readout is the STORED frame — where the cloud is actually
    // drawn — so it must match the point we aimed at.
    expect(Math.abs(localX - target[0])).toBeLessThan(0.01);
    expect(Math.abs(parseFloat(both[2].local) - target[2])).toBeLessThan(0.01);

    // The label must also be anchored where the point is DRAWN, not at the
    // file coordinate: its leader-line dot has to land on the clicked pixel.
    // (Projecting `world` instead of `local` puts it millions of units away.)
    const dot = await session.page.evaluate(() => {
      const c = document.querySelector('[data-testid="picked-point-leaders"] circle') as SVGCircleElement;
      return { cx: parseFloat(c.getAttribute('cx') ?? 'NaN'), cy: parseFloat(c.getAttribute('cy') ?? 'NaN') };
    });
    const canvasBox = (await session.page.locator('canvas').boundingBox())!;
    expect(Math.abs(dot.cx - (px.x - canvasBox.x))).toBeLessThan(6);
    expect(Math.abs(dot.cy - (px.y - canvasBox.y))).toBeLessThan(6);
  });

  test('pausing hands viewport clicks back without discarding labels', async () => {
    // The panel opens ARMED, so its button's job is to pause — pressing it
    // must stop picking, not start it.
    await importScalars();
    await armPicker();
    const px = await worldToScreenPx([0.4, 0.0, 0.3]);
    await clickViewport(px.x, px.y);
    await expect(labels()).toHaveCount(1, { timeout: 10_000 });

    const panel = session.page.getByTestId('point-picker-panel');
    await session.page.getByTestId('point-picker-arm').click();
    await expect(panel).toHaveAttribute('data-armed', 'false');

    // Paused: a viewport click adds nothing, and the existing label survives.
    const px2 = await worldToScreenPx([0.6, 0.0, 0.45]);
    await clickViewport(px2.x, px2.y);
    await session.page.waitForTimeout(300);
    await expect(labels()).toHaveCount(1);

    // Resuming picks again.
    await session.page.getByTestId('point-picker-arm').click();
    await expect(panel).toHaveAttribute('data-armed', 'true');
    await clickViewport(px2.x, px2.y);
    await expect(labels()).toHaveCount(2, { timeout: 10_000 });
  });

  test('closing the panel disarms the tool but keeps the placed labels', async () => {
    await importScalars();
    await armPicker();

    const px = await worldToScreenPx([0.4, 0.0, 0.3]);
    await clickViewport(px.x, px.y);
    await expect(labels()).toHaveCount(1, { timeout: 10_000 });

    await session.page.getByTestId('point-picker-close').click();
    await expect(session.page.getByTestId('point-picker-panel')).toHaveCount(0);
    // The label survives — it is a placed annotation, not part of the tool UI.
    await expect(labels()).toHaveCount(1);

    // With the tool disarmed a viewport click must NOT add another label.
    const px2 = await worldToScreenPx([0.6, 0.0, 0.45]);
    await clickViewport(px2.x, px2.y);
    await session.page.waitForTimeout(300);
    await expect(labels()).toHaveCount(1);
  });
});
