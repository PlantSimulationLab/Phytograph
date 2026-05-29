import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// Full export round-trip: import → triangulate via the UI → click the
// mesh-OBJ export button → assert the OBJ bytes the renderer would write.
//
// Mesh export in PointCloudViewer.tsx uses a local downloadFile (blob +
// anchor click), not the Electron save-dialog IPC, so the test doesn't
// stub a dialog handler — it intercepts URL.createObjectURL to capture
// the actual Blob the renderer constructs. This exercises the entire
// renderer-side pipeline (selection → exportMesh → OBJ string assembly
// → blob construction) and asserts on the real bytes a user would save.
test('exports a generated mesh to OBJ via the Export panel', async () => {
  const { page, close } = await launchApp();

  try {
    // Patch URL.createObjectURL BEFORE the click so we capture the blob
    // the renderer is about to download. The renderer's downloadFile is
    // synchronous up to the anchor click; the blob.text() promise resolves
    // a tick later, which we poll for below.
    await page.evaluate(() => {
      // Capture downloaded blobs keyed by their object URL. Blob.text() is
      // async, so we stash the text promise when createObjectURL fires and
      // resolve it at anchor.click() (synchronous in the renderer's
      // downloadFile) by looking up the anchor's href. Keying by URL — not a
      // positional sequence — matters because potree-core/three.js create
      // unrelated worker blobs while rendering the octree-backed cloud, which
      // would otherwise be mis-claimed as the export blob.
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
            textPromise.then((text) => {
              captured.push({ name: this.download, text });
            });
          }
          // Suppress the real anchor click so Chromium doesn't dump the
          // file into ~/Downloads — we already have its bytes.
          return;
        }
        return origAnchorClick.call(this);
      };
    });

    // Import the cylinder fixture. The Auto-detect menu item calls
    // react-dropzone's open() under the hood, which fires a real OS file
    // chooser; intercept it before the click so it never surfaces.
    await page.getByTestId('nav-viewer').click();
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-auto').click(),
    ]);
    await chooser.setFiles(FIXTURE);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    await cloudRow.click();

    // Triangulate via the UI (Poisson at non-default depth 7).
    await page.getByTestId('tool-triangulate').click();
    await page.getByTestId('triangulation-method').selectOption('poisson');
    await page.getByTestId('triangulation-poisson-depth').fill('7');
    await page.getByTestId('triangulation-run-button').click();

    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });
    const trianglesStr = await meshRow.getAttribute('data-triangle-count');
    const expectedTriangles = parseInt(trianglesStr ?? '0', 10);
    expect(expectedTriangles).toBeGreaterThan(0);

    // Select the mesh; the cloud must be deselected so the toolbar is in
    // mesh-only mode (otherwise selectionType=='mixed' and the mesh
    // export tool doesn't render).
    await meshRow.click();
    await expect(meshRow).toHaveAttribute('data-selected', 'true');
    await expect(cloudRow).toHaveAttribute('data-selected', 'false');

    // Open mesh export panel and click OBJ.
    await page.getByTestId('tool-export-mesh').click();
    await expect(page.getByTestId('export-panel')).toBeVisible();
    await page.getByTestId('export-mesh-obj').click();

    // Wait for the blob (both name + text) to surface.
    await expect.poll(
      async () =>
        page.evaluate(
          () =>
            ((window as unknown as { __exportedBlobs?: { name: string; text: string }[] })
              .__exportedBlobs ?? []).length,
        ),
      { timeout: 10_000, intervals: [100, 250, 500] },
    ).toBeGreaterThan(0);

    const captured = await page.evaluate(
      () =>
        (window as unknown as { __exportedBlobs: { name: string; text: string }[] })
          .__exportedBlobs[0],
    );

    expect(captured.name).toBe('tiny_mesh.obj');
    const obj = captured.text;

    // Assert on real OBJ structure: banner comment, vertex lines, face lines
    // with the same triangle count the UI reported. This proves the export
    // pipeline produced bytes that match the displayed mesh state.
    expect(obj.startsWith('# Mesh exported from Phytograph')).toBe(true);
    const vertexLines = obj.split('\n').filter((l) => l.startsWith('v '));
    const faceLines = obj.split('\n').filter((l) => l.startsWith('f '));
    expect(vertexLines.length).toBeGreaterThan(0);
    expect(faceLines.length).toBe(expectedTriangles);

    // Each face references 3 valid (1-based) vertex indices.
    for (const f of faceLines.slice(0, 10)) {
      const idxs = f
        .slice(2)
        .trim()
        .split(/\s+/)
        .map((tok) => parseInt(tok.split('/')[0], 10));
      expect(idxs).toHaveLength(3);
      for (const i of idxs) {
        expect(i).toBeGreaterThanOrEqual(1);
        expect(i).toBeLessThanOrEqual(vertexLines.length);
      }
    }
  } finally {
    await close();
  }
});
