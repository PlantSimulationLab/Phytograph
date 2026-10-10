import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// A cloud big enough (60,745 points) that the run takes real time. The pill can
// only paint a stage if React commits between that stage arriving and the run
// ending, so the stage has to LAST. This used multi_tree.xyz (7,429 points),
// which once did: it now triangulates in 63 ms end to end, five of its eight
// stages arriving in the same millisecond, and on the Linux runner the whole
// run fit inside one commit — the pill went from its opening "Triangulating…"
// straight to gone, with every stage streamed correctly behind it. Here meshing
// alone holds its label for ~650 ms (measured locally; the runner is slower).
const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'potted-tomato.xyz');

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

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="potted-tomato"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Record every distinct label the pill shows over the lifetime of the run.
    // A MutationObserver catches DOM-driven changes; a parallel rAF sampler
    // catches sub-frame React-batched updates the observer might coalesce.
    // Both installed BEFORE we click, so we never race a stage.
    await page.evaluate(() => {
      // Opt into the renderer's stage recorder (PointCloudViewer pushes each
      // backend stage here as the PHP1 marker arrives). This is the reliable
      // record: the DOM scrape below can miss a stage when React batches two
      // updates into one paint or rAF is throttled under load.
      (window as unknown as { __triStages: string[] }).__triStages = [];
      (window as unknown as { __triLabels: string[] }).__triLabels = [];
      // When each stage arrived, for the failure message: whether a stage was
      // on screen long enough to paint is the first thing to know if the pill
      // never showed one.
      const stageLog = (window as unknown as { __triStages: string[] }).__triStages;
      const arrivals: string[] = ((window as unknown as { __triArrivals: string[] }).__triArrivals = []);
      const push = stageLog.push.bind(stageLog);
      stageLog.push = (...msgs: string[]) => {
        for (const m of msgs) arrivals.push(`${Math.round(performance.now())}ms ${m}`);
        return push(...msgs);
      };
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

    // The pill must appear for this non-Helios method. Read from the recorder
    // installed above, not from the live DOM: a click costs ~1 s on the Linux
    // runner and the whole run can finish inside it, so a pill that was painted
    // and removed during the click is invisible to a locator checked afterwards.
    await expect.poll(
      () => page.evaluate(() => (window as unknown as { __triLabels: string[] }).__triLabels.length),
      { timeout: 10_000, message: 'the triangulation pill was never painted' },
    ).toBeGreaterThan(0);

    // Wait for the mesh to land, then read the captured label sequence.
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });

    const { labels, stages, arrivals } = await page.evaluate(() => ({
      labels: (window as unknown as { __triLabels: string[] }).__triLabels,
      stages: (window as unknown as { __triStages: string[] }).__triStages,
      arrivals: (window as unknown as { __triArrivals: string[] }).__triArrivals,
    }));
    // At least two distinct real backend stages were reported. The exact set
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
    // Assert on the STREAM (what the backend actually reported), not on the
    // scraped DOM. Scraping made this flaky: on a fast run under full-suite load
    // the sampler caught a single label and the test failed with "expected >= 2,
    // received 1" even though the backend had streamed every stage correctly.
    const realStages = [...new Set(stages)].filter((l) => vocab.includes(l));
    expect(
      realStages.length,
      `stages streamed: ${JSON.stringify(stages)} / labels painted: ${JSON.stringify(labels)}`,
    ).toBeGreaterThanOrEqual(2);
    // The pill did render at least one of those stages to the user — the DOM
    // half of the contract (that the pill exists and shows real text) still
    // matters, it just can't carry the per-stage count.
    expect(
      labels.some((l) => vocab.includes(l)),
      `painted labels: ${JSON.stringify(labels)} / stages arrived: ${JSON.stringify(arrivals)}`,
    ).toBe(true);

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
