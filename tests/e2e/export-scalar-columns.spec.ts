import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { stubSaveDialog } from './helpers/stubSaveDialog';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'scalars.xyz');

/**
 * Exporting an octree-backed cloud's SCALAR FIELDS.
 *
 * The bug this covers: export offered only x/y/z for a normally-imported cloud,
 * and silently dropped every scalar. Three independent failures stacked up —
 *
 *   1. the column picker was built from flat `data.scalarFields` / `data.colors`
 *      / an `asciiFormat` hint, none of which an octree cloud has (its fields
 *      live in `octree.attributeRanges`), so it degenerated to bare x/y/z;
 *   2. the renderer's octree export branch never forwarded the picker's chosen
 *      slugs to the backend, so the picker was decorative on that path;
 *   3. the backend's read chokepoint returned positions/colours/intensity only,
 *      so no scalar could reach the writers even if asked for.
 *
 * scalars.xyz routes through convert_to_octree on import (the renderer holds no
 * positions), and carries three real scalars. Two of its headers auto-detect
 * into Helios per-pulse multi-return fields and so take the canonical lowercase
 * slugs `timestamp` / `target_index`; 'Deviation[]' is not a multi-return field
 * and keeps the sanitised `Deviation` (see octree-scalar-color.spec.ts). That
 * makes this fixture the exact shape all three bugs needed.
 *
 * These assert on the CONTENT of the written file, not on the absence of an
 * error: a header naming the scalars and per-point values that match the
 * fixture. Fixture facts (60 data points, header row skipped): Deviation cycles
 * 0,1,2,3,4 and Timestamp starts at 100.0 stepping 2.5.
 *
 * Shared session: one app + backend for the whole file (see CLAUDE.md E2E rules).
 */

let session: LaunchedApp;
test.beforeAll(async () => {
  session = await launchApp();
});
test.afterAll(async () => {
  await session?.close();
});

// Each test imports into a fresh scene. `resetToFreshScene` drives the real
// File → New, so state can't leak between the exports below.
test.beforeEach(async () => {
  const { resetToFreshScene } = await import('./helpers/resetApp');
  await resetToFreshScene(session.app, session.page);
});

async function importAndOpenExport(outName: string) {
  const { app, page } = session;
  const outDir = mkdtempSync(join(tmpdir(), 'phytograph-scalar-export-'));
  const savePath = join(outDir, outName);

  await importFiles(app, page, 'import-point-cloud', FIXTURE);
  await completeImportWizard(page);

  const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]');
  await expect(cloudRow).toBeVisible({ timeout: 20_000 });
  expect(parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);
  await expect(cloudRow).toHaveAttribute('data-selected', 'true');

  await stubSaveDialog(app, savePath);
  await page.evaluate(() => (window as any).__openExportPanel?.());
  await expect(page.getByTestId('export-modal')).toBeVisible();
  return { savePath, page };
}

// Wait for the export to land and return the file text.
async function readExported(savePath: string): Promise<string> {
  await expect
    .poll(() => (existsSync(savePath) ? readFileSync(savePath, 'utf8').length : 0), {
      timeout: 30_000,
      intervals: [200, 500, 1000],
    })
    .toBeGreaterThan(0);
  await expect(
    session.page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }),
  ).toBeVisible({ timeout: 30_000 });
  return readFileSync(savePath, 'utf8');
}

test('the column picker offers the octree cloud\'s imported scalars', async () => {
  const { page } = await importAndOpenExport('picker.csv');

  // CSV is an ASCII format, so the picker shows.
  await page.getByTestId('export-format-csv').click();
  await expect(page.getByTestId('export-column-picker')).toBeVisible();

  // The regression: this list used to be exactly x/y/z. Every imported scalar
  // must be offered — read the real rows out of the DOM.
  const slugs = await page
    .locator('[data-testid="export-column-row"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-slug')));

  expect(slugs).toEqual(expect.arrayContaining(['x', 'y', 'z']));
  expect(slugs).toEqual(
    expect.arrayContaining(['timestamp', 'Deviation', 'target_index']),
  );
  // Geometry stays first so the default order is sane.
  expect(slugs.slice(0, 3)).toEqual(['x', 'y', 'z']);

  // The other half of "offer what the cloud has": PotreeConverter writes the
  // full LAS schema even for an ASCII source, so this octree reports
  // intensity/classification/gps-time/rgb as identically-zero attributes. They
  // must NOT be offered — exporting them would invent fields the file never had,
  // and a re-import would show a real-looking all-zero `classification`.
  for (const phantom of ['classification', 'gps-time', 'return number', 'user data']) {
    expect(slugs).not.toContain(phantom);
  }
  // scalars.xyz carries no colour and no intensity, so neither is offered.
  expect(slugs).not.toContain('r');
  expect(slugs).not.toContain('intensity');
});

test('exports selected scalar columns to CSV with real values', async () => {
  const { savePath, page } = await importAndOpenExport('scalars.csv');
  await page.getByTestId('export-format-csv').click();
  await expect(page.getByTestId('export-column-picker')).toBeVisible();

  // Uncheck one scalar to prove the selection is honored (not "write everything").
  await page.getByTestId('export-column-check-target_index').click();
  await expect(
    page.locator('[data-testid="export-column-row"][data-slug="target_index"]'),
  ).toHaveAttribute('data-selected', 'false');

  await page.getByTestId('export-cloud-go').click();
  const text = await readExported(savePath);

  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  // Header names the kept scalars and omits the unchecked one.
  expect(lines[0]).toContain('Deviation');
  expect(lines[0]).toContain('timestamp');
  expect(lines[0]).not.toContain('target_index');

  const header = lines[0].split(',');
  expect(lines.length).toBe(61); // header + 60 points

  // Every data row has exactly as many cells as the header — the scalars are
  // real columns, not a ragged tail.
  for (const row of lines.slice(1)) {
    expect(row.split(',')).toHaveLength(header.length);
  }

  // Values must be the fixture's, aligned to the right point. Deviation cycles
  // 0,1,2,3,4 down the file and Timestamp starts at 100.0 stepping 2.5.
  const devIdx = header.indexOf('Deviation');
  const tsIdx = header.indexOf('timestamp');
  expect(devIdx).toBeGreaterThan(-1);
  expect(tsIdx).toBeGreaterThan(-1);

  const firstRow = lines[1].split(',');
  expect(Number(firstRow[devIdx])).toBe(0);
  expect(Number(firstRow[tsIdx])).toBeCloseTo(100.0, 3);

  const secondRow = lines[2].split(',');
  expect(Number(secondRow[devIdx])).toBe(1);
  expect(Number(secondRow[tsIdx])).toBeCloseTo(102.5, 3);

  // The full Deviation column is the 0..4 cycle, 12 of each — proves the whole
  // column came through in order, not just its first rows.
  const devs = lines.slice(1).map((l) => Number(l.split(',')[devIdx]));
  expect(devs).toHaveLength(60);
  for (const v of [0, 1, 2, 3, 4]) {
    expect(devs.filter((d) => d === v)).toHaveLength(12);
  }
});

test('drag-reordering the picker changes the file column order', async () => {
  const { savePath, page } = await importAndOpenExport('reordered.csv');
  await page.getByTestId('export-format-csv').click();
  await expect(page.getByTestId('export-column-picker')).toBeVisible();

  // Drag Deviation to the front. The rows use HTML5 drag-and-drop
  // (draggable + onDragStart/onDragOver/onDrop), which Playwright's
  // `locator.dragTo()` does NOT drive — it synthesises mouse moves, and the
  // browser only raises dragstart/drop for a real OS-level drag. Dispatching the
  // drag events directly is what exercises the component's own handlers.
  //
  // The events must be dispatched in SEPARATE tasks: onDragStart records the
  // source index with setDragIdx, and onDrop reads it back. Firing all three
  // synchronously leaves dragIdx still null at drop time (React has not
  // re-rendered), so the reorder silently no-ops.
  const dispatchDrag = (type: string, slug: string | null) =>
    page.evaluate(
      ({ type, slug }) => {
        const rows = Array.from(
          document.querySelectorAll('[data-testid="export-column-row"]'),
        ) as HTMLElement[];
        const el = slug === null
          ? rows[0]
          : rows.find((r) => r.getAttribute('data-slug') === slug);
        if (!el) throw new Error(`drag row not found: ${slug}`);
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: new DataTransfer(),
          }),
        );
      },
      { type, slug },
    );

  await dispatchDrag('dragstart', 'Deviation');
  await dispatchDrag('dragover', null);
  await dispatchDrag('drop', null);

  const slugs = await page
    .locator('[data-testid="export-column-row"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-slug')));
  expect(slugs[0]).toBe('Deviation');

  await page.getByTestId('export-cloud-go').click();
  const text = await readExported(savePath);

  // The user's order is the file's order.
  const header = text.split('\n')[0].split(',');
  expect(header[0]).toBe('Deviation');
});

test('PLY declares selected scalars as named properties', async () => {
  // PLY takes the column picker (an ASCII PLY names each column as a
  // `property`), so a selected scalar must reach the header AND the rows.
  const { savePath, page } = await importAndOpenExport('scalars.ply');
  await page.getByTestId('export-format-ply').click();
  await expect(page.getByTestId('export-column-picker')).toBeVisible();

  await page.getByTestId('export-cloud-go').click();
  const text = await readExported(savePath);

  const [head, body] = text.split('end_header\n');
  expect(head).toContain('property float Deviation');
  expect(head).toContain('element vertex 60');

  const rows = body.split('\n').filter((l) => l.trim().length > 0);
  expect(rows).toHaveLength(60);
  // Column count matches the declared property count.
  const propCount = head.split('\n').filter((l) => l.startsWith('property ')).length;
  expect(rows[0].trim().split(/\s+/)).toHaveLength(propCount);
});

test('LAS offers a field picker and writes every scalar by default', async () => {
  const { savePath, page } = await importAndOpenExport('scalars.las');
  await page.getByTestId('export-format-las').click();

  // LAS gets the picker: each scalar is a declared extra dimension, so a subset
  // is as valid as the full set. Only the STANDARD dimensions are fixed — the
  // note explains those rather than implying the whole schema is.
  const picker = page.getByTestId('export-column-picker');
  await expect(picker).toBeVisible();
  const note = page.getByTestId('export-las-schema-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('extra dimension');
  await expect(note).toContainText('cannot be removed');

  // x/y/z are locked — they ARE the LAS point record.
  for (const slug of ['x', 'y', 'z']) {
    await expect(
      page.locator(`[data-testid="export-column-row"][data-slug="${slug}"]`),
    ).toHaveAttribute('data-locked', 'true');
    await expect(page.getByTestId(`export-column-check-${slug}`)).toBeDisabled();
  }
  // Scalars are NOT locked — that is the whole point.
  await expect(
    page.locator('[data-testid="export-column-row"][data-slug="Deviation"]'),
  ).toHaveAttribute('data-locked', 'false');

  // Order is meaningless in LAS (dimensions are named), so no drag handle.
  await expect(
    page.locator('[data-testid="export-column-row"][data-slug="Deviation"]'),
  ).toHaveAttribute('draggable', 'false');

  // Everything is checked by default, so the default export stays lossless.
  await page.getByTestId('export-cloud-go').click();
  await expect
    .poll(() => (existsSync(savePath) ? readFileSync(savePath).length : 0), {
      timeout: 30_000,
      intervals: [200, 500, 1000],
    })
    .toBeGreaterThan(0);
  await expect(
    page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }),
  ).toBeVisible({ timeout: 30_000 });

  // Assert on the LAS bytes. Extra-dimension names live in the header's VLRs as
  // ASCII, so a name appearing in the file proves the dimension was declared —
  // and the file must be materially larger than a bare xyz+rgb record set.
  const buf = readFileSync(savePath);
  const ascii = buf.toString('latin1');
  expect(ascii.slice(0, 4)).toBe('LASF');
  for (const name of ['Deviation', 'timestamp', 'target_index']) {
    expect(ascii).toContain(name);
  }
});

test('deselecting a scalar omits it from the LAS file', async () => {
  // The claim under test: LAS scalars are freely omittable because each is a
  // declared extra dimension. Asserting on the bytes, since the earlier version
  // of this feature hid the picker on the theory that it was impossible.
  const { savePath, page } = await importAndOpenExport('subset.las');
  await page.getByTestId('export-format-las').click();
  await expect(page.getByTestId('export-column-picker')).toBeVisible();

  await page.getByTestId('export-column-check-Deviation').click();
  await expect(
    page.locator('[data-testid="export-column-row"][data-slug="Deviation"]'),
  ).toHaveAttribute('data-selected', 'false');

  await page.getByTestId('export-cloud-go').click();
  await expect
    .poll(() => (existsSync(savePath) ? readFileSync(savePath).length : 0), {
      timeout: 30_000,
      intervals: [200, 500, 1000],
    })
    .toBeGreaterThan(0);
  await expect(
    page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }),
  ).toBeVisible({ timeout: 30_000 });

  // Extra-dimension names live in the header VLRs as ASCII: the deselected one
  // must be absent while a kept one is still there.
  const ascii = readFileSync(savePath).toString('latin1');
  expect(ascii.slice(0, 4)).toBe('LASF');
  expect(ascii).not.toContain('Deviation');
  expect(ascii).toContain('timestamp');
});

test('re-importing an exported LAS restores the scalar fields', async () => {
  // The round trip is the real contract: a scalar that survives the write but
  // can't be read back is still lost data.
  const { savePath, page } = await importAndOpenExport('roundtrip.las');
  await page.getByTestId('export-format-las').click();
  await page.getByTestId('export-cloud-go').click();
  await expect
    .poll(() => (existsSync(savePath) ? readFileSync(savePath).length : 0), {
      timeout: 30_000,
      intervals: [200, 500, 1000],
    })
    .toBeGreaterThan(0);
  await expect(
    page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }),
  ).toBeVisible({ timeout: 30_000 });

  // Import the file we just wrote, then open Export on it: its picker must offer
  // the same scalars, which is only possible if they round-tripped as named LAS
  // extra dimensions.
  await importFiles(session.app, page, 'import-point-cloud', savePath);
  await completeImportWizard(page);

  const rrow = page.locator('[data-testid="scan-row"][data-scan-name="roundtrip.las"]');
  await expect(rrow).toBeVisible({ timeout: 30_000 });
  expect(parseInt((await rrow.getAttribute('data-point-count')) ?? '0', 10)).toBe(60);

  await page.evaluate(() => (window as any).__openExportPanel?.());
  await expect(page.getByTestId('export-modal')).toBeVisible();
  await page.getByTestId('export-format-csv').click();

  const slugs = await page
    .locator('[data-testid="export-column-row"]')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-slug')));
  for (const name of ['Deviation', 'timestamp', 'target_index']) {
    expect(slugs).toContain(name);
  }
});
