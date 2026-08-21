import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { stubSaveDialog } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// M4: exporting an octree-backed cloud. tiny.xyz routes through
// convert_to_octree on import, so the cloud has no renderer positions — every
// export format must go through the backend, which streams the source file
// back out. This drives the full path: select → Export panel → XYZ button →
// backend /api/pointcloud/export with a `source` descriptor → base64 decode →
// native save dialog → real fs write. We read the written file back and assert
// it contains the right number of points, proving the octree export round-trips
// real bytes (not "no error").
//
// This asserts against the FILE ON DISK rather than intercepting the blob: the
// export used to hand its bytes to an `<a download>` click, which Electron
// services out-of-band with its own Save-As, so the renderer reported success
// before anything was written. Reading the real file is what makes that
// impossible to regress into.
test('exports an octree-backed cloud to XYZ via the backend', async () => {
  const { app, page, close } = await launchApp();

  try {
    const outDir = mkdtempSync(join(tmpdir(), 'phytograph-octree-export-'));
    const savePath = join(outDir, 'tiny.xyz');

    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    await stubSaveDialog(app, savePath);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    // tiny.xyz has 60 data points (2 comment lines skipped) — same count the
    // triangulate spec relies on.
    const pointCount = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(pointCount).toBe(60);

    // Freshly imported scan is auto-selected (no re-click — that would toggle off).
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Open the export modal, pick the XYZ format, and export (backend path for
    // octree). Export now lives in File → Export (no toolbar icon); under E2E the
    // native menu is disabled, so drive the same renderer entry point the menu
    // uses (__openExportPanel, set in PointCloudViewer).
    await page.evaluate(() => (window as any).__openExportPanel?.());
    await expect(page.getByTestId('export-modal')).toBeVisible();
    await page.getByTestId('export-format-xyz').click();
    await page.getByTestId('export-cloud-go').click();

    // The bytes must land at the chosen path via a real fs write.
    await expect.poll(() => (existsSync(savePath) ? readFileSync(savePath, 'utf8').length : 0), {
      timeout: 30_000,
      intervals: [200, 500, 1000],
    }).toBeGreaterThan(0);

    // A finished export must announce itself — a silent one reads as a no-op and
    // gets re-triggered. Assert the success toast names the file and the real
    // point count, not just that some toast appeared.
    const successToast = page.getByTestId('toast-success').filter({ hasText: 'Export Complete' });
    await expect(successToast).toBeVisible({ timeout: 30_000 });
    await expect(successToast.getByTestId('toast-message')).toHaveText('Wrote tiny.xyz (60 points).');

    // Every non-empty, non-comment line is one "x y z" point — the count must
    // match the source cloud, proving the backend streamed all points.
    const text = readFileSync(savePath, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0 && !l.trim().startsWith('#'));
    expect(lines.length).toBe(60);
    // First line is three parseable floats.
    const cols = lines[0].trim().split(/\s+/).map(Number);
    expect(cols).toHaveLength(3);
    for (const c of cols) expect(Number.isFinite(c)).toBe(true);
  } finally {
    await close();
  }
});
