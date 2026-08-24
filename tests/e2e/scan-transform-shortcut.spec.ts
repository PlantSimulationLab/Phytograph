import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

// Blender-style t / r gestures on a SCAN POSITION (a scanner marker).
//
// The mapping is deliberately literal — each key writes the field the Scan
// Parameters dialog exposes:
//
//   t x/y/z  →  params.origin.x / .y / .z   (the dialog's Origin fields)
//   r x      →  params.tiltRollDeg          (Scanner tilt → Roll)
//   r y      →  params.tiltPitchDeg         (Scanner tilt → Pitch)
//
// So every assertion here reads the value back through a real surface: the
// scan row's data-scan-origin attribute, or the dialog's own inputs.
//
// Two behaviours that are NOT the same as the cloud gesture and are asserted
// separately below: a scan transform applies on commit (there is no panel
// OK/Cancel draft in the way), and it is skipped entirely while the Transform
// Point Cloud tool is open, so `t` there keeps meaning "move the points".
test.describe('scan transform shortcuts', () => {
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

  const scansPanel = () => session.page.getByTestId('scans-panel');
  const scanRows = () => scansPanel().locator('[data-testid="scan-row"]');
  const hud = () => session.page.getByTestId('transform-hud');

  // Move focus to <body> so the window keydown handler owns every key. Clicking
  // a scan row leaves focus on the row element, and a focused control can both
  // swallow the shortcut (isInputFocused) and turn Enter into a click. Same
  // guard translate-cloud.spec.ts uses for the cloud T-modal.
  const focusBody = () => session.page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
  });

  // Create a params-only scan (a scan position with no point data) at a known
  // origin, through the real Add Scan popup. Returns its scan id.
  async function addScanPosition(
    label: string,
    origin: { x: number; y: number; z: number },
  ): Promise<string> {
    const { page } = session;
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-label-input').fill(label);
    await page.getByTestId('scan-origin-x').fill(String(origin.x));
    await page.getByTestId('scan-origin-y').fill(String(origin.y));
    await page.getByTestId('scan-origin-z').fill(String(origin.z));
    await page.getByTestId('scan-submit').click();
    await expect(popup).not.toBeVisible();

    const row = scanRows().first();
    await expect(row).toBeVisible();
    const id = await row.getAttribute('data-scan-id');
    if (!id) throw new Error('scan row has no data-scan-id');
    return id;
  }

  const rowFor = (id: string) =>
    scansPanel().locator(`[data-testid="scan-row"][data-scan-id="${id}"]`);

  // ENSURE a scan is selected, through its Scans-panel row (the same handler the
  // viewport marker click calls), then drop focus so the shortcut reaches the
  // window.
  //
  // Checks first rather than clicking unconditionally, because a plain click on
  // the row that is ALREADY the sole selection deselects it (that toggle is real
  // product behaviour — see handleToggleScanSelection in App.tsx). Scans created
  // via `addScanPosition` start unselected, but a scan imported through the
  // wizard is auto-selected, so an unconditional click turns it OFF and every
  // shortcut afterwards has no target. translate-cloud.spec.ts documents the
  // same trap ("No re-click — a plain click on the sole selection toggles it
  // off"); this helper just makes the check reusable across both starting
  // states instead of assuming one.
  async function selectScanRow(id: string) {
    const row = rowFor(id);
    if (await row.getAttribute('data-selected') !== 'true') {
      await row.click();
    }
    await expect(row).toHaveAttribute('data-selected', 'true');
    await focusBody();
  }

  // Run a full modal gesture with a TYPED value, which makes the result exact
  // and independent of where the cursor happens to be (updateModal prefers the
  // numeric buffer over the mouse position).
  async function gesture(op: 't' | 'r', axis: 'x' | 'y' | 'z', value: string) {
    const { page } = session;
    await page.keyboard.press(op);
    await expect(hud()).toHaveAttribute('data-transform-op', op === 't' ? 'translate' : 'rotate');
    await page.keyboard.press(axis);
    await expect(hud()).toHaveAttribute('data-transform-axis', axis);
    for (const ch of value) await page.keyboard.press(ch);
    await expect(hud()).toContainText(value);
    await page.keyboard.press('Enter');
    await expect(hud()).toHaveCount(0);
  }

  test('t with an axis lock and a typed value moves the scan origin', async () => {
    const id = await addScanPosition('Tripod A', { x: 1, y: 2, z: 3 });
    const row = rowFor(id);
    await expect(row).toHaveAttribute('data-scan-origin', '1.000,2.000,3.000');

    await selectScanRow(id);
    await gesture('t', 'x', '5');

    // Only X moved — the axis lock maps onto the single Origin field.
    await expect(row).toHaveAttribute('data-scan-origin', '6.000,2.000,3.000');

    // And a second gesture composes onto the new value rather than resetting.
    await focusBody();
    await gesture('t', 'z', '2');
    await expect(row).toHaveAttribute('data-scan-origin', '6.000,2.000,5.000');
  });

  test('a negative typed value moves the origin backwards along the locked axis', async () => {
    const id = await addScanPosition('Tripod Neg', { x: 4, y: 4, z: 4 });
    const row = rowFor(id);

    await selectScanRow(id);
    await gesture('t', 'y', '-1.5');
    await expect(row).toHaveAttribute('data-scan-origin', '4.000,2.500,4.000');
  });

  test('r writes scanner tilt — x is roll, y is pitch — and round-trips to the dialog', async () => {
    const { page } = session;
    const id = await addScanPosition('Tilted Tripod', { x: 0, y: 0, z: 1 });

    await selectScanRow(id);
    await gesture('r', 'y', '10');
    await focusBody();
    await gesture('r', 'x', '4');

    // Read the result back through the dialog the shortcut is meant to mirror.
    await page.getByTestId(`scan-edit-${id}`).click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await expect(page.getByTestId('scan-tilt-pitch')).toHaveValue('10');
    await expect(page.getByTestId('scan-tilt-roll')).toHaveValue('4');
    // Heading is deliberately NOT touched by the rotate gesture.
    await expect(page.getByTestId('scan-azimuth-offset')).toHaveValue('0');
    // Rotating must not have disturbed the position.
    await expect(page.getByTestId('scan-origin-z')).toHaveValue('1');
  });

  test('Escape cancels the gesture and restores the original origin', async () => {
    const { page } = session;
    const id = await addScanPosition('Tripod Esc', { x: 1, y: 1, z: 1 });
    const row = rowFor(id);

    await selectScanRow(id);
    await page.keyboard.press('t');
    await expect(hud()).toHaveAttribute('data-transform-op', 'translate');
    await page.keyboard.press('x');
    for (const ch of '9') await page.keyboard.press(ch);
    // The move is live before the commit — this is what Escape has to undo.
    await expect(row).toHaveAttribute('data-scan-origin', '10.000,1.000,1.000');

    await page.keyboard.press('Escape');
    await expect(hud()).toHaveCount(0);
    await expect(row).toHaveAttribute('data-scan-origin', '1.000,1.000,1.000');
  });

  test('s does nothing on a scan position — a scanner has no size', async () => {
    const { page } = session;
    const id = await addScanPosition('Tripod Scale', { x: 2, y: 0, z: 0 });
    const row = rowFor(id);

    await selectScanRow(id);
    await page.keyboard.press('s');
    await expect(hud()).toHaveCount(0);
    await expect(row).toHaveAttribute('data-scan-origin', '2.000,0.000,0.000');
  });

  // Regression shape borrowed from transform-shortcut-after-select.spec.ts: the
  // transform effect re-subscribes whenever the selection changes, so the very
  // click that selects a scan used to reinstall listeners with an unset cursor
  // anchor and make the first `t` no-op. Press the key with NO intervening
  // mouse move, which is the only way to catch it.
  test('t fires on the first press after selecting, with no mouse movement', async () => {
    const { page } = session;
    const id = await addScanPosition('Tripod First', { x: 0, y: 3, z: 0 });

    await selectScanRow(id);
    await page.keyboard.press('t');
    await expect(hud()).toHaveAttribute('data-transform-op', 'translate');
    await page.keyboard.press('Escape');
    await expect(hud()).toHaveCount(0);
  });

  // The user-facing flow from the feature request: click the scanner in the
  // 3-D view, then press the key. Selection through the marker goes through the
  // same handler as the row, so this asserts the viewport path end to end.
  test('clicking the marker in the viewport then pressing t moves that scan', async () => {
    const { page } = session;
    const id = await addScanPosition('Viewport Tripod', { x: 0, y: 0, z: 0 });
    const row = rowFor(id);

    // Frame the scene, then click the marker where the LIVE camera draws it —
    // re-projecting and re-clicking each attempt rather than computing a pixel
    // once. Two things settle on their own schedule here and a single click can
    // lose to either: the camera is still easing into its post-add framing, and
    // the generic marker body is a PLY sphere loaded through <Suspense>, so the
    // group has no clickable geometry until the loader resolves. Retrying until
    // the row reports selected absorbs both without a fixed sleep.
    await page.evaluate(() => (window as any).__resetPointCloudCamera?.());
    await expect.poll(async () => {
      const p = await page.evaluate(
        () => (window as any).__worldToScreen?.([0, 0, 0]) ?? null,
      );
      if (!p?.visible) return 'false';
      await page.mouse.click(p.x, p.y);
      return (await row.getAttribute('data-selected')) ?? 'false';
    }, { timeout: 30_000, intervals: [500] }).toBe('true');

    await focusBody();
    await gesture('t', 'z', '3');
    await expect(row).toHaveAttribute('data-scan-origin', '0.000,0.000,3.000');
  });

  // The one case where `t` must NOT touch the scanner: with the Transform Point
  // Cloud tool open, the gesture keeps its existing meaning of moving the
  // points into the panel's draft. tiny-scan.xml yields a scan carrying BOTH
  // params and data, so both interpretations are live and the gate decides.
  test('with the Transform tool open, t drives the cloud draft and leaves the scanner put', async () => {
    const { app, page } = session;
    await stubOpenDialog(app, join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny-scan.xml'));
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    await expect(scanRows()).toHaveCount(1, { timeout: 20_000 });
    const row = scanRows().first();
    await expect(row).toHaveAttribute('data-has-data', 'true');
    await expect(row).toHaveAttribute('data-has-params', 'true');
    await expect(row).toHaveAttribute('data-scan-origin', '0.500,-1.000,0.250');
    const id = await row.getAttribute('data-scan-id');
    if (!id) throw new Error('scan row has no data-scan-id');

    await selectScanRow(id);

    // Sanity: with the tool CLOSED, `t` targets the scanner.
    await gesture('t', 'x', '1');
    await expect(row).toHaveAttribute('data-scan-origin', '1.500,-1.000,0.250');

    // Now open the Transform tool. The same gesture must fall through to the
    // cloud branch and leave params.origin alone.
    await page.getByTestId('tool-cloud-translate').click();
    await expect(page.getByTestId('translate-panel')).toBeVisible();
    await focusBody();

    await page.keyboard.press('t');
    await expect(hud()).toHaveAttribute('data-transform-op', 'translate');
    await page.keyboard.press('y');
    for (const ch of '2') await page.keyboard.press(ch);
    await expect(hud()).toContainText('2');
    // Commit with a viewport click, not Enter: the toolbar button still holds
    // focus after opening the tool, where Enter would re-toggle it.
    const box = await page.locator('canvas').first().boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(hud()).toHaveCount(0);

    // The draft landed in the panel, and the scanner origin is untouched.
    await expect(page.getByTestId('translate-input-y')).toHaveValue('2.000');
    await expect(row).toHaveAttribute('data-scan-origin', '1.500,-1.000,0.250');
  });
});
