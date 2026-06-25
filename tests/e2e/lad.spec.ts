import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { completeImportWizard } from './helpers/importWizard';

// End-to-end leaf area density (LAD) through the Phytograph UI against the live
// backend. Adapts the PyHelios C++ lidar self-test ("LiDAR Single Voxel
// Isotropic Patches Test"): the committed leafcube fixture is a synthetic scan
// of the LAI=2 spherical leaf cube, whose 1x1x1 m voxel at (0,0,0.5) has true
// LAD=2.0 m^2/m^3 and G(theta)=0.5. We import the scan, build the required
// voxel grid in the viewer, run LAD against the real backend, and assert the
// per-voxel value reads near 2.0 in the UI (colorbar + hover tooltip).
test('Computes per-voxel leaf area density for the leaf-cube fixture', async () => {
  const { app, page, close } = await launchApp();

  try {
    const xmlFixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'lad-leafcube', 'leafcube.xml');
    await stubOpenDialog(app, xmlFixture);

    // Import the single scan from XML (attaches both data + per-scan params).
    await page.getByTestId('tool-add-scan').click();
    const popup = page.getByTestId('scan-parameters-popup');
    await expect(popup).toBeVisible();
    await page.getByTestId('scan-import-xml').click();
    await expect(popup).not.toBeVisible({ timeout: 20_000 });
    await completeImportWizard(page);

    const scansPanel = page.getByTestId('scans-panel');
    const scanRows = scansPanel.locator('[data-testid="scan-row"]');
    await expect(scanRows).toHaveCount(1, { timeout: 20_000 });
    await expect(scanRows.nth(0)).toHaveAttribute('data-has-data', 'true');
    await expect(scanRows.nth(0)).toHaveAttribute('data-has-params', 'true');

    // --- Build the required voxel grid -------------------------------------
    // A new voxel box is a 1x1x1 m cube at the origin (covers z in [-0.5,0.5]).
    // The leaf cube sits at z in [0,1], so raise the box to center z=0.5. This
    // also opens the Transform panel and selects the box.
    await page.getByTestId('tool-create-voxel').click();
    const posZ = page.getByTestId('mesh-pos-z');
    await expect(posZ).toBeVisible();
    await posZ.fill('0.5');
    await posZ.press('Enter');

    // --- Run LAD ------------------------------------------------------------
    // Creating a voxel box leaves a mixed selection (scan + box). The LAD tool
    // lives on the single-cloud toolbar, so click the scan row to refocus it:
    // in mixed mode a plain click keeps the scan and clears the box selection
    // (it does NOT toggle the scan off — that only happens when the scan is the
    // entire selection).
    // Click the row's NAME, not the row center: the row packs action buttons
    // (eye / misses / edit) on the right, each stopping propagation, and a
    // center click can land on one of those instead of the row's select
    // handler. The name label has no such child, matching how a user clicks a
    // scan to focus it.
    await scanRows.nth(0).getByTestId('scan-row-name').click();
    await expect(scanRows.nth(0)).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('tool-compute-lad').click();
    const ladPopup = page.getByTestId('lad-popup');
    await expect(ladPopup).toBeVisible();

    // A voxel grid exists now, so the no-grid warning must be absent and the
    // grid selector populated.
    await expect(page.getByTestId('lad-no-grid-warning')).toHaveCount(0);
    const gridSelect = page.getByTestId('lad-grid-select');
    await expect(gridSelect).toBeVisible();

    // The new-triangulation path now runs a real Helios triangulation (mesh added
    // to the Meshes panel) and reuses it for the inversion. Lmax defaults to Auto
    // (Otsu); force the C++ self-test value 0.04 so the hollow leaf cube isn't
    // bridged by long triangles that inflate G(theta) and bias the LAD.
    await page.getByTestId('lad-input-lmax').fill('0.04');
    await page.getByTestId('lad-input-aspect').fill('10');
    await page.getByTestId('lad-input-min-hits').fill('1');

    // Set the element width via the Broadleaf preset — this drives the Pimont
    // (2018) uncertainty interval the result panel reports.
    await page.getByTestId('lad-preset-broadleaf').click();
    await expect(page.getByTestId('lad-input-element-width')).toHaveValue('0.05');

    await page.getByTestId('lad-compute-button').click();

    // The LAD result row appears once the live backend returns (cold pyhelios
    // can take a while on the first call).
    const ladRow = page.getByTestId('lad-row').first();
    await expect(ladRow).toBeVisible({ timeout: 120_000 });

    const voxelCount = parseInt((await ladRow.getAttribute('data-voxel-count'))!, 10);
    expect(voxelCount).toBeGreaterThanOrEqual(1);

    // The single voxel's LAD should be near the true 2.0 m^2/m^3. Allow a wide
    // band: point-cloud triangulation is noisier than the C++ synthetic test.
    const ladMax = parseFloat((await ladRow.getAttribute('data-lad-max'))!);
    expect(ladMax).toBeGreaterThan(1.5);
    expect(ladMax).toBeLessThan(2.7);

    // The voxel grid must actually PAINT in the 3D viewer on first completion,
    // with NO visibility toggle. We can't reach into three.js, so assert a
    // DOM-observable render proxy: hover the viewer over the centered leaf-cube
    // grid and require the per-voxel readout to appear. The hover handler
    // resolves a voxel only by R3F raycasting against drawn, pickable instances,
    // so a tooltip is proof the instanced mesh rendered and is interactive.
    // Sweep a few points near center since the exact screen position of the 1 m
    // cube depends on the framing.
    //
    // Note: this guards first-paint render correctness in general. It does NOT
    // deterministically reproduce the specific "grid missing after inversion"
    // bug this assertion was added alongside — that bug needs an R3F mesh
    // *remount* where `drawn` stays referentially stable (a reconciliation
    // re-create), which the single-result leafcube flow doesn't reliably
    // trigger. A negative control (reverting LADVoxelGrid to its dep-array-only
    // fill) still passed here. The fix is in LADVoxelGrid's ref-callback +
    // useLayoutEffect; this is the closest DOM-level render check we can make
    // without window reach-in.
    const canvas = page.locator('canvas').first();
    const cbox = await canvas.boundingBox();
    if (!cbox) throw new Error('viewer canvas has no bounding box');
    const ladTooltip = page.getByTestId('lad-voxel-tooltip');
    const cx = cbox.x + cbox.width / 2;
    const cy = cbox.y + cbox.height / 2;
    const offsets: Array<[number, number]> = [
      [0, 0], [-0.08, 0], [0.08, 0], [0, -0.08], [0, 0.08],
      [-0.08, -0.08], [0.08, 0.08], [-0.12, 0.06], [0.12, -0.06],
    ];
    let sawTooltip = false;
    for (const [dx, dy] of offsets) {
      await page.mouse.move(cx + dx * cbox.width, cy + dy * cbox.height);
      if (await ladTooltip.isVisible().catch(() => false)) { sawTooltip = true; break; }
    }
    expect(sawTooltip, 'LAD voxel grid did not render on first completion (no toggle)').toBe(true);
    // The readout reflects the real voxel value (~2.0 m²/m³), not just presence.
    await expect(ladTooltip).toContainText(/LAD \d/);
    await page.mouse.move(cbox.x + 2, cbox.y + 2); // move off so the tooltip clears
    await expect(ladTooltip).toHaveCount(0);

    // The new-triangulation path emits the surface mesh into the Meshes panel (so
    // the user can inspect/refine it) AND reuses it for this inversion — the same
    // surface G(theta) was derived from. Assert that side effect: a Helios mesh row
    // now exists, and reopening LAD offers it as a reusable triangulation.
    const heliosMeshRow = page.getByTestId('mesh-row')
      .filter({ hasText: 'Helios triangulation' });
    await expect(heliosMeshRow).toBeVisible();

    await scanRows.nth(0).getByTestId('scan-row-name').click();
    await page.getByTestId('tool-compute-lad').click();
    await expect(page.getByTestId('lad-popup')).toBeVisible();
    const triSelect = page.getByTestId('lad-triangulation-select');
    await expect(triSelect).toBeVisible();
    // index 0 = "Run a new triangulation"; the mesh just created is a real option.
    await expect(triSelect.locator('option')).toHaveCount(2);
    await page.getByTestId('lad-close').click();

    // The LAD colorbar reflects the same range.
    const colorbar = page.getByTestId('lad-colorbar');
    await expect(colorbar).toBeVisible();
    await expect(colorbar).toHaveAttribute('data-colorbar-label', /LAD/);
    const cbMax = parseFloat((await colorbar.getAttribute('data-colorbar-max'))!);
    expect(cbMax).toBeGreaterThan(1.5);
    expect(cbMax).toBeLessThan(2.7);

    // Switching the colormap from the LAD row keeps the colorbar present.
    await ladRow.click();
    await page.getByTestId('lad-colormap').selectOption('magma');
    await expect(colorbar).toBeVisible();

    // Selecting the row (done above) expands it; the group-scale Pimont CI
    // summary is shown. For the uniform leaf cube the interval is valid and
    // brackets a mean near the true LAD of 2.0 m²/m³.
    const uncertainty = page.getByTestId('lad-uncertainty-summary');
    await expect(uncertainty).toBeVisible();
    await expect(uncertainty).toContainText(/Mean LAD .*\[.*–.*\] m²\/m³/);
    await expect(uncertainty).toContainText(/95% group-scale CI/);
  } finally {
    await close();
  }
});
