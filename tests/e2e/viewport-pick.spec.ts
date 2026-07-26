import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { resetToFreshScene } from './helpers/resetApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// Viewport picking for the sphere fixtures (scans + a rotated <grid> voxel box).
//
// Two regressions are covered:
//  1. A voxel <grid> ENCLOSING the scanned geometry swallowed clicks on
//     everything inside/behind it. The grid is a translucent volume-bounds box
//     you look *through*, but it was a solid pick target, and its near faces sit
//     between the camera and its contents. In example-datasets/sphere.xml (a
//     0.5 m grid wrapping the sphere, viewed from ~1 m) the box covered most of
//     the viewport, so almost nothing else in the scene could be picked. Fixed
//     by making a grid yield to any other object under the cursor.
//  2. Scan markers had no click handler at all, so the instruments were never
//     selectable in the 3D view. Fixed by wiring ScannerMarker's body group to
//     the same onToggleSelection the Scans-pane rows use.
test.describe('viewport picking', () => {
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

  const selectedRows = () =>
    session.page
      .getByTestId('scans-panel')
      .locator('[data-testid="scan-row"][data-selected="true"]');

  // Projects a WORLD point to a canvas fraction using the LIVE camera state, so
  // a click targets geometry wherever the current framing puts it rather than at
  // a hardcoded pixel. Both the scan markers and the grid box are small on
  // screen, so a click has to land on the body — not merely near it.
  async function worldToScreenPoint(
    world: [number, number, number],
    box: { width: number; height: number },
  ) {
    return session.page.evaluate(({ w, h, world }) => {
      const s = (window as any).__getCameraState();
      const [px, py, pz] = s.position as [number, number, number];
      const [tx, ty, tz] = s.target as [number, number, number];
      const [ux, uy, uz] = s.up as [number, number, number];
      const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
      const norm = (v: number[]) => { const l = Math.hypot(...v); return v.map(x => x / l); };
      const cross = (a: number[], b: number[]) =>
        [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const dot = (a: number[], b: number[]) => a.reduce((acc, v, i) => acc + v * b[i], 0);
      // three's camera looks down its local -Z.
      const zAx = norm(sub([px, py, pz], [tx, ty, tz]));
      const xAx = norm(cross([ux, uy, uz], zAx));
      const yAx = cross(zAx, xAx);
      // World point minus the render-only display offset (zero for this scene).
      const off = s.displayOffset as [number, number, number];
      const d = sub([world[0] - off[0], world[1] - off[1], world[2] - off[2]], [px, py, pz]);
      const v = [dot(d, xAx), dot(d, yAx), dot(d, zAx)];
      const f = 1 / Math.tan(((60 * Math.PI) / 180) / 2); // Canvas fov=60
      const wClip = -v[2];
      return { x: ((f / (w / h)) * v[0] / wClip + 1) / 2, y: (1 - (f * v[1] / wClip)) / 2 };
    }, { w: box.width, h: box.height, world });
  }

  // Imports a sphere XML through the real Add Scan → Import XML path.
  // `fixture` picks sphere.xml (4 scans) or sphere-with-grid.xml (1 scan + a
  // <grid> voxel box, so grid selection can be asserted).
  async function importSphere(fixture = 'sphere.xml', scanCount = 4) {
    const { app, page } = session;
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sphere-scan', fixture);
    await stubOpenDialog(app, xmlFixture);

    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const rows = page.getByTestId('scans-panel').locator('[data-testid="scan-row"]');
    await expect(rows).toHaveCount(scanCount, { timeout: 20_000 });

    // Deliberately do NOT call __resetPointCloudCamera here: reset frames the
    // full scene bounds (including the scan markers metres away), which pulls
    // the camera far enough back that the grid box is small on screen. The bug
    // under test appears at the app's OWN post-import framing, which fits the
    // point data — a ~0.5 m scene viewed from ~1 m, where the grid box covers
    // much of the viewport. Test what the user actually sees.
    //
    // Wait for that framing to LATCH and the camera to stop moving, rather than
    // sleeping a fixed interval. Every test here projects a world point to a
    // screen pixel through the live camera, so a camera still settling puts the
    // click somewhere else entirely — the assertion then reads "clicked and
    // nothing was selected". A 2 s sleep was enough on macOS but not on the
    // slower headless CI runner, which is exactly how these passed locally and
    // failed in CI.
    await expect
      .poll(() => page.evaluate(() => (window as any).__getCameraState?.()?.framedContent ?? false),
            { timeout: 20_000 })
      .toBe(true);
    // Then require two identical consecutive camera reads: `framedContent`
    // latches when framing is REQUESTED, and snapToView animates from there.
    await expect
      .poll(async () => {
        const read = () => page.evaluate(() => {
          const s = (window as any).__getCameraState?.();
          return s ? JSON.stringify([s.position, s.target]) : '';
        });
        const a = await read();
        await page.waitForTimeout(120);
        return (await read()) === a ? a : '';
      }, { timeout: 20_000 })
      .not.toBe('');

    // Importing the XML leaves all four scans selected; clear that via the
    // panel's Deselect All so each test starts from a known empty selection.
    await page.getByTitle('Deselect All').click();
    await expect(selectedRows()).toHaveCount(0);
    return rows;
  }

  test('an enclosing grid does not swallow clicks on the geometry inside it', async () => {
    // Same shape as example-datasets/sphere.xml: the <grid> box wraps the
    // scanned sphere, so the box's near faces sit between the camera and the
    // sphere. This is the configuration that broke picking.
    await importSphere('sphere-enclosing-grid.xml', 2);
    const { page } = session;

    const canvas = page.locator('canvas').first();
    const box = (await canvas.boundingBox())!;
    const gridRow = page.locator('[data-testid="mesh-row"]').first();
    const selectedMeshes = () => page.locator('[data-testid="mesh-row"][data-selected="true"]');

    // The grid mesh exists and starts unselected.
    await expect(gridRow).toBeVisible();
    await expect(selectedMeshes()).toHaveCount(0);

    // THE REPORTED BUG: scan 0's marker sits at (-2, 0, 0.5) and, at this
    // framing, its glyph overlaps the grid box on screen — the ray crosses the
    // box's near face before reaching the marker. The grid used to win that
    // pick and swallow the click; the marker must get it instead.
    // (Point clouds are not viewport-pickable — they are selected from their
    // panel row — so the marker is the object to assert on here.)
    const onMarker = await worldToScreenPoint([-2, 0, 0.5], box);
    await page.mouse.click(box.x + box.width * onMarker.x, box.y + box.height * onMarker.y);
    await expect(selectedRows()).toHaveCount(1);
    await expect(selectedMeshes()).toHaveCount(0);
    await expect(gridRow).toHaveAttribute('data-selected', 'false');

    // ...but the grid is still selectable where it is the ONLY thing under the
    // cursor. Without this, the assertion above could pass by making the grid
    // unpickable entirely. Target the box's top face well out toward a corner
    // (the box is 0.5^3 at (0,0,0.5) rotated 45 deg, so its top-face corners
    // sit at (0, +-0.354, 0.75)) — clear of the sphere, which only reaches
    // z ~ 0.70 near the centre.
    const corner = await worldToScreenPoint([0, 0.30, 0.75], box);
    await page.mouse.click(box.x + box.width * corner.x, box.y + box.height * corner.y);
    await expect(selectedMeshes()).toHaveCount(1);
    await expect(gridRow).toHaveAttribute('data-selected', 'true');
  });

  test('the grid is not pickable well outside its own footprint', async () => {
    // The grid's wireframe overlay is a <lineSegments>, and three.js raycasts
    // lines within raycaster.params.Line.threshold — a WORLD-space distance
    // that defaults to 1 m and is never configured here. On this 0.5 m grid
    // that halo (further inflated by Line.raycast dividing the threshold by the
    // parent group's scale) made the box pickable roughly one grid width out in
    // every direction. Probe just beyond each side of the box and require a
    // miss; the previous test already covers that the box itself still picks.
    await importSphere('sphere-enclosing-grid.xml', 2);
    const { page } = session;

    const box = (await page.locator('canvas').first().boundingBox())!;
    const selectedMeshes = () => page.locator('[data-testid="mesh-row"][data-selected="true"]');

    // Work in SCREEN space, not world space: a world point "beside" the box can
    // still project inside its on-screen silhouette (it may simply sit behind
    // the box along the view direction), which would be a false failure. So
    // compute the box's true screen footprint from its eight projected corners,
    // then probe outside that rectangle — where a click provably must miss.
    const corners: Array<[number, number, number]> = [];
    const HALF = 0.25;                   // 0.5 m box → ±0.25 m in local x/y/z
    const R = Math.PI / 4;               // <rotation> 45 deg about z
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const lx = sx * HALF, ly = sy * HALF;
      corners.push([
        lx * Math.cos(R) - ly * Math.sin(R),
        lx * Math.sin(R) + ly * Math.cos(R),
        0.5 + sz * HALF,
      ]);
    }
    const projected = [];
    for (const c of corners) projected.push(await worldToScreenPoint(c, box));
    const foot = {
      minx: Math.min(...projected.map(p => p.x)), maxx: Math.max(...projected.map(p => p.x)),
      miny: Math.min(...projected.map(p => p.y)), maxy: Math.max(...projected.map(p => p.y)),
    };
    const wide = foot.maxx - foot.minx;
    const tall = foot.maxy - foot.miny;

    // Clearly beyond each edge but still on bare canvas. The old line halo made
    // the grid pickable across nearly the whole viewport (measured 0.02–0.94 in
    // both axes before the fix), so even a modest margin outside the silhouette
    // sits well inside the region that used to select it.
    const probes: Array<[string, number, number]> = [
      ['left', foot.minx - wide * 0.25, (foot.miny + foot.maxy) / 2],
      ['right', foot.maxx + wide * 0.25, (foot.miny + foot.maxy) / 2],
      ['above', (foot.minx + foot.maxx) / 2, foot.miny - tall * 0.15],
      ['below', (foot.minx + foot.maxx) / 2, foot.maxy + tall * 0.08],
    ];

    let probed = 0;
    for (const [label, fx, fy] of probes) {
      if (fx < 0.02 || fx > 0.98 || fy < 0.02 || fy > 0.98) continue;
      const px = box.x + box.width * fx;
      const py = box.y + box.height * fy;
      // Only probe points that are actually on the canvas and not behind a
      // panel/toolbar — an overlay would eat the click and fake a pass.
      const onCanvas = await page.evaluate(
        (p) => (document.elementFromPoint(p.x, p.y) as HTMLElement | null)?.tagName?.toLowerCase(),
        { x: px, y: py },
      );
      if (onCanvas !== 'canvas') continue;

      probed++;
      await page.mouse.click(px, py);
      await expect(
        selectedMeshes(),
        `clicking well outside the grid's on-screen footprint (${label}) must not select it`,
      ).toHaveCount(0);
    }
    expect(probed, 'no usable probe points landed on the canvas').toBeGreaterThan(0);
  });

  test('clicking a scan marker in the viewport selects that scan', async () => {
    await importSphere();
    const { page } = session;

    await expect(selectedRows()).toHaveCount(0);

    const canvas = page.locator('canvas').first();
    const box = (await canvas.boundingBox())!;

    // Scan 0's marker sits at its world origin (-2, 0, 0.5).
    const pt = await worldToScreenPoint([-2, 0, 0.5], box);
    await page.mouse.click(box.x + box.width * pt.x, box.y + box.height * pt.y);

    // Exactly one scan selected, and it is the one whose marker we clicked.
    await expect(selectedRows()).toHaveCount(1);
    await expect(selectedRows()).toHaveAttribute('data-scan-origin', '-2.000,0.000,0.500');
  });
});
