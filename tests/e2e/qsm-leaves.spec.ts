import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { stubSaveDialog } from './helpers/stubSaveDialog';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// Drives the Phase-1 procedural leaf reconstruction end-to-end against the LIVE
// backend (no mocks): import a cloud -> Build QSM -> Add Leaves with a builtin
// texture -> assert concrete leaf geometry was produced and rendered, then that
// the leaf-visibility toggle works. The fixture is the same Y-shaped synthetic
// plant the build test uses, which yields a clean 1-trunk + 2-scaffold model
// (the two scaffolds are terminal shoots, so leaves are placed on them).
test('adds procedural leaves to a QSM via the UI', async () => {
  const { app, page, close } = await launchApp();

  try {
    // Import the cloud (intercept the OS file chooser).
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tree"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });

    // Build the QSM.
    await page.getByTestId('tool-qsm').click();
    await expect(page.getByTestId('qsm-panel')).toBeVisible();
    await page.getByTestId('qsm-build-button').click();

    const qsmRow = page.getByTestId('qsm-row').first();
    await expect(qsmRow).toBeVisible({ timeout: 60_000 });

    // --- Open the Add Leaves modal from the QSM row ---
    await page.getByTestId(/^qsm-add-leaves-/).first().click();
    const popup = page.getByTestId('add-leaves-popup');
    await expect(popup).toBeVisible();

    // The phyllotaxis auto-detect runs on open and resolves to a hint (it either
    // detects a pattern or falls back to the default helper text).
    await expect(popup.getByTestId('add-leaves-phyllo-hint')).not.toContainText(
      'Auto-detecting',
      { timeout: 15_000 },
    );

    // The texture picker defaults to a curated builtin (AlmondLeaf). Use a
    // generous spacing so the leaf count stays small and fast.
    await popup.getByTestId('add-leaves-texture-select').selectOption('AlmondLeaf');
    await popup.getByTestId('add-leaves-spacing').fill('0.05');
    await popup.getByTestId('add-leaves-size').fill('0.06');

    // The estimate updates from the QSM's terminal-shoot lengths.
    await expect(popup.getByTestId('add-leaves-estimate')).toContainText('leaves');

    // Submit -> backend places leaves -> the QSM row gains a leaf count.
    await popup.getByTestId('add-leaves-submit').click();
    await expect(popup).toBeHidden();

    const leafCountEl = page.getByTestId(/^qsm-leaf-count-/).first();
    await expect(leafCountEl).toBeVisible({ timeout: 60_000 });
    const leafCount = parseInt((await leafCountEl.getAttribute('data-leaf-count'))!, 10);
    // Concrete output: leaves were actually placed on the terminal shoots.
    expect(leafCount).toBeGreaterThan(0);

    // --- Leaf-visibility toggle works (independent of woody-QSM visibility) ---
    const leafToggle = page.getByTestId(/^qsm-leaves-toggle-/).first();
    await expect(leafToggle).toBeVisible();
    await leafToggle.click();   // hide
    await leafToggle.click();   // show again
    // The QSM and its leaf count are still present after toggling.
    await expect(page.getByTestId('qsm-row')).toHaveCount(1);
    await expect(leafCountEl).toBeVisible();

    // --- Export the leafy QSM to OBJ ---
    // The leaves render as part of the tree, so the export has to carry them:
    // dropping them hands the user a bare winter skeleton. They also carry real
    // alpha-cutout textures, which need `map_d` to come back leaf-shaped rather
    // than as opaque rectangles.
    const outDir = mkdtempSync(join(tmpdir(), 'phytograph-qsm-leaves-'));
    try {
      const objPath = join(outDir, 'leafy.obj');
      await stubSaveDialog(app, objPath);

      await page.getByTestId('qsm-export-open').click();
      await expect(page.getByTestId('qsm-export-panel')).toBeVisible();
      await page.getByTestId('qsm-export-format-obj').click();
      await page.getByTestId('qsm-export-confirm').click();
      await expect(page.getByTestId('qsm-export-panel')).toHaveCount(0, { timeout: 30_000 });

      const obj = readFileSync(objPath, 'utf-8');
      // The leaf geometry is there, as its own group.
      expect(obj).toContain('o leaves');

      // The bundle's siblings landed beside it: the .mtl plus the leaf texture
      // image the MTL names.
      const written = readdirSync(outDir);
      expect(written).toContain('leafy.mtl');
      const mtl = readFileSync(join(outDir, 'leafy.mtl'), 'utf-8');

      // Every texture the MTL references must actually exist on disk — a map_Kd
      // naming a missing file loads as untextured, which is the bug in a
      // different costume.
      const maps = [...mtl.matchAll(/^map_Kd (\S+)$/gm)].map(m => m[1]);
      expect(maps.length).toBeGreaterThan(0);
      for (const m of maps) expect(written).toContain(m);

      // Alpha cutout preserved, so the leaves aren't opaque quads on re-import.
      expect(mtl).toMatch(/^map_d /m);

      // And every index in the leaf faces must fall inside its own 1-based list —
      // OBJ counts v/vt/vn independently, so an off-by-the-wrong-offset here
      // scrambles the leaf textures without any parse error.
      const vCount = [...obj.matchAll(/^v /gm)].length;
      const vtCount = [...obj.matchAll(/^vt /gm)].length;
      const vnCount = [...obj.matchAll(/^vn /gm)].length;
      const leafBlock = obj.slice(obj.indexOf('o leaves'));
      const leafFaces = [...leafBlock.matchAll(/^f (.+)$/gm)].map(m => m[1]);
      expect(leafFaces.length).toBeGreaterThan(0);
      for (const f of leafFaces) {
        for (const tri of f.trim().split(/\s+/)) {
          const [v, vt, vn] = tri.split('/').map(Number);
          expect(v).toBeGreaterThan(0);
          expect(v).toBeLessThanOrEqual(vCount);
          expect(vt).toBeGreaterThan(0);
          expect(vt).toBeLessThanOrEqual(vtCount);
          expect(vn).toBeGreaterThan(0);
          expect(vn).toBeLessThanOrEqual(vnCount);
        }
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    await close();
  }
});
