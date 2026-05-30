import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// M4: exporting an octree-backed cloud. tiny.xyz routes through
// convert_to_octree on import, so the cloud has no renderer positions — every
// export format must go through the backend, which streams the source file
// back out. This drives the full path: select → Export panel → XYZ button →
// backend /api/pointcloud/export with a `source` descriptor → base64 decode →
// blob download. We capture the blob and assert it contains the right number
// of points, proving the octree export round-trips real bytes (not "no error").
test('exports an octree-backed cloud to XYZ via the backend', async () => {
  const { page, close } = await launchApp();

  try {
    // Capture the downloaded blob. Key by the object URL (not a sequence
    // counter) — potree-core/three.js may create unrelated worker blobs during
    // octree rendering, so a positional claim would grab the wrong one. We map
    // each object URL to its text and look it up by the anchor's href at click.
    await page.evaluate(() => {
      const textByUrl = new Map<string, Promise<string>>();
      const captured: { name: string; text: string }[] = [];
      (window as unknown as { __exportedBlobs: typeof captured }).__exportedBlobs = captured;

      const origCreate = URL.createObjectURL;
      URL.createObjectURL = function (obj: Blob | MediaSource): string {
        const url = origCreate.call(URL, obj);
        if (obj instanceof Blob) textByUrl.set(url, obj.text());
        return url;
      };

      const origAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        if (this.download) {
          const textPromise = textByUrl.get(this.href);
          if (textPromise) {
            textPromise.then((text) => captured.push({ name: this.download, text }));
          }
          return; // suppress real download
        }
        return origAnchorClick.call(this);
      };
    });

    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-pointcloud').click(),
    ]);
    await chooser.setFiles(FIXTURE);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    // tiny.xyz has 60 data points (2 comment lines skipped) — same count the
    // triangulate spec relies on.
    const pointCount = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(pointCount).toBe(60);

    await cloudRow.click();
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Open the cloud export panel and export XYZ (backend path for octree).
    await page.getByTestId('tool-export-cloud').click();
    await expect(page.getByTestId('export-panel')).toBeVisible();
    await page.getByTestId('export-cloud-xyz').click();

    await expect.poll(
      async () =>
        page.evaluate(
          () =>
            ((window as unknown as { __exportedBlobs?: { name: string; text: string }[] })
              .__exportedBlobs ?? []).length,
        ),
      { timeout: 30_000, intervals: [200, 500, 1000] },
    ).toBeGreaterThan(0);

    const captured = await page.evaluate(
      () =>
        (window as unknown as { __exportedBlobs: { name: string; text: string }[] })
          .__exportedBlobs[0],
    );

    expect(captured.name).toBe('tiny.xyz');
    // Every non-empty line is one "x y z" point — the count must match the
    // source cloud, proving the backend streamed all points from the source.
    const lines = captured.text.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(60);
    // First line is three parseable floats.
    const cols = lines[0].trim().split(/\s+/).map(Number);
    expect(cols).toHaveLength(3);
    for (const c of cols) expect(Number.isFinite(c)).toBe(true);
  } finally {
    await close();
  }
});
