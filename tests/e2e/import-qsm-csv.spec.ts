import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { stubSaveDialog } from './helpers/stubSaveDialog';

// QSM CSV import — the inverse of the export in qsm-export.spec.ts.
//
// The headline test is a real ROUND TRIP against the live backend: build a QSM
// from a point cloud, export it to CSV, delete it, re-import that same file, and
// assert the re-imported QSM is identical — cylinder/shoot counts, trunk and
// scaffold structure, radius range, and every number in the metrics panel. That
// is the user-visible promise of the feature, so it is asserted end to end rather
// than by unit-testing the parser alone (which the pytest suite already does).
//
// The other two tests cover the routing problem `.csv` creates: the extension is
// shared with point clouds, so a QSM CSV must reach the QSM importer and a point
// cloud CSV must still reach the import wizard.

const TREE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');
const UTM_TREE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'utm-tree.xyz');
const QSM_CSV = join(repoRoot, 'tests', 'e2e', 'fixtures', 'qsm-cylinders.csv');
const CLOUD_CSV = join(repoRoot, 'tests', 'e2e', 'fixtures', 'rgb01.csv');

// The data attributes the QSM row publishes, which together pin the model's
// structure: how many cylinders/shoots, how the shoots are ranked, and the
// radius range. A round trip that changed any of them changed the model.
const STRUCTURE_ATTRS = [
  'data-cylinder-count',
  'data-shoot-count',
  'data-trunk-count',
  'data-scaffold-count',
  'data-max-rank',
  'data-min-radius',
  'data-max-radius',
] as const;

async function readQsmStructure(page: Page): Promise<Record<string, string | null>> {
  const row = page.getByTestId('qsm-row').first();
  const out: Record<string, string | null> = {};
  for (const attr of STRUCTURE_ATTRS) out[attr] = await row.getAttribute(attr);
  return out;
}

// The rendered metrics panel text ("Trunk Ø 98.1 mm", etc.) — what the user
// actually reads. Comparing the string, not the float, asserts the panel is
// indistinguishable after a re-import.
async function readQsmMetrics(page: Page): Promise<string> {
  return (await page.getByTestId('qsm-metrics').first().innerText()).replace(/\s+/g, ' ').trim();
}

async function buildQsmFromTree(app: ElectronApplication, page: Page): Promise<void> {
  await importFiles(app, page, 'import-point-cloud', [TREE]);
  await completeImportWizard(page);

  const treeRow = page.locator('[data-testid="scan-row"][data-scan-name="tree.xyz"]');
  await expect(treeRow).toBeVisible({ timeout: 20_000 });
  await expect(treeRow).toHaveAttribute('data-selected', 'true');

  await page.getByTestId('tool-qsm').click();
  await expect(page.getByTestId('qsm-panel')).toBeVisible();
  await page.getByTestId('qsm-build-button').click();
  await expect(page.getByTestId('qsm-row')).toHaveCount(1, { timeout: 120_000 });
}

test.describe('QSM CSV import', () => {
  let app: ElectronApplication;
  let page: Page;
  let close: () => Promise<void>;
  let outDir: string;

  test.beforeAll(async () => {
    ({ app, page, close } = await launchApp());
    await expect(page.getByTestId('backend-splash')).toHaveCount(0, { timeout: 60_000 });
    outDir = mkdtempSync(join(tmpdir(), 'qsm-import-'));
  });

  test.afterAll(async () => {
    rmSync(outDir, { recursive: true, force: true });
    await close();
  });

  test.beforeEach(async () => {
    await resetToFreshScene(app, page);
  });

  test('round-trips a built QSM: export to CSV, re-import, identical model', async () => {
    await buildQsmFromTree(app, page);

    // Snapshot the built QSM before it leaves the app.
    const builtStructure = await readQsmStructure(page);
    const builtMetrics = await readQsmMetrics(page);
    expect(parseInt(builtStructure['data-cylinder-count']!, 10)).toBeGreaterThan(10);
    expect(parseInt(builtStructure['data-shoot-count']!, 10)).toBeGreaterThan(1);
    // A real tree: one trunk and at least one scaffold, so the rank information
    // the round trip must preserve is actually present.
    expect(builtStructure['data-trunk-count']).toBe('1');
    expect(parseInt(builtStructure['data-scaffold-count']!, 10)).toBeGreaterThan(0);
    expect(builtMetrics).toContain('Trunk Ø');

    // --- Export it through the real export dialog ---
    const csvPath = join(outDir, 'round-trip.csv');
    await stubSaveDialog(app, csvPath);
    await page.getByTestId('qsm-export-open').click();
    await expect(page.getByTestId('qsm-export-panel')).toBeVisible();
    await page.getByTestId('qsm-export-format-csv').click();
    await page.getByTestId('qsm-export-confirm').click();
    await expect(page.getByTestId('qsm-export-panel')).toHaveCount(0, { timeout: 30_000 });

    // --- Delete it, so what we assert on next can only be the re-imported one ---
    await page.locator('[data-testid^="qsm-delete-"]').first().click();
    await expect(page.getByTestId('delete-confirm-title')).toBeVisible();
    await page.getByTestId('confirm-delete').click();
    await expect(page.getByTestId('qsm-row')).toHaveCount(0, { timeout: 20_000 });

    // --- Re-import the exported file ---
    await importFiles(app, page, 'import-qsm', [csvPath]);
    await expect(page.getByTestId('qsm-row')).toHaveCount(1, { timeout: 60_000 });

    // The structure is identical, attribute for attribute.
    expect(await readQsmStructure(page)).toEqual(builtStructure);
    // And the metrics panel — recomputed from the CSV, since metrics aren't in
    // the file — reads exactly the same.
    expect(await readQsmMetrics(page)).toBe(builtMetrics);

    // It is a QSM, not a point cloud: nothing landed in the scan list.
    await expect(page.getByTestId('scan-row')).toHaveCount(1); // just the source tree
    // The imported QSM is named after the file it came from.
    await expect(page.getByTestId('qsm-row-name').first()).toHaveText('round-trip');
  });

  test('re-imported QSM lands on its cloud for a UTM (world-shifted) scene', async () => {
    // Regression: QSM cylinders are WORLD-frame, but a projected/UTM cloud is
    // stored and rendered SHIFTED toward the origin for float precision. A built
    // QSM reads that shift through its source scan; an imported one has no source
    // scan, so without carrying its own shift it renders ~4,000 km away — visible
    // to the user as the QSM vanishing the moment it is re-imported.
    await importFiles(app, page, 'import-point-cloud', [UTM_TREE]);
    await completeImportWizard(page);
    const scanRow = page.locator('[data-testid="scan-row"][data-scan-name="utm-tree.xyz"]');
    await expect(scanRow).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('tool-qsm').click();
    await expect(page.getByTestId('qsm-panel')).toBeVisible();
    await page.getByTestId('qsm-build-button').click();
    await expect(page.getByTestId('qsm-row')).toHaveCount(1, { timeout: 120_000 });

    const csvPath = join(outDir, 'utm-round-trip.csv');
    await stubSaveDialog(app, csvPath);
    await page.getByTestId('qsm-export-open').click();
    await expect(page.getByTestId('qsm-export-panel')).toBeVisible();
    await page.getByTestId('qsm-export-format-csv').click();
    await page.getByTestId('qsm-export-confirm').click();
    await expect(page.getByTestId('qsm-export-panel')).toHaveCount(0, { timeout: 30_000 });

    // The exported CSV really does hold raw UTM coordinates — otherwise this
    // test would pass for the wrong reason (nothing to displace).
    const exported = readFileSync(csvPath, 'utf-8').trim().split('\n');
    const startX = parseFloat(exported[1].split(',')[6]);
    expect(Math.abs(startX)).toBeGreaterThan(100_000);

    await page.locator('[data-testid^="qsm-delete-"]').first().click();
    await expect(page.getByTestId('delete-confirm-title')).toBeVisible();
    await page.getByTestId('confirm-delete').click();
    await expect(page.getByTestId('qsm-row')).toHaveCount(0, { timeout: 20_000 });

    // Where the cloud sits in the rendered (stored) frame — near the origin,
    // because the wizard shifted the UTM coordinates away.
    type Framing = { framingBounds: { center: number[] } };
    const readCenter = () => page.evaluate(
      () => (window as unknown as { __getCameraState?: () => Framing })
        .__getCameraState?.().framingBounds.center,
    );

    const cloudCenter = await readCenter();
    expect(cloudCenter).toBeTruthy();
    expect(Math.abs(cloudCenter![0])).toBeLessThan(1000);

    await importFiles(app, page, 'import-qsm', [csvPath]);
    await expect(page.getByTestId('qsm-row')).toHaveCount(1, { timeout: 60_000 });
    await page.waitForTimeout(500); // let the framing bounds recompute

    // The re-imported QSM must render ON the cloud. Without its own worldShift it
    // renders at the raw UTM coordinate (~545000, ~4183000) while the cloud sits
    // near the origin — so compare the framed centre against the cloud's, not
    // against the box size (the box tracks the QSM alone and stays small either
    // way, which is exactly how a size-based assertion passes while displaced).
    const qsmCenter = await readCenter();
    for (let axis = 0; axis < 3; axis++) {
      expect(Math.abs(qsmCenter![axis] - cloudCenter![axis])).toBeLessThan(10);
    }
  });

  test('imported QSM renders in both shoot-rank and shoot-id color modes', async () => {
    await importFiles(app, page, 'import-qsm', [QSM_CSV]);
    await expect(page.getByTestId('qsm-row')).toHaveCount(1, { timeout: 60_000 });

    // The committed fixture's known structure survived the import. It has an
    // axis-continuation shoot (a child that keeps its parent's rank), which a
    // reader enforcing `rank == parent.rank + 1` would have rejected outright.
    const row = page.getByTestId('qsm-row').first();
    await expect(row).toHaveAttribute('data-cylinder-count', '10');
    await expect(row).toHaveAttribute('data-shoot-count', '4');
    await expect(row).toHaveAttribute('data-trunk-count', '2'); // trunk + continuation
    await expect(row).toHaveAttribute('data-scaffold-count', '1');
    await expect(row).toHaveAttribute('data-max-rank', '2');

    // Both color modes key off per-cylinder shoot_id / rank; switching between
    // them must keep the QSM rendered rather than blanking the canvas.
    const canvas = page.locator('canvas').first();
    for (const mode of ['shoot', 'rank']) {
      await page.getByTestId('qsm-color-mode').selectOption(mode);
      await expect(page.getByTestId('qsm-color-mode')).toHaveValue(mode);
      await expect(row).toHaveAttribute('data-visible', 'true');
      await expect(canvas).toBeVisible();
    }
  });

  test('auto-detect routes a QSM CSV to the QSM importer and a cloud CSV to the wizard', async () => {
    // A QSM CSV dropped with no explicit type is recognized by its header and
    // becomes a QSM — it must NOT be eaten by the point-cloud ASCII wizard that
    // otherwise claims every .csv.
    await importFiles(app, page, 'import-auto', [QSM_CSV]);
    await expect(page.getByTestId('qsm-row')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('import-wizard')).toHaveCount(0);
    await expect(page.getByTestId('scan-row')).toHaveCount(0);

    await resetToFreshScene(app, page);

    // The inverse: an ordinary point-cloud CSV still opens the wizard and
    // imports as a scan, with no QSM created.
    await importFiles(app, page, 'import-auto', [CLOUD_CSV]);
    await expect(page.getByTestId('import-wizard')).toBeVisible({ timeout: 60_000 });
    await completeImportWizard(page);
    await expect(page.getByTestId('scan-row')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('qsm-row')).toHaveCount(0);
  });
});
