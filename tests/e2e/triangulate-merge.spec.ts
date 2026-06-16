import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// Two small point clouds, imported through the real dropzone, then triangulated
// through the unified Triangulation modal against the live backend. Exercises
// the new multi-scan Open3D paths:
//   - MERGED: select both scans, merge → ONE mesh row whose provenance reports
//     "Scans fused: 2".
//   - PER-SCAN: select both scans, separate → TWO mesh rows.
//
// Uses the Poisson method (like import-and-triangulate.spec.ts): Ball Pivoting's
// auto radius is unreliable on these sparse 60-point fixtures, whereas Poisson
// reliably produces a mesh — and the merge/per-scan plumbing under test is
// method-agnostic.
//
// Per CLAUDE.md Testing rules: live backend, drive the real UI, assert concrete
// outputs (mesh counts, provenance text), not the absence of errors.
const FIXTURE_A = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');
const FIXTURE_B = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny-offset.xyz');

// Import both fixtures and select both scan rows. Returns the scans panel rows.
async function importAndSelectBoth(app: Parameters<typeof importFiles>[0], page: Parameters<typeof importFiles>[1]) {
  await importFiles(app, page, 'import-auto', [FIXTURE_A, FIXTURE_B]);
  await completeImportWizard(page);

  const rows = page.locator('[data-testid="scan-row"]');
  await expect(rows).toHaveCount(2, { timeout: 20_000 });

  await rows.nth(0).click();
  await rows.nth(1).click({ modifiers: ['ControlOrMeta'] });
  await expect(rows.nth(0)).toHaveAttribute('data-selected', 'true');
  await expect(rows.nth(1)).toHaveAttribute('data-selected', 'true');
  return rows;
}

test('merges two scans into one mesh via the Triangulation modal', async () => {
  const { app, page, close } = await launchApp();
  try {
    await importAndSelectBoth(app, page);

    // Open the modal. Neither scan carries params, so the default method is Ball
    // Pivoting and both scans should be pre-selected in the picker.
    await page.getByTestId('tool-triangulate').click();
    const modal = page.getByTestId('triangulation-popup');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('triangulation-method')).toHaveValue('ball_pivoting');
    await expect(modal.getByTestId('triangulation-scan-row')).toHaveCount(2);

    // Poisson (reliable on sparse fixtures), depth 7. Choose "Merge".
    await modal.getByTestId('triangulation-method').selectOption('poisson');
    await modal.getByTestId('triangulation-poisson-depth').fill('7');
    await modal.getByTestId('triangulation-merge-toggle').getByRole('radio').nth(1).check();

    await modal.getByTestId('triangulation-run-button').click();

    // Exactly one mesh row — the two scans fused into a single mesh.
    const meshRows = page.getByTestId('mesh-row');
    await expect(meshRows).toHaveCount(1, { timeout: 60_000 });
    const meshRow = meshRows.first();
    const trianglesStr = await meshRow.getAttribute('data-triangle-count');
    expect(trianglesStr).not.toBeNull();
    expect(parseInt(trianglesStr!, 10)).toBeGreaterThan(0);

    // Provenance must record the merge (Poisson + "Scans fused: 2").
    await meshRow.getByTestId('mesh-color-expand').click();
    const info = page.getByTestId('mesh-triangulation-info');
    await expect(info).toBeVisible();
    await expect(info).toContainText('Poisson triangulation');
    await expect(info).toContainText('Scans fused: 2');
  } finally {
    await close();
  }
});

test('triangulates two scans separately into two meshes', async () => {
  const { app, page, close } = await launchApp();
  try {
    await importAndSelectBoth(app, page);

    await page.getByTestId('tool-triangulate').click();
    const modal = page.getByTestId('triangulation-popup');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('triangulation-scan-row')).toHaveCount(2);

    // Poisson (reliable on sparse fixtures), depth 7. "Triangulate each scan
    // separately" is the default — assert it, then run.
    await modal.getByTestId('triangulation-method').selectOption('poisson');
    await modal.getByTestId('triangulation-poisson-depth').fill('7');
    await expect(modal.getByTestId('triangulation-merge-toggle').getByRole('radio').nth(0)).toBeChecked();
    await modal.getByTestId('triangulation-run-button').click();

    // One mesh per scan → two mesh rows.
    const meshRows = page.getByTestId('mesh-row');
    await expect(meshRows).toHaveCount(2, { timeout: 60_000 });
    for (let i = 0; i < 2; i++) {
      const ts = await meshRows.nth(i).getAttribute('data-triangle-count');
      expect(ts).not.toBeNull();
      expect(parseInt(ts!, 10)).toBeGreaterThan(0);
    }
  } finally {
    await close();
  }
});
