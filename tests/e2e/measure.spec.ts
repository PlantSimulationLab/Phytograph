import { test, expect, type Locator } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { resetToFreshScene } from './helpers/resetApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURES = join(repoRoot, 'tests', 'e2e', 'fixtures');

// CloudCompare-style measurement, built as modes of the point picker: arm the
// tool, choose a mode, click points, read a number.
//
// scalars.xyz is what makes these assertions EXACT rather than approximate. Its
// rows step by (0.2, 0.0, 0.15), so:
//
//   row 0: 0.0 0.0 0.00
//   row 1: 0.2 0.0 0.15
//   row 2: 0.4 0.0 0.30
//
// One step is sqrt(0.2² + 0.15²) = sqrt(0.0625) = 0.25 EXACTLY, two steps are
// 0.5, and three consecutive rows are collinear so the angle at the middle one
// is 180°. The fixture is also a grid of rows at y = 0.0/0.6/1.2/1.8, which
// gives an exact 90° corner. Every number below is a closed form, not a
// tolerance — "a measurement appeared" would be a rubber stamp.
test.describe('measurement tool', () => {
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

  // ── Helpers (mirroring point-pick.spec.ts, which drives the same tool) ────

  // Project a WORLD point to viewport pixels through the renderer's own camera,
  // so a click targets geometry wherever the current framing actually draws it.
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

  async function waitForCameraSettled() {
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

  // Click a viewport pixel the way a real pointer arrives at it. The picker's
  // drag guard measures press→release travel, so both must be at one pixel.
  async function clickViewport(x: number, y: number) {
    await session.page.mouse.move(x, y);
    await session.page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await session.page.mouse.down();
    await session.page.mouse.up();
  }

  /** Click the point at a world coordinate, resolving its pixel first. */
  async function clickWorld(world: [number, number, number]) {
    const px = await worldToScreenPx(world);
    await clickViewport(px.x, px.y);
  }

  const panel = () => session.page.getByTestId('point-picker-panel');
  const measureLabels = () => session.page.getByTestId('measure-label');

  /** The headline number on a measurement bubble. */
  async function valueOf(label: Locator): Promise<string> {
    return (await label.getByTestId('measure-value').textContent() ?? '').trim();
  }

  async function importScalars() {
    await importFiles(session.app, session.page, 'import-point-cloud', join(FIXTURES, 'scalars.xyz'));
    await completeImportWizard(session.page);
    const row = session.page.locator('[data-testid="scan-row"][data-scan-name="scalars"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '60');
    await waitForCameraSettled();
  }

  /** Arm the tool and switch it into `mode`. */
  async function armIn(mode: 'inspect' | 'distance' | 'polyline' | 'angle') {
    await session.page.getByTestId('tool-point-pick').click();
    await expect(panel()).toHaveAttribute('data-armed', 'true');
    await session.page.getByTestId(`picker-mode-${mode}`).click();
    await expect(panel()).toHaveAttribute('data-measure-mode', mode);
  }

  // ── Tests ────────────────────────────────────────────────────────────────

  test('measures the exact distance between two points, with its components', async () => {
    await importScalars();
    await armIn('distance');

    // One ramp step: sqrt(0.2² + 0.15²) = 0.25 exactly.
    await clickWorld([0.2, 0.0, 0.15]);
    await expect(panel()).toHaveAttribute('data-pending-count', '1', { timeout: 10_000 });
    await clickWorld([0.4, 0.0, 0.3]);

    // The second click completes the pair, so it commits itself: one label, and
    // nothing left pending.
    await expect(measureLabels()).toHaveCount(1, { timeout: 10_000 });
    await expect(panel()).toHaveAttribute('data-pending-count', '0');
    await expect(panel()).toHaveAttribute('data-measurement-count', '1');

    const label = measureLabels().first();
    expect(await valueOf(label)).toBe('0.250');

    // Components, which are what distinguish a correct distance from a
    // coincidentally-right magnitude.
    await expect(label.getByTestId('measure-dx')).toContainText('0.200');
    await expect(label.getByTestId('measure-dy')).toContainText('0.000');
    await expect(label.getByTestId('measure-dz')).toContainText('0.150');
  });

  test('measures a two-point span across a gap, not just adjacent points', async () => {
    await importScalars();
    await armIn('distance');

    // Two ramp steps: 0.5 exactly. Guards against a measurement that silently
    // reports the nearest-neighbour spacing regardless of what was clicked.
    await clickWorld([0.0, 0.0, 0.0]);
    await clickWorld([0.4, 0.0, 0.3]);

    await expect(measureLabels()).toHaveCount(1, { timeout: 10_000 });
    expect(await valueOf(measureLabels().first())).toBe('0.500');
  });

  test('measures a polyline total and lists every segment', async () => {
    await importScalars();
    await armIn('polyline');

    await clickWorld([0.0, 0.0, 0.0]);
    await clickWorld([0.2, 0.0, 0.15]);
    await clickWorld([0.4, 0.0, 0.3]);

    // A polyline does NOT auto-commit — that is what makes it a polyline rather
    // than a distance. It stays pending until Enter closes it.
    await expect(panel()).toHaveAttribute('data-pending-count', '3', { timeout: 10_000 });
    await expect(measureLabels()).toHaveCount(0);

    await session.page.keyboard.press('Enter');

    await expect(measureLabels()).toHaveCount(1, { timeout: 10_000 });
    const label = measureLabels().first();
    expect(await valueOf(label)).toBe('0.500');
    await expect(label.getByTestId('measure-segment-count')).toContainText('2');

    const segs = await label.getByTestId('measure-segment').allTextContents();
    expect(segs).toHaveLength(2);
    for (const s of segs) expect(s).toContain('0.250');
  });

  test('measures a straight run as 180 degrees', async () => {
    await importScalars();
    await armIn('angle');

    // Three consecutive ramp rows are exactly collinear.
    await clickWorld([0.0, 0.0, 0.0]);
    await clickWorld([0.2, 0.0, 0.15]);
    await clickWorld([0.4, 0.0, 0.3]);

    await expect(measureLabels()).toHaveCount(1, { timeout: 10_000 });
    expect(await valueOf(measureLabels().first())).toBe('180.0°');
  });

  test('measures a right-angle corner as exactly 90 degrees', async () => {
    await importScalars();
    await armIn('angle');

    // An exact right angle exists in the fixture. Rows 0 and 30 differ ONLY in
    // y — (0,0,0) and (0,1,0) — so that arm is the pure +y axis, while the ramp
    // arm (0.2, 0, 0.15) has no y component at all. Their dot product is
    // identically zero, so this is 90° by construction rather than by rounding.
    await clickWorld([0.2, 0.0, 0.15]);   // arm 1: along the ramp, y = 0
    await clickWorld([0.0, 0.0, 0.0]);    // vertex
    await clickWorld([0.0, 1.0, 0.0]);    // arm 2: pure +y

    await expect(measureLabels()).toHaveCount(1, { timeout: 10_000 });
    expect(await valueOf(measureLabels().first())).toBe('90.0°');
  });

  test('Escape drops the measurement in progress before it disarms the tool', async () => {
    await importScalars();
    await armIn('distance');

    await clickWorld([0.2, 0.0, 0.15]);
    await expect(panel()).toHaveAttribute('data-pending-count', '1', { timeout: 10_000 });

    // First Escape: abandon the half-placed measurement, stay armed. A
    // misplaced first click should cost one keystroke, not the whole tool.
    await session.page.keyboard.press('Escape');
    await expect(panel()).toHaveAttribute('data-pending-count', '0');
    await expect(panel()).toHaveAttribute('data-armed', 'true');

    // Second Escape: nothing in progress, so now it disarms.
    await session.page.keyboard.press('Escape');
    await expect(panel()).toHaveAttribute('data-armed', 'false');
  });

  test('Backspace pops the last placed vertex', async () => {
    await importScalars();
    await armIn('polyline');

    await clickWorld([0.0, 0.0, 0.0]);
    await clickWorld([0.2, 0.0, 0.15]);
    await expect(panel()).toHaveAttribute('data-pending-count', '2', { timeout: 10_000 });

    await session.page.keyboard.press('Backspace');
    await expect(panel()).toHaveAttribute('data-pending-count', '1');

    // The surviving vertex is the FIRST one, so finishing from here measures
    // from (0,0,0) — proving Backspace popped the tail, not the head.
    await clickWorld([0.4, 0.0, 0.3]);
    await session.page.keyboard.press('Enter');
    await expect(measureLabels()).toHaveCount(1, { timeout: 10_000 });
    expect(await valueOf(measureLabels().first())).toBe('0.500');
  });

  test('a measurement SURVIVES a rigid transform, unchanged, and moves with the cloud', async () => {
    // The carry-along contract. A distance is invariant under a rigid
    // transform, so translating the cloud must not change the number and must
    // not discard the measurement — the previous behaviour dropped every
    // anchor on any edit, which silently deleted the user's work.
    await importScalars();
    await armIn('distance');

    await clickWorld([0.2, 0.0, 0.15]);
    await clickWorld([0.4, 0.0, 0.3]);
    await expect(measureLabels()).toHaveCount(1, { timeout: 10_000 });
    expect(await valueOf(measureLabels().first())).toBe('0.250');

    // Disarm so viewport clicks stop being picks, then translate the cloud.
    await session.page.keyboard.press('Escape');
    await expect(panel()).toHaveAttribute('data-armed', 'false');

    // The freshly imported scan is already selected, so the transform tools
    // target it — clicking the row again would TOGGLE the sole selection off
    // and leave the Translate button disabled.
    const row = session.page.locator('[data-testid="scan-row"][data-scan-name="scalars"]');
    await expect(row).toHaveAttribute('data-selected', 'true');
    await session.page.getByTestId('tool-cloud-translate').click();
    await expect(session.page.getByTestId('translate-panel')).toBeVisible();

    // Small enough that the translated cloud stays inside the framing the
    // camera already settled on — the assertion below has to PROJECT the moved
    // midpoint, and a shift that pushes it off-screen can't be checked.
    const DX = 0.5;
    const input = session.page.getByTestId('translate-input-x');
    await input.fill(String(DX));
    await input.press('Enter');

    // Still exactly one measurement, still exactly 0.250.
    await expect(measureLabels()).toHaveCount(1);
    expect(await valueOf(measureLabels().first())).toBe('0.250');

    // And it MOVED: its leader dot now sits over the translated location of the
    // same point, not where the point used to be. Checking the number alone
    // would pass even if the line stayed behind, since distance is invariant
    // under the very transform being applied.
    const dot = session.page.locator('[data-testid="measure-leaders"] circle').first();
    await expect(dot).toBeVisible();

    // The distance label anchors at the segment MIDPOINT: (0.3, 0, 0.225)
    // before the translate, so (0.3 + DX, 0, 0.225) after it.
    //
    // The dot is written by a per-frame projector while the expected pixel is
    // computed by a separate call, so both must be read against the SAME
    // camera. The translate nudges the framing, so settle first and then poll —
    // comparing a dot drawn under one camera to a projection taken under
    // another is a race, not a measurement.
    // Frames differ and must be reconciled: __worldToScreen returns VIEWPORT
    // coordinates (it adds the canvas rect's left/top), while the SVG overlay's
    // cx/cy are CANVAS-relative. On this layout the canvas is flush left, so
    // ignoring the offset still matches in x and is wrong in y by exactly the
    // header height — which reads as "the label didn't move" when it did.
    await waitForCameraSettled();
    const canvasRect = await session.page.locator('canvas').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top };
    });

    await expect.poll(async () => {
      const expectedPx = await worldToScreenPx([0.3 + DX, 0.0, 0.225]);
      const cx = parseFloat(await dot.getAttribute('cx') ?? 'NaN');
      const cy = parseFloat(await dot.getAttribute('cy') ?? 'NaN');
      return Math.hypot(
        cx - (expectedPx.x - canvasRect.left),
        cy - (expectedPx.y - canvasRect.top),
      );
    }, {
      message: 'the measurement did not travel with its cloud — its leader dot '
        + 'is not over the translated midpoint',
      timeout: 15_000,
      intervals: [100, 250, 500],
    }).toBeLessThan(8);
  });

  test('a measurement survives a ROTATION, which needs the pivot math', async () => {
    // The translate test above would still pass against a movePoint that only
    // added the translation and ignored rotation entirely. A rotation is what
    // forces the real rotate-about-a-pivot composition (transformPoint), and a
    // 90° turn about z is big enough that getting the pivot wrong throws the
    // anchor far away rather than slightly off.
    await importScalars();
    await armIn('distance');

    await clickWorld([0.2, 0.0, 0.15]);
    await clickWorld([0.4, 0.0, 0.3]);
    await expect(measureLabels()).toHaveCount(1, { timeout: 10_000 });
    expect(await valueOf(measureLabels().first())).toBe('0.250');

    await session.page.keyboard.press('Escape');
    const row = session.page.locator('[data-testid="scan-row"][data-scan-name="scalars"]');
    await expect(row).toHaveAttribute('data-selected', 'true');
    await session.page.getByTestId('tool-cloud-translate').click();
    await expect(session.page.getByTestId('translate-panel')).toBeVisible();

    // Where the anchor sits BEFORE the rotation, so "it moved" is measurable
    // rather than assumed.
    const dotLocator = session.page.locator('[data-testid="measure-leaders"] circle').first();
    await expect(dotLocator).toBeVisible();
    const cxBefore = parseFloat(await dotLocator.getAttribute('cx') ?? 'NaN');
    const cyBefore = parseFloat(await dotLocator.getAttribute('cy') ?? 'NaN');
    expect(Number.isFinite(cxBefore) && Number.isFinite(cyBefore)).toBe(true);

    // MULTI-AXIS on purpose. Negating the Euler components happens to invert a
    // single-axis rotation correctly, so a z-only test passes against an
    // inverse that is wrong for every real gizmo drag. Rotating on all three
    // axes is what forces a true matrix inverse (see unposePoint).
    for (const [axis, deg] of [['x', '30'], ['y', '40'], ['z', '50']] as const) {
      const input = session.page.getByTestId(`rotation-input-${axis}`);
      await input.fill(deg);
      await input.press('Enter');
    }

    // A rotation is rigid, so the LENGTH is unchanged — that is the property
    // that makes carrying the measurement the right call in the first place.
    await expect(measureLabels()).toHaveCount(1);
    expect(await valueOf(measureLabels().first())).toBe('0.250');

    // And it MOVED with the rotation. Asserting the exact landing pixel would
    // mean re-deriving the pivot here — duplicating the implementation, and
    // passing against any bug the duplicate shared. Assert the two independent
    // properties a correct carry must have instead:
    //
    //   1. the anchor is no longer where it was before the rotation (a
    //      rotation-ignoring movePoint would leave it exactly put), and
    //   2. it is still inside the canvas, near the rotated cloud — a pivotless
    //      rotation flings the anchor off-screen, since the cloud sits ~0.3
    //      from an origin the rotation would otherwise swing it around.
    const dotBefore = { x: cxBefore, y: cyBefore };

    await waitForCameraSettled();
    const dot = session.page.locator('[data-testid="measure-leaders"] circle').first();
    await expect(dot).toBeVisible();

    const canvasRect = await session.page.locator('canvas').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    const cx = parseFloat(await dot.getAttribute('cx') ?? 'NaN');
    const cy = parseFloat(await dot.getAttribute('cy') ?? 'NaN');

    expect(
      Math.hypot(cx - dotBefore.x, cy - dotBefore.y),
      `leader dot did not move from (${dotBefore.x.toFixed(1)}, ${dotBefore.y.toFixed(1)}) ` +
      `under a 90° rotation — movePoint is ignoring rotation`,
    ).toBeGreaterThan(5);

    expect(
      cx >= 0 && cx <= canvasRect.width && cy >= 0 && cy <= canvasRect.height,
      `leader dot at (${cx.toFixed(1)}, ${cy.toFixed(1)}) fell outside the ` +
      `${canvasRect.width}x${canvasRect.height} canvas — the rotation was applied ` +
      `to the anchor without its pivot`,
    ).toBe(true);
  });

  test('a rotated UTM cloud keeps SANE world coordinates on its labels', async () => {
    // The frame bug this pins: the pose's pivot is a LOCAL-frame point, so
    // rotating a WORLD coordinate about it computes R·(local + shift − pivot)
    // instead of R·(local − pivot) + shift. On a UTM cloud the reported
    // coordinate landed ~5,700 km away — a different continent — while the
    // rendered line still looked correct, so nothing on screen gave it away.
    // `world` is now re-derived from the moved `local` rather than transformed.
    await importFiles(session.app, session.page, 'import-point-cloud', join(FIXTURES, 'utm-tree.xyz'));
    await completeImportWizard(session.page);
    const row = session.page.locator('[data-testid="scan-row"][data-scan-name="utm-tree"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-point-count', '192');
    await waitForCameraSettled();

    // The scene renders the STORED frame, so aim in that frame (see the twin
    // note in point-pick.spec.ts).
    const cam = await session.page.evaluate(() => (window as any).__getCameraState?.());
    const target: [number, number, number] = [
      cam.bounds.max[0],
      (cam.bounds.min[1] + cam.bounds.max[1]) / 2,
      cam.bounds.min[2] + 0.7,
    ];

    await session.page.getByTestId('tool-point-pick').click();
    await expect(panel()).toHaveAttribute('data-armed', 'true');
    await clickWorld(target);
    const pickLabel = session.page.getByTestId('picked-point-label');
    await expect(pickLabel).toHaveCount(1, { timeout: 10_000 });

    const readWorldX = async () => parseFloat(await pickLabel.first().evaluate((el) => {
      const block = el.querySelector('[data-testid="picked-point-coords"]')!;
      return (Array.from(block.children).slice(-3)[0].children[1]?.textContent ?? '').trim();
    }));

    const beforeX = await readWorldX();
    expect(beforeX).toBeGreaterThan(5e5);
    expect(beforeX).toBeLessThan(5.5e5);

    await session.page.keyboard.press('Escape');
    await expect(row).toHaveAttribute('data-selected', 'true');
    await session.page.getByTestId('tool-cloud-translate').click();
    await expect(session.page.getByTestId('translate-panel')).toBeVisible();

    const rot = session.page.getByTestId('rotation-input-z');
    await rot.fill('90');
    await rot.press('Enter');

    // The label survives, and its world X is still a plausible UTM easting.
    // The cloud is ~0.6 m across, so a rotation can move the coordinate by at
    // most a couple of metres; the bug moved it by millions.
    await expect(pickLabel).toHaveCount(1);
    const afterX = await readWorldX();
    expect(
      Math.abs(afterX - beforeX),
      `world X jumped from ${beforeX} to ${afterX} under a rotation of a ` +
      `sub-metre cloud — the world frame was rotated about a local-frame pivot`,
    ).toBeLessThan(5);
  });

  test('an inspect label also survives a rigid transform', async () => {
    // Picker parity: the same fix, the same code path. Before it, translating a
    // cloud discarded every placed label.
    await importScalars();
    await session.page.getByTestId('tool-point-pick').click();
    await expect(panel()).toHaveAttribute('data-armed', 'true');

    await clickWorld([0.4, 0.0, 0.3]);
    await expect(session.page.getByTestId('picked-point-label')).toHaveCount(1, { timeout: 10_000 });

    await session.page.keyboard.press('Escape');
    // Already selected from import — see the note in the measurement twin.
    const row = session.page.locator('[data-testid="scan-row"][data-scan-name="scalars"]');
    await expect(row).toHaveAttribute('data-selected', 'true');
    await session.page.getByTestId('tool-cloud-translate').click();
    await expect(session.page.getByTestId('translate-panel')).toBeVisible();
    const input = session.page.getByTestId('translate-input-x');
    await input.fill('0.5');
    await input.press('Enter');

    // The label is still there, and its coordinates now report the MOVED
    // position — it tracked the cloud rather than being frozen or dropped.
    // Picked at x = 0.400, translated by +0.5, so it must read 0.900.
    await expect(session.page.getByTestId('picked-point-label')).toHaveCount(1);
    const coords = await session.page.getByTestId('picked-point-label').first().evaluate((el) => {
      const block = el.querySelector('[data-testid="picked-point-coords"]')!;
      return Array.from(block.children)
        .slice(-3)
        .map((r) => (r.children[1]?.textContent ?? '').trim());
    });
    expect(coords[0]).toBe('0.900');
  });

  test('a measurement is DROPPED when its cloud’s geometry is rebuilt', async () => {
    // The other half of the contract. A rigid transform preserves every point,
    // so anchors ride along; a crop does not, so the anchored point may simply
    // be gone. Carrying a measurement onto rebuilt geometry would leave a
    // plausible-looking number attached to the wrong place, which is worse than
    // losing it — so this must drop, not move.
    await importScalars();
    await armIn('distance');

    await clickWorld([0.0, 0.0, 0.0]);
    await clickWorld([0.4, 0.0, 0.3]);
    await expect(measureLabels()).toHaveCount(1, { timeout: 10_000 });

    await session.page.keyboard.press('Escape');
    const row = session.page.locator('[data-testid="scan-row"][data-scan-name="scalars"]');
    await expect(row).toHaveAttribute('data-selected', 'true');

    await session.page.getByTestId('tool-crop').click();
    const cropPanel = session.page.getByTestId('crop-panel');
    await expect(cropPanel).toBeVisible();

    // Shrink the box along z so the crop actually removes points — a no-op crop
    // would rebuild nothing and prove nothing.
    const dim = session.page.getByTestId('crop-dim-z');
    await dim.fill('0.5');
    await dim.press('Enter');

    await session.page.getByTestId('crop-apply').click();
    await expect(cropPanel).toHaveCount(0, { timeout: 30_000 });

    // The cloud really did lose points (otherwise this test would pass for the
    // wrong reason), and the measurement anchored to it is gone.
    await expect
      .poll(async () => Number(await row.getAttribute('data-point-count')), { timeout: 60_000 })
      .toBeLessThan(60);
    await expect(measureLabels()).toHaveCount(0);
  });

  test('copies every measurement as CSV', async () => {
    await importScalars();
    await armIn('distance');

    await clickWorld([0.0, 0.0, 0.0]);
    await clickWorld([0.4, 0.0, 0.3]);
    await expect(measureLabels()).toHaveCount(1, { timeout: 10_000 });

    await session.page.getByTestId('point-picker-copy-all').click();
    const csv = await session.page.evaluate(() => navigator.clipboard.readText());

    const lines = csv.trim().split('\n');
    // header + 1 summary row + 2 vertex rows
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('kind');
    expect(lines[0]).toContain('world_x');
    expect(lines[1]).toContain('distance');
    expect(lines[1]).toContain('0.500');
    // The vertex coordinates travel with the number, so the measurement is
    // reproducible from the clipboard alone.
    expect(csv).toContain('0.400,0.000,0.300');
  });

  test('dismisses one measurement and clears the rest', async () => {
    await importScalars();
    await armIn('distance');

    await clickWorld([0.0, 0.0, 0.0]);
    await clickWorld([0.2, 0.0, 0.15]);
    await expect(measureLabels()).toHaveCount(1, { timeout: 10_000 });

    await clickWorld([0.4, 0.0, 0.3]);
    await clickWorld([0.6, 0.0, 0.45]);
    await expect(measureLabels()).toHaveCount(2, { timeout: 10_000 });

    await measureLabels().first().getByTestId('measure-dismiss').click();
    await expect(measureLabels()).toHaveCount(1);
    await expect(panel()).toHaveAttribute('data-measurement-count', '1');

    await session.page.getByTestId('point-picker-clear-all').click();
    await expect(measureLabels()).toHaveCount(0);
  });

  test('switching modes keeps what is already placed', async () => {
    // Inspect labels and measurements coexist: a user measures a span and then
    // inspects one of its endpoints without losing either.
    await importScalars();
    await armIn('distance');

    await clickWorld([0.0, 0.0, 0.0]);
    await clickWorld([0.2, 0.0, 0.15]);
    await expect(measureLabels()).toHaveCount(1, { timeout: 10_000 });

    await session.page.getByTestId('picker-mode-inspect').click();
    await expect(panel()).toHaveAttribute('data-measure-mode', 'inspect');
    // The measurement survived the mode switch.
    await expect(measureLabels()).toHaveCount(1);

    await clickWorld([0.4, 0.0, 0.3]);
    await expect(session.page.getByTestId('picked-point-label')).toHaveCount(1, { timeout: 10_000 });
    // Both are on screen at once.
    await expect(measureLabels()).toHaveCount(1);
  });
});
