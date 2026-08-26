import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { stubSaveDialog, getSaveDialogCalls } from './helpers/stubSaveDialog';
import { stubOpenDialog } from './helpers/stubOpenDialog';

// Split a CSV line, honouring the RFC4180 quoting buildCrownCsv emits.
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Read a cell by COLUMN NAME, so the assertions survive a column being appended.
function cellsByName(csvText: string): Record<string, string>[] {
  const lines = csvText.trim().split('\n');
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map(l => {
    const cells = splitCsvLine(l);
    expect(cells).toHaveLength(header.length);
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
}

// tree_wood_leaf.xyz is a synthetic single tree: a vertical trunk + two angled
// branches ("wood") and 11 leaf blobs ("leaf"), 4240 points. The workflow:
// import (→ octree/session) → run Wood/Leaf segmentation (real `wood_class`
// labels) → open Fit Crown & Metrics → fit an ellipsoid to the leaf points →
// assert a crown mesh appears with plausible per-crown metrics → export the
// metrics CSV and assert its contents. Drives the real DOM against the live
// backend end-to-end (no mocks), per the E2E rules in CLAUDE.md.
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree_wood_leaf.xyz');

test('fits a crown to leaf points and reports metrics + CSV', async () => {
  // Headroom above this test's longest internal wait (180 s). Without it the
  // per-test cap in playwright.config.ts (180 s) fires FIRST, so that wait can
  // never actually elapse and the test can only report an opaque "Test timeout
  // exceeded" instead of failing on its own assertion. Not a way to make a hang
  // pass — a way to make one fail as the assertion it belongs to.
  test.setTimeout(300_000);

  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // 1) Produce real wood_class labels so the crown fit can use leaf-only points.
    await page.getByTestId('tool-wood-segment').click();
    await expect(page.getByTestId('wood-segment-panel')).toBeVisible();
    await page.getByTestId('wood-segment-run-button').click();
    // Wait for the wood_class recolour (proof segmentation finished).
    const legend = page.getByTestId('class-legend');
    await expect(legend).toBeVisible({ timeout: 60_000 });
    await expect(legend).toHaveAttribute('data-legend-attribute', 'wood_class');

    // 2) Open Fit Crown & Metrics. The picker lists every cloud with data, so we
    // check the scan's row inside the modal rather than relying on the pre-open
    // viewport selection (which the segmentation may have cleared).
    await page.getByTestId('tool-fit-crown').click();
    const popup = page.getByTestId('crown-fit-popup');
    await expect(popup).toBeVisible();

    const pickerRow = popup.locator('[data-testid="picker-row"][data-object-id]').first();
    await expect(pickerRow).toBeVisible();
    const checkbox = pickerRow.locator('input[type="checkbox"]');
    if (!(await checkbox.isChecked())) await checkbox.check();
    await expect(checkbox).toBeChecked();

    // No ground / tree segmentation was run, so the ambiguity warning banner must
    // appear (we warn, never silently proceed) — while the fit stays enabled.
    await expect(page.getByTestId('crown-fit-warning')).toBeVisible();

    // Ellipsoid is the default; set an explicit strictness and enable CSV export.
    await page.getByTestId('crown-shape-select').selectOption('ellipsoid');
    await page.getByTestId('crown-strictness-input').fill('0.2');
    await page.getByTestId('crown-export-csv').check();

    // Route the CSV save dialog to a real temp file (real fs write, asserted below).
    const csvPath = join(tmpdir(), `crown_metrics_${Date.now()}.csv`);
    await stubSaveDialog(app, csvPath);

    // 3) Fit. A progress pill appears while the backend fits (so the user isn't
    // left wondering during the compute), then disappears when it completes.
    await page.getByTestId('crown-fit-run').click();
    const pill = page.getByTestId('crown-fit-running');
    // The pill is transient; it must show at least until the crown mesh lands.
    await expect(pill).toBeVisible({ timeout: 10_000 });

    // A crown mesh appears in the Meshes list. The row's compact summary shows
    // the headline height + volume.
    const crownRow = page.locator('[data-testid="mesh-row"][data-mesh-name*="crown (Ellipsoid)"]');
    await expect(crownRow).toBeVisible({ timeout: 120_000 });
    // …and the pill clears once the fit is done.
    await expect(pill).toBeHidden({ timeout: 30_000 });

    // With no tree segmentation, the crown gets an auto-assigned colour that is
    // distinct from its source scan (the scan is blue #3b82f6).
    const crownColor = await crownRow.getAttribute('data-mesh-color');
    expect(crownColor).toBeTruthy();
    expect(crownColor?.toLowerCase()).not.toBe('#3b82f6');
    await expect(crownRow.getByTestId('mesh-row-count')).toContainText('H ');
    await expect(crownRow.getByTestId('mesh-row-count')).toContainText('Vol ');

    // Expand the row to reveal the full per-crown metrics block.
    await crownRow.getByTestId('mesh-color-expand').click();
    const metrics = page.getByTestId('mesh-crown-metrics');
    await expect(metrics).toBeVisible();
    // The triangulation-oriented controls (color-by dropdown, leaf-angle plot)
    // are irrelevant to an analytic crown solid and must NOT appear in its panel.
    await expect(crownRow.getByTestId('mesh-color-mode')).toHaveCount(0);
    await expect(crownRow.getByTestId('mesh-leaf-angles')).toHaveCount(0);
    // The metrics block reports a plausible tree height and crown volume. The
    // leaf blobs span a few metres tall; assert a sane positive range rather than
    // an exact value (the fit is fuzzy).
    const text = (await metrics.innerText()).replace(/\s+/g, ' ');
    const height = Number(text.match(/Tree height:\s*([\d.]+)\s*m/)?.[1] ?? '0');
    const volume = Number(text.match(/Crown volume:\s*([\d.]+)\s*m/)?.[1] ?? '0');
    expect(height).toBeGreaterThan(0.05);
    expect(height).toBeLessThan(5);
    expect(volume).toBeGreaterThan(0);

    // 4) The CSV export fired and wrote a real file: one header + one data row.
    await expect(async () => {
      expect((await getSaveDialogCalls(app)).length).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000 });
    const csvText = readFileSync(csvPath, 'utf8');
    expect(csvText.split('\n').filter(Boolean)).toHaveLength(2); // header + one crown
    const [row] = cellsByName(csvText);
    expect(row.shape).toBe('ellipsoid');
    expect(Number(row.crown_volume_m3)).toBeGreaterThan(0);
    expect(Number(row.tree_height_m)).toBeGreaterThan(0);

    // The row records the FIT, not just statistics: an ellipsoid's semi-axes are
    // present and reproduce its reported volume (4/3·pi·a·b·c). Before this the
    // table carried no shape parameters at all, so no row could rebuild its crown.
    const a = Number(row.param_a_m), b = Number(row.param_b_m), c = Number(row.param_c_m);
    for (const v of [a, b, c]) expect(v).toBeGreaterThan(0);
    expect((4 / 3) * Math.PI * a * b * c).toBeCloseTo(Number(row.crown_volume_m3), 2);
    // Parameters belonging to the other shapes stay blank.
    expect(row.param_base_radius_m).toBe('');
    expect(row.param_alpha_m).toBe('');
    // An ellipsoid is fully described by those parameters, so it writes no mesh.
    expect(row.mesh_file).toBe('');
    expect(Number(row.mesh_vertices)).toBeGreaterThan(0);

    // ---------------------------------------------------------------------
    // 5) Alpha shape: the case that motivated the mesh sidecar. A concave hull
    // has no analytic parameters, so the export must additionally write the
    // crown's MESH and name it in the row — otherwise the table describes a
    // crown it cannot reproduce. Re-uses the already-segmented cloud rather
    // than re-running the 60s wood segmentation.
    // ---------------------------------------------------------------------
    const outDir = mkdtempSync(join(tmpdir(), 'crown-export-'));
    await stubOpenDialog(app, outDir);

    await page.getByTestId('tool-fit-crown').click();
    await expect(popup).toBeVisible();
    const alphaRow = popup.locator('[data-testid="picker-row"][data-object-id]').first();
    const alphaCheck = alphaRow.locator('input[type="checkbox"]');
    if (!(await alphaCheck.isChecked())) await alphaCheck.check();

    await page.getByTestId('crown-shape-select').selectOption('alpha');
    await page.getByTestId('crown-export-csv').check();
    await page.getByTestId('crown-export-name').fill('alpha_crowns');
    // The mesh-format picker exists ONLY for alpha (the other shapes write no
    // mesh), and the preview tells the user both files are coming.
    await page.getByTestId('crown-mesh-format').selectOption('ply');
    await expect(page.getByTestId('crown-export-preview'))
      .toHaveText('alpha_crowns.csv + one .ply per crown');

    await page.getByTestId('crown-fit-run').click();
    const alphaMesh = page.locator('[data-testid="mesh-row"][data-mesh-name*="crown (Alpha shape)"]');
    await expect(alphaMesh).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('crown-fit-running')).toBeHidden({ timeout: 60_000 });

    // The table landed in the folder the user chose — not behind a Save panel,
    // which can only name one file and this export writes two.
    const alphaCsvPath = join(outDir, 'alpha_crowns.csv');
    await expect(async () => { expect(existsSync(alphaCsvPath)).toBe(true); })
      .toPass({ timeout: 30_000 });
    const [alphaCsvRow] = cellsByName(readFileSync(alphaCsvPath, 'utf8'));
    expect(alphaCsvRow.shape).toBe('alpha');
    // The alpha radius the fit actually used is reported (auto-grown here, since
    // the radius field was left blank) — the one scalar that characterises a hull.
    expect(Number(alphaCsvRow.param_alpha_m)).toBeGreaterThan(0);
    expect(alphaCsvRow.param_alpha_auto).toBe('true');
    // …and the parametric columns stay blank, because a hull has none.
    expect(alphaCsvRow.param_a_m).toBe('');
    expect(alphaCsvRow.param_base_radius_m).toBe('');

    // The mesh_file column names a file that really exists beside the CSV, and
    // that file is this crown's geometry — its vertex count matches the row.
    expect(alphaCsvRow.mesh_file).toBe('alpha_crowns_tree_wood_leaf_crown.ply');
    const meshPath = join(outDir, alphaCsvRow.mesh_file);
    expect(existsSync(meshPath)).toBe(true);
    const ply = readFileSync(meshPath, 'utf8');
    expect(ply.startsWith('ply')).toBe(true);
    const plyVerts = Number(ply.match(/element vertex (\d+)/)?.[1] ?? '0');
    const plyFaces = Number(ply.match(/element face (\d+)/)?.[1] ?? '0');
    expect(plyVerts).toBe(Number(alphaCsvRow.mesh_vertices));
    expect(plyFaces).toBe(Number(alphaCsvRow.mesh_triangles));
    // The written geometry is the ALPHA hull, not the ellipsoid's mesh: a hull is
    // data-dependent, whereas every ellipsoid fit emits the same fixed UV sphere.
    expect(plyVerts).not.toBe(Number(row.mesh_vertices));
    expect(plyFaces).not.toBe(Number(row.mesh_triangles));
    // And it hugs the crown rather than enclosing it, so it bounds less volume
    // than the ellipsoid fitted to the same points.
    expect(Number(alphaCsvRow.crown_volume_m3)).toBeLessThan(Number(row.crown_volume_m3));
  } finally {
    await close();
  }
});
