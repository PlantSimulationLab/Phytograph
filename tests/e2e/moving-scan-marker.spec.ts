import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';

// Regression for the data-less moving-scan flow (the path a user hit that the
// LAD E2E missed): Add Scan -> pick a scanner model -> import a trajectory file
// -> Add Scan, with NO point data. Asserts that:
//   1. the trajectory import replaces the editable origin fields with a
//      read-only "set by the trajectory" anchor (origin is irrelevant here),
//   2. the resulting params-only scan is flagged moving in the Scans panel
//      (badge + data-moving), not shown as a static origin,
//   3. adding the data-less scan does NOT blank the viewport — the app stays
//      live (no crash/error overlay) and the canvas is still present, which only
//      holds when the far-away trajectory is included in the scene bounds.
test('A data-less moving-platform scan imports, is flagged moving, and keeps the viewport live', async () => {
  const { app, page, close } = await launchApp();

  try {
    const traj = join(repoRoot, 'tests', 'e2e', 'fixtures', 'drone_pass_trajectory.csv');
    await stubOpenDialog(app, traj);

    // --- Add Scan -> pick Velodyne -> import the trajectory ----------------
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();

    await page.getByTestId('scan-model-select').selectOption('velodyne_hdl32e');

    // Before import, the editable origin fields are present.
    await expect(page.getByTestId('scan-origin-x')).toBeVisible();

    await page.getByTestId('scan-trajectory-import').click();

    // Trajectory parsed: summary shows, AND the editable origin fields are
    // replaced by the read-only anchor (issue: origin shouldn't look editable
    // for a moving scan).
    await expect(page.getByTestId('scan-trajectory-label')).toBeVisible();
    await expect(page.getByTestId('scan-origin-anchor')).toBeVisible();
    await expect(page.getByTestId('scan-origin-x')).toHaveCount(0);

    // Attitude comes from the trajectory, so the static tilt + heading fields are
    // hidden (the backend rejects a non-zero static tilt for a moving scan) and a
    // note explains it instead.
    await expect(page.getByTestId('scan-attitude-note')).toBeVisible();
    await expect(page.getByTestId('scan-tilt-roll')).toHaveCount(0);
    await expect(page.getByTestId('scan-tilt-pitch')).toHaveCount(0);
    await expect(page.getByTestId('scan-azimuth-offset')).toHaveCount(0);

    await page.getByTestId('scan-submit').click();
    await expect(popup).not.toBeVisible();

    // --- The scan is added and flagged moving (no static origin) ------------
    const scansPanel = page.getByTestId('scans-panel');
    const scanRows = scansPanel.locator('[data-testid="scan-row"]');
    await expect(scanRows).toHaveCount(1);
    const row = scanRows.nth(0);
    await expect(row).toHaveAttribute('data-has-data', 'false');
    await expect(row).toHaveAttribute('data-has-params', 'true');
    await expect(row).toHaveAttribute('data-moving', 'true');
    await expect(row.getByTestId('scan-row-moving')).toBeVisible();

    // --- The viewport frames the trajectory (didn't blank) -----------------
    // The original bug: combinedBounds (which drives the camera + ground grid)
    // excluded scan params, so a data-less moving scan fell back to the default
    // ±5 origin box (diagonal ≈ 17.3) while the marker sat off at the flight line —
    // off-camera, grid gone. The fix includes the whole trajectory in bounds, so
    // the bounds diagonal reflects the ~50 m pass (y from -25 to +25), well above
    // the 17.3 default.
    await expect(page.locator('canvas')).toBeVisible();
    const viewer = page.locator('[data-scene-bounds-size]');
    const boundsSize = parseFloat((await viewer.getAttribute('data-scene-bounds-size'))!);
    expect(boundsSize).toBeGreaterThan(40);          // ~50 m pass, not the ±5 default
    await expect(row).toHaveAttribute('data-visible', 'true');
  } finally {
    await close();
  }
});
