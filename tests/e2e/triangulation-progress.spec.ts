import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// A larger cloud (7,429 points) so ball pivoting runs long enough that the
// backend's 0.25s progress ticks flush markers in separate network chunks over
// real time — making the per-stage label progression genuinely observable
// (a 60-point cloud meshes in well under one tick and shows only the final
// stage). This exercises the real streaming feed, not a contrived one.
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'multi_tree.xyz');

// The Open3D triangulation methods now show a status pill with real, per-stage
// backend-driven labels (previously only Helios showed any indicator). This test
// drives a ball-pivoting triangulation through the UI against the live backend
// and asserts that:
//   1. The pill appears (data-testid="triangulation-running") — proving a
//      non-Helios method now surfaces progress at all.
//   2. Its label cycles through >= 2 distinct REAL backend stage strings —
//      proving the per-stage feed is wired end to end, not faked.
//   3. A real mesh is produced afterward.
//
// Per CLAUDE.md E2E rules: live backend, real DOM, concrete assertions.
test('ball-pivoting triangulation shows a per-stage progress pill', async () => {
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-auto', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="multi_tree.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Record every distinct label the pill shows over the lifetime of the run.
    // A MutationObserver catches DOM-driven changes; a parallel rAF sampler
    // catches sub-frame React-batched updates the observer might coalesce.
    // Both installed BEFORE we click, so we never race a stage.
    await page.evaluate(() => {
      (window as unknown as { __triLabels: string[] }).__triLabels = [];
      const seen = new Set<string>();
      const record = () => {
        const pill = document.querySelector('[data-testid="triangulation-running"]');
        if (!pill) return;
        const text = (pill.textContent || '').replace(/\s+/g, ' ').trim();
        // Strip the trailing percentage so the stage label is the key.
        const label = text.replace(/\s*\d+%$/, '').trim();
        if (label && !seen.has(label)) {
          seen.add(label);
          (window as unknown as { __triLabels: string[] }).__triLabels.push(label);
        }
      };
      new MutationObserver(record).observe(document.body, {
        subtree: true, childList: true, characterData: true,
      });
      const tick = () => { record(); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });

    // Open the triangulation modal; default method for a param-less import is
    // Ball Pivoting (an Open3D method — the path that previously had no pill).
    await page.getByTestId('tool-triangulate').click();
    const modal = page.getByTestId('triangulation-popup');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('triangulation-method')).toHaveValue('ball_pivoting');

    await modal.getByTestId('triangulation-run-button').click();

    // The pill must appear for this non-Helios method.
    await expect(page.getByTestId('triangulation-running')).toBeVisible({ timeout: 10_000 });

    // Wait for the mesh to land, then read the captured label sequence.
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });

    const labels = await page.evaluate(
      () => (window as unknown as { __triLabels: string[] }).__triLabels,
    );
    // At least two distinct real backend stages were shown. The exact set
    // depends on timing, but they must come from the backend's stage vocabulary.
    const vocab = [
      'Reading points',
      'Preparing point cloud',
      'Estimating normals',
      'Meshing (ball pivoting)',
      'Cleaning up mesh',
      'Computing surface area',
      'Finalizing',
    ];
    const realStages = labels.filter((l) => vocab.includes(l));
    expect(realStages.length).toBeGreaterThanOrEqual(2);

    // And a real mesh was produced.
    const trianglesStr = await meshRow.getAttribute('data-triangle-count');
    expect(trianglesStr).not.toBeNull();
    expect(parseInt(trianglesStr!, 10)).toBeGreaterThan(0);

    // The pill clears once the run finishes.
    await expect(page.getByTestId('triangulation-running')).toBeHidden();
  } finally {
    await close();
  }
});
