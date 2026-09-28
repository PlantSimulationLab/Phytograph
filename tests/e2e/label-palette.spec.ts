import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';
import { stubSaveDialog } from './helpers/stubSaveDialog';
import { stubOpenDialog } from './helpers/stubOpenDialog';
import { readLasClasses } from './helpers/lasClasses';

const TINY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny.xyz');

// User-defined class palettes, end to end against the live backend.
//
// The requirement is "I would like to be able to label anything" — the four
// built-in presets are starting points, not the vocabulary. Before this the
// ClassPalette type, its validation and the whole saved-palette library existed
// and were unit-tested, but nothing in the UI reached them: saveClassPalette had
// no caller. Fully-tested dead code.
//
// What this proves beyond "didn't throw":
//
//   1. A user-defined class can be created, and PAINTED — the point of the
//      feature. Asserted on the backend's own per-class counts, keyed by the
//      custom class VALUE, so it proves the value reached the column.
//   2. The palette survives closing and reopening the tool (it is bound to the
//      cloud, not to the panel's lifetime).
//   3. Validation blocks a save that would corrupt the palette, rather than
//      letting it through and failing later.
//   4. A class that already has points cannot be repointed — doing so would
//      orphan those points against a value the palette no longer describes.
//   5. Saved palettes are reusable: the library persists and can be loaded back.

let session: LaunchedApp;
test.beforeAll(async () => { session = await launchApp(); });
test.afterAll(async () => { await session?.close(); });
test.beforeEach(async () => { await resetToFreshScene(session.app, session.page); });

async function openLabelTool() {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', TINY);
  await completeImportWizard(page);

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-point-count', '60');

  await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
  await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));

  await page.getByTestId('tool-label').click();
  const panel = page.getByTestId('label-panel');
  await expect(panel).toBeVisible();
  return { page, panel };
}

async function openEditor(page: LaunchedApp['page']) {
  await page.getByTestId('label-edit-palette').click();
  const editor = page.getByTestId('class-palette-editor');
  await expect(editor).toBeVisible();
  return editor;
}

async function paintWholeViewport(page: LaunchedApp['page']) {
  const overlay = page.getByTestId('crop-polygon-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('circle')).toHaveCount(0, { timeout: 10_000 });
  const box = await overlay.boundingBox();
  if (!box) throw new Error('crop-polygon-overlay has no bounding box');
  const inset = 8;
  const corners = [
    { x: box.x + inset, y: box.y + inset },
    { x: box.x + box.width - inset, y: box.y + inset },
    { x: box.x + box.width - inset, y: box.y + box.height - inset },
    { x: box.x + inset, y: box.y + box.height - inset },
  ];
  for (let i = 0; i < corners.length; i++) {
    await page.mouse.click(corners[i].x, corners[i].y);
    await expect(overlay.locator('circle')).toHaveCount(i + 1);
  }
  await page.keyboard.press('Enter');
}

async function counts(panel: ReturnType<LaunchedApp['page']['getByTestId']>) {
  const raw = await panel.getAttribute('data-label-counts');
  return JSON.parse(raw ?? '{}') as Record<string, number>;
}

test('a user-defined class can be created and painted', async () => {
  const { page, panel } = await openLabelTool();
  const editor = await openEditor(page);

  const before = Number(await editor.getAttribute('data-class-count'));
  await page.getByTestId('palette-add-class').click();
  await expect(editor).toHaveAttribute('data-class-count', String(before + 1));

  // The new class lands in the user-definable 64+ band, so a future writer to
  // the real LAS classification byte needs no renumbering of painted data.
  const newRow = page.getByTestId('palette-class-row').last();
  const value = Number(await newRow.getAttribute('data-class-value'));
  expect(value).toBeGreaterThanOrEqual(64);

  await newRow.getByTestId('palette-class-label').fill('Mistletoe');
  await page.getByTestId('palette-name').fill('My classes');
  await page.getByTestId('palette-save').click();
  await expect(editor).toHaveCount(0);

  // The custom class is selectable and paintable like any built-in one.
  await expect(panel).toContainText('Mistletoe');
  await panel.getByText('Mistletoe').click();
  await paintWholeViewport(page);

  // The backend's own counts, keyed by the CUSTOM value — this is what proves
  // the user's class reached the column, not just the panel.
  await expect.poll(async () => (await counts(panel))[String(value)], { timeout: 30_000 })
    .toBe(60);
});

test('editing a class: Backspace deletes text, and a new class gets its own color', async () => {
  const { page } = await openLabelTool();
  await openEditor(page);

  await page.getByTestId('palette-add-class').click();
  const rows = page.getByTestId('palette-class-row');
  const newRow = rows.last();

  // A new class must not reuse Unclassified's gray (or any sibling's color),
  // or it paints invisibly over unlabeled points.
  const newColor = await newRow.getByTestId('palette-class-color').inputValue();
  const others = await rows.evaluateAll((els) => els.slice(0, -1).map((el) =>
    (el.querySelector('[data-testid="palette-class-color"]') as HTMLInputElement).value));
  expect(others.length).toBeGreaterThan(0);
  expect(others).not.toContain(newColor);

  // Real keystrokes, not fill(): the bug was a viewer-wide keydown handler
  // (the label lasso's "pop the last vertex") swallowing Backspace, which
  // fill() never dispatches.
  const label = newRow.getByTestId('palette-class-label');
  await label.click();
  await label.press('ControlOrMeta+a');
  await label.pressSequentially('Mistletoe');
  await label.press('Backspace');
  await label.press('Backspace');
  await expect(label).toHaveValue('Mistlet');
});

test('a saved palette survives closing and reopening the tool', async () => {
  const { page, panel } = await openLabelTool();
  const editor = await openEditor(page);

  await page.getByTestId('palette-add-class').click();
  await page.getByTestId('palette-class-row').last()
    .getByTestId('palette-class-label').fill('Epiphyte');
  await page.getByTestId('palette-name').fill('Canopy set');
  await page.getByTestId('palette-save').click();
  await expect(editor).toHaveCount(0);
  await expect(panel).toContainText('Epiphyte');

  // Close the tool entirely, then reopen it. The palette is bound to the CLOUD,
  // so the user's own classes come back rather than reverting to the preset.
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await page.getByTestId('tool-label').click();
  const reopened = page.getByTestId('label-panel');
  await expect(reopened).toBeVisible();
  await expect(reopened).toContainText('Epiphyte');
});

test('validation blocks a save that would corrupt the palette', async () => {
  const { page } = await openLabelTool();
  const editor = await openEditor(page);

  // An empty class name is an error, not a warning — saving it would put a
  // nameless row in the legend and in every split-by-class child.
  await page.getByTestId('palette-add-class').click();
  await page.getByTestId('palette-class-row').last()
    .getByTestId('palette-class-label').fill('');

  await expect(page.getByTestId('palette-issue-error')).toBeVisible();
  await expect(page.getByTestId('palette-save')).toBeDisabled();

  // Giving it a name clears the error and re-enables saving.
  await page.getByTestId('palette-class-row').last()
    .getByTestId('palette-class-label').fill('Named');
  await expect(editor).toHaveAttribute('data-error-count', '0');
  await expect(page.getByTestId('palette-save')).toBeEnabled();
});

test('a class that already has points cannot be repointed', async () => {
  // The backend column stores real class VALUES. Changing the value of a class
  // that already has points would leave them holding a number the palette no
  // longer describes — they would read as unlabeled, with no warning and no
  // undo. Renaming and recoloring stay available, because those are safe.
  const { page, panel } = await openLabelTool();

  // Paint with the first non-Unclassified class so it genuinely has points.
  await paintWholeViewport(page);
  await expect.poll(async () => Object.values(await counts(panel)).some(n => n === 60),
    { timeout: 30_000 }).toBe(true);

  await openEditor(page);
  // data-value-locked sits ON the row, so match the attribute directly rather
  // than filtering for a descendant that carries it.
  const locked = page.locator('[data-testid="palette-class-row"][data-value-locked="true"]');

  // Unclassified is always locked; the class we just painted must be too.
  await expect(locked.first()).toBeVisible();
  const lockedValues = await locked.evaluateAll(
    rows => rows.map(r => r.getAttribute('data-class-value')),
  );
  expect(lockedValues).toContain('0');                     // Unclassified
  expect(lockedValues.length).toBeGreaterThanOrEqual(2);   // 0 + the painted one

  // The value field is read-only, but the NAME is still editable — a lock on
  // the value must not freeze the whole row.
  const lockedRow = locked.last();
  await expect(lockedRow.getByTestId('palette-class-value')).toHaveAttribute('readonly', '');
  await expect(lockedRow.getByTestId('palette-class-label')).not.toHaveAttribute('readonly', '');
});

test('saved palettes are reusable from the library', async () => {
  const { page } = await openLabelTool();
  const editor = await openEditor(page);

  await page.getByTestId('palette-add-class').click();
  await page.getByTestId('palette-class-row').last()
    .getByTestId('palette-class-label').fill('Deadwood');
  await page.getByTestId('palette-name').fill('Reusable set');
  await page.getByTestId('palette-save').click();
  await expect(editor).toHaveCount(0);

  // Reopening shows it in the library — the persistence layer is what makes a
  // palette a shareable asset rather than per-cloud state.
  const reopened = await openEditor(page);
  const row = page.getByTestId('palette-library-row').filter({ hasText: 'Reusable set' });
  await expect(row).toBeVisible();

  // And loading it back applies its classes.
  await row.getByTestId('palette-library-load').click();
  await expect(reopened).toHaveCount(0);
  await expect(page.getByTestId('label-panel')).toContainText('Deadwood');
});

// ── Labeling a column the cloud already carries ─────────────────────────────
//
// The gap these close: the tool could only paint the four columns its presets
// named, so a cloud whose OWN classification was wrong — the motivating case is
// a tree segmentation that merged two trees into one — could not be corrected
// by hand at all. `tiny-treeinstance.xyz` reproduces that shape exactly: a
// tree_instance column holding only 1 (24 points) and 2 (36 points), no zeros.

const TREE_FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tiny-treeinstance.xyz');

async function openLabelToolOnTreeCloud(
  fixture = TREE_FIXTURE, name = 'tiny-treeinstance', points = 60,
) {
  const { app, page } = session;
  await importFiles(app, page, 'import-auto', fixture);

  // Name the 4th column and mark it a Label, exactly as a user would — this is
  // what makes it `tree_instance` on the cloud rather than an anonymous scalar.
  const wizard = page.getByTestId('import-wizard');
  await expect(wizard).toBeVisible({ timeout: 30_000 });
  // Role FIRST: the rename box only renders for a column that already has a
  // scalar/label role, so naming before assigning finds no input.
  const roles = page.getByTestId('import-wizard-role');
  await expect(roles.first()).toBeVisible({ timeout: 30_000 });
  await roles.last().selectOption('label');
  await page.getByTestId('import-wizard-name').last().fill('tree_instance');
  await completeImportWizard(page);

  const row = page.locator(`[data-testid="scan-row"][data-scan-name="${name}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute('data-point-count', String(points));

  await page.waitForFunction(() => typeof (window as any).__orientToAxis === 'function');
  await page.evaluate(() => (window as any).__orientToAxis({ x: 0, y: 1, z: 0 }));

  await page.getByTestId('tool-label').click();
  const panel = page.getByTestId('label-panel');
  await expect(panel).toBeVisible();
  return { page, panel };
}

test('the tool opens on the cloud own classification, with its real classes', async () => {
  const { page, panel } = await openLabelToolOnTreeCloud();

  // Opened on tree_instance, not on the empty hand-labeling column. This is
  // the whole feature: before it, this cloud offered wood/leaf over an empty
  // manual_class and the tree instances were unreachable.
  await expect(panel).toHaveAttribute('data-label-slug', 'tree_instance');
  await expect(page.getByTestId('label-column-select')).toHaveValue('tree_instance');

  // The classes are the column's REAL values, with Unassigned synthesized.
  await expect(panel.getByTestId('label-class-0')).toContainText('Unassigned');
  await expect(panel.getByTestId('label-class-1')).toContainText('Tree 1');
  await expect(panel.getByTestId('label-class-3')).toContainText('Tree 3');

  // And NO Tree 2. The fixture's values are {1, 3}, so a class list derived
  // from the column's [min,max] instead of its exact surviving values would
  // invent a Tree 2 owning no points — the failure a contiguous fixture cannot
  // distinguish, since there the two derivations agree.
  await expect(panel.getByTestId('label-class-2')).toHaveCount(0);

  // The backend's own per-class counts for THIS column. The uneven 24/36 split
  // is deliberate: equal counts would let a swapped class list still pass.
  // Unassigned must read 0 — the column has no zeros — rather than 60, which is
  // what a freshly-created column would report.
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 24, '3': 36 });
});

test('repainting moves points between the column real classes', async () => {
  const { page, panel } = await openLabelToolOnTreeCloud();

  // Paint everything as Tree 1. If the tool had created a PARALLEL column
  // instead of editing the imported one, the starting counts would have been
  // {0: 60} and this would read 60 either way — the undo below is what proves
  // the original values were there to restore.
  await panel.getByTestId('label-class-1').click();
  await paintWholeViewport(page);
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 60 });

  // Undo restores the file's own values exactly.
  await page.getByTestId('label-undo').click();
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 24, '3': 36 });
});

test('a new tree id can be added and painted, continuing the column numbering', async () => {
  const { page, panel } = await openLabelToolOnTreeCloud();
  const editor = await openEditor(page);

  // Splitting a wrongly-merged tree needs a NEW id. It must continue the
  // column's own numbering (Tree 3) rather than jumping to the 64+ custom band,
  // which would read wrong and leave a 61-value hole in the legend.
  await page.getByTestId('palette-add-class').click();
  const newRow = page.getByTestId('palette-class-row').last();
  // Continues the column's own numbering past its highest id rather than
  // jumping to the 64+ custom band, which would read wrong beside Tree 1 /
  // Tree 3 and leave a 60-value hole in the legend.
  await expect(newRow).toHaveAttribute('data-class-value', '4');
  await expect(newRow.getByTestId('palette-class-label')).toHaveValue('Tree 4');

  await page.getByTestId('palette-save').click();
  await expect(editor).toHaveCount(0);

  // And it paints into the same column.
  await panel.getByTestId('label-class-4').click();
  await paintWholeViewport(page);
  await expect.poll(async () => (await counts(panel))['4'], { timeout: 30_000 }).toBe(60);
  await expect(panel).toHaveAttribute('data-label-slug', 'tree_instance');
});

test('a brand-new classification column can be created, painted and committed', async () => {
  const { page, panel } = await openLabelToolOnTreeCloud();

  // Requirement 2: a custom classification is a NEW COLUMN, not just new
  // classes inside manual_class.
  await page.getByTestId('label-column-select').selectOption('__new__');
  const editor = page.getByTestId('class-palette-editor');
  await expect(editor).toBeVisible();

  await page.getByTestId('palette-column-name').fill('Row QC');
  await expect(page.getByTestId('palette-column-slug')).toHaveAttribute('data-slug', 'row_qc');

  await page.getByTestId('palette-add-class').click();
  const qcRow = page.getByTestId('palette-class-row').last();
  const qcValue = Number(await qcRow.getAttribute('data-class-value'));
  await qcRow.getByTestId('palette-class-label').fill('Suspect');
  await page.getByTestId('palette-save').click();
  await expect(editor).toHaveCount(0);

  // The tool followed the user onto their new column.
  await expect(panel).toHaveAttribute('data-label-slug', 'row_qc');

  // Target the class ROW by value: the name also appears in the "Painting X
  // over Y" sentence once it is active, which makes a by-text click ambiguous.
  await panel.getByTestId(`label-class-${qcValue}`).click();
  await paintWholeViewport(page);
  await expect.poll(async () => (await counts(panel))[String(qcValue)], { timeout: 30_000 })
    .toBe(60);

  // Closing the panel bakes it into the cloud, and the column becomes a real
  // one the rest of the app can see — which is what makes it a CLASSIFICATION
  // rather than a scratch buffer inside the tool.
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await page.getByTestId('tool-label').click();
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('label-column-select').locator('option[value="row_qc"]'))
    .toHaveCount(1, { timeout: 120_000 });

  // The original tree_instance column is untouched and still selectable.
  await expect(page.getByTestId('label-column-select').locator('option[value="tree_instance"]'))
    .toHaveCount(1);
});

test('a column name that collides with a LAS dimension is refused', async () => {
  const { page } = await openLabelToolOnTreeCloud();

  await page.getByTestId('label-column-select').selectOption('__new__');
  const editor = page.getByTestId('class-palette-editor');
  await expect(editor).toBeVisible();

  // `classification` is the name that would make laspy bit-pack a float column
  // into the classification-flags byte and hard-crash the backend. Refusing it
  // here means the user never meets that as a 400 on their first stroke.
  await page.getByTestId('palette-column-name').fill('Classification');
  await expect(page.getByTestId('palette-save')).toBeDisabled();

  // A column the cloud already has is refused too — it would silently merge
  // into the existing one rather than creating anything.
  await page.getByTestId('palette-column-name').fill('tree instance');
  await expect(page.getByTestId('palette-save')).toBeDisabled();

  await page.getByTestId('palette-column-name').fill('Row QC');
  await expect(page.getByTestId('palette-save')).toBeEnabled();
});

test('uncommitted strokes stay with their column when the column is switched', async () => {
  // Switching column used to be BLOCKED with strokes pending, because the
  // renderer held one stroke list while the backend keys its undo history per
  // column. The renderer now keys pending strokes per (cloud, column) too, so a
  // switch is free: the new column starts clean and the old one's strokes are
  // still pending when the user comes back.
  const { page, panel } = await openLabelToolOnTreeCloud();

  await panel.getByTestId('label-class-1').click();
  await paintWholeViewport(page);
  await expect(panel).toHaveAttribute('data-pending-strokes', '1', { timeout: 30_000 });
  await expect(panel).toHaveAttribute('data-label-dirty', 'true');

  await page.getByTestId('label-column-select').selectOption('manual_class');
  await expect(panel).toHaveAttribute('data-label-slug', 'manual_class');
  await expect(panel).toHaveAttribute('data-pending-strokes', '0');
  await expect(panel).toHaveAttribute('data-label-dirty', 'false');
  await expect(page.getByTestId('label-undo')).toBeDisabled();

  await page.getByTestId('label-column-select').selectOption('tree_instance');
  await expect(panel).toHaveAttribute('data-label-slug', 'tree_instance');
  await expect(panel).toHaveAttribute('data-pending-strokes', '1');
  await expect(page.getByTestId('label-undo')).toBeEnabled();
});

test('a user class (64+) survives a LAS export in the classification byte', async () => {
  // Every user class starts at 64, and the legacy LAS point formats hold only
  // five bits of class: the export raised OverflowError on any painted cloud.
  const { app } = session;
  const { page, panel } = await openLabelTool();
  const editor = await openEditor(page);
  await page.getByTestId('palette-add-class').click();
  const newRow = page.getByTestId('palette-class-row').last();
  const value = Number(await newRow.getAttribute('data-class-value'));
  expect(value).toBeGreaterThanOrEqual(64);
  await newRow.getByTestId('palette-class-label').fill('Mistletoe');
  await page.getByTestId('palette-save').click();
  await expect(editor).toHaveCount(0);

  await panel.getByTestId(`label-class-${value}`).click();
  await paintWholeViewport(page);
  await expect.poll(async () => (await counts(panel))[String(value)], { timeout: 30_000 })
    .toBe(60);

  const savePath = join(mkdtempSync(join(tmpdir(), 'phytograph-label-las-')), 'labeled.las');
  await stubSaveDialog(app, savePath);
  await page.evaluate(() => (window as any).__openExportPanel?.());
  await expect(page.getByTestId('export-modal')).toBeVisible();
  await page.getByTestId('export-format-las').click();
  await page.getByTestId('export-cloud-go').click();
  await expect(
    page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }),
  ).toBeVisible({ timeout: 30_000 });

  const { format, classes } = readLasClasses(savePath);
  expect([6, 7]).toContain(format);
  expect(classes).toHaveLength(60);
  expect(classes.every((c) => c === value)).toBe(true);
});

/**
 * The color each of the fixture's points is DRAWN in, read from a screenshot
 * at the point's own projected position (so the label panel's and the legend's
 * swatches of the same colors cannot be counted). Points under the label panel
 * are skipped. Returns how many points read as magenta and as cyan.
 */
async function pointHues(page: LaunchedApp['page']) {
  const pts = readFileSync(TINY, 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.trim().split(/\s+/).slice(0, 3).map(Number) as [number, number, number]);
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const png = await canvas.screenshot();
  return page.evaluate(async ({ src, box, pts }) => {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(); img.src = src; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const sx = c.width / box.width; const sy = c.height / box.height;
    const panel = document.querySelector('[data-testid="label-panel"]')?.getBoundingClientRect();
    let magenta = 0; let cyan = 0;
    for (const w of pts) {
      const p = (window as any).__worldToScreen(w);
      if (!p.visible) continue;
      if (panel && p.x >= panel.left - 4 && p.x <= panel.right + 4
          && p.y >= panel.top - 4 && p.y <= panel.bottom + 4) continue;
      const cx = Math.round((p.x - box.x) * sx); const cy = Math.round((p.y - box.y) * sy);
      let m = false; let cy_ = false;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx; const y = cy + dy;
        if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
        const i = (y * c.width + x) * 4;
        const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
        if (r > 120 && b > 120 && g < 0.5 * Math.min(r, b)) m = true;
        if (g > 120 && b > 120 && r < 0.5 * Math.min(g, b)) cy_ = true;
      }
      if (m) magenta++;
      if (cy_) cyan++;
    }
    return { magenta, cyan };
  }, { src: `data:image/png;base64,${png.toString('base64')}`, box, pts });
}

test('committed labels keep their color when the class numbers have gaps', async () => {
  // The overlay's buffer holds palette POSITIONS (0, 1, 2…) but a commit's
  // octree holds class VALUES (0, 64, 65). Copied straight in, a committed 64
  // was drawn as position 64 — past the end of a 3-class gradient, so as the
  // LAST class's color. Painted as 64 (magenta) it must stay magenta, not
  // turn into 65's cyan.
  const { page, panel } = await openLabelTool();
  const editor = await openEditor(page);
  await page.getByTestId('palette-add-class').click();
  await page.getByTestId('palette-add-class').click();
  const rows = page.getByTestId('palette-class-row');
  const n = await rows.count();
  const r64 = rows.nth(n - 2); const r65 = rows.nth(n - 1);
  await expect(r64).toHaveAttribute('data-class-value', '64');
  await expect(r65).toHaveAttribute('data-class-value', '65');
  await r64.getByTestId('palette-class-label').fill('Magenta');
  await r64.getByTestId('palette-class-color').fill('#ff00ff');
  await r65.getByTestId('palette-class-label').fill('Cyan');
  await r65.getByTestId('palette-class-color').fill('#00ffff');
  // Only {0, 64, 65}: remove the preset's own classes so the palette is gapped.
  for (;;) {
    const values = await rows.evaluateAll(
      (els) => els.map((e) => Number(e.getAttribute('data-class-value'))));
    const i = values.findIndex((v) => v !== 0 && v !== 64 && v !== 65);
    if (i < 0) break;
    await rows.nth(i).getByTestId('palette-class-remove').click();
  }
  await page.getByTestId('palette-save').click();
  await expect(editor).toHaveCount(0);

  await panel.getByTestId('label-class-64').click();
  await paintWholeViewport(page);
  await expect.poll(async () => (await counts(panel))['64'], { timeout: 30_000 }).toBe(60);
  // Before the commit the overlay draws the stroke itself: magenta.
  await expect.poll(async () => (await pointHues(page)).magenta, { timeout: 15_000 })
    .toBeGreaterThan(40);

  // Closing the panel bakes the column into a rebuilt octree (a new cache id).
  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny"]');
  const before = await row.getAttribute('data-octree-cache-id');
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await expect(row).not.toHaveAttribute('data-octree-cache-id', before ?? '', { timeout: 90_000 });
  // Reopened, the overlay's baseline is the BAKED column, read from the octree:
  // still magenta, no cyan.
  await page.getByTestId('tool-label').click();
  await expect(panel).toHaveAttribute('data-pending-strokes', '0');
  await expect.poll(async () => {
    const h = await pointHues(page);
    return h.magenta > 40 && h.cyan === 0;
  }, { timeout: 20_000 }).toBe(true);
});

test('tree ids above 255 can be added and painted, 300 then 301', async () => {
  // Every class value was capped at one byte, so a plot with more than 255
  // trees could not number a new one: the editor refused 300 and the backend
  // answered 400. Instance columns now run past it.
  const { page, panel } = await openLabelToolOnTreeCloud();
  const addTree = async (value: number) => {
    const editor = await openEditor(page);
    await page.getByTestId('palette-add-class').click();
    const row = page.getByTestId('palette-class-row').last();
    await row.getByTestId('palette-class-value').fill(String(value));
    await expect(row).toHaveAttribute('data-class-value', String(value));
    await row.getByTestId('palette-class-label').fill(`Tree ${value}`);
    await expect(page.getByTestId('palette-save')).toBeEnabled();
    await page.getByTestId('palette-save').click();
    await expect(editor).toHaveCount(0);
  };

  await addTree(300);
  await panel.getByTestId('label-class-300').click();
  await paintWholeViewport(page);
  await expect.poll(async () => (await counts(panel))['300'], { timeout: 30_000 }).toBe(60);

  // Split it: 301, gated on 300 so only tree 300's points move.
  await addTree(301);
  await panel.getByTestId('label-class-301').click();
  await page.getByTestId('label-from-300').click();
  await paintWholeViewport(page);
  await expect.poll(async () => (await counts(panel))['301'], { timeout: 30_000 }).toBe(60);
  expect((await counts(panel))['300'] ?? 0).toBe(0);
  await expect(panel).toHaveAttribute('data-label-slug', 'tree_instance');
});

test('a hundred trees each draw in their own color', async () => {
  // potree-core bakes class colors into a 64-pixel, linearly filtered
  // gradient. Past ~64 classes, neighboring trees shared a pixel and drew as
  // an averaged color that belongs to neither. The fixture's 100 trees sit in
  // a 10x10 grid; each must be drawn in the color its class row shows.
  const fixture = join(repoRoot, 'tests', 'e2e', 'fixtures', 'hundred-trees.xyz');
  const { page, panel } = await openLabelToolOnTreeCloud(fixture, 'hundred-trees', 500);
  await expect(panel).toHaveAttribute('data-label-slug', 'tree_instance');
  await expect(page.getByTestId('label-class-100')).toBeVisible();
  // A palette this size is still hard to read by eye, and the panel says so
  // (a derived palette never passes through the editor, which used to be the
  // only place the warning appeared).
  await expect(page.getByTestId('label-palette-warning')).toContainText('101 classes');

  const expected: Record<number, string> = {};
  for (let k = 1; k <= 100; k++) {
    expected[k] = (await page.getByTestId(`label-class-${k}`).getAttribute('data-color'))!;
  }
  const centers = Array.from({ length: 100 }, (_, k) =>
    ({ id: k + 1, w: [(k % 10) * 0.3, 0, Math.floor(k / 10) * 0.3] as [number, number, number] }));

  const canvas = page.locator('canvas').first();
  const read = async () => {
    const box = (await canvas.boundingBox())!;
    const png = await canvas.screenshot();
    return page.evaluate(async ({ src, box, centers, expected }) => {
      const img = new Image();
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(); img.src = src; });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const sx = c.width / box.width; const sy = c.height / box.height;
      const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      const panel = document.querySelector('[data-testid="label-panel"]')?.getBoundingClientRect();
      let checked = 0; const wrong: number[] = [];
      for (const { id, w } of centers) {
        const p = (window as any).__worldToScreen(w);
        if (!p.visible) continue;
        if (panel && p.x >= panel.left - 6 && p.x <= panel.right + 6
            && p.y >= panel.top - 6 && p.y <= panel.bottom + 6) continue;
        const [er, eg, eb] = hex(expected[id]);
        const cx = Math.round((p.x - box.x) * sx); const cy = Math.round((p.y - box.y) * sy);
        let best = Infinity;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const i = ((cy + dy) * c.width + (cx + dx)) * 4;
          best = Math.min(best, Math.hypot(d[i] - er, d[i + 1] - eg, d[i + 2] - eb));
        }
        checked++;
        if (best > 40) wrong.push(id);
      }
      return { checked, wrong };
    }, { src: `data:image/png;base64,${png.toString('base64')}`, box, centers, expected });
  };

  await expect.poll(async () => {
    const r = await read();
    return r.checked >= 60 && r.wrong.length === 0 ? 'ok' : JSON.stringify(r);
  }, { timeout: 20_000 }).toBe('ok');
});

test('a class value can be cleared and retyped', async () => {
  // The value field was a number input bound to the parsed number, so clearing
  // it snapped straight back and the next keystrokes appended to the old value:
  // retyping 64 as 77 produced 6477.
  const { page } = await openLabelTool();
  await openEditor(page);
  await page.getByTestId('palette-add-class').click();
  const row = page.getByTestId('palette-class-row').last();
  await expect(row).toHaveAttribute('data-class-value', '64');
  const field = row.getByTestId('palette-class-value');
  await field.fill('');
  await expect(field).toHaveValue('');
  await field.pressSequentially('77');
  await field.press('Tab');
  await expect(row).toHaveAttribute('data-class-value', '77');
  await expect(field).toHaveValue('77');
});

test('editing the stock preset in two projects keeps both in the library', async () => {
  // Saved palettes are keyed by id, and an edited preset kept the preset's
  // fixed id (`preset-wood-leaf`). Editing the stock preset again on the next
  // project and saving replaced the first project's palette in the library.
  for (const [cls, name] of [['Mistletoe', 'Project one'], ['Deadwood', 'Project two']]) {
    await resetToFreshScene(session.app, session.page);   // a new project
    const { page } = await openLabelTool();
    await openEditor(page);
    await page.getByTestId('palette-add-class').click();
    await page.getByTestId('palette-class-row').last()
      .getByTestId('palette-class-label').fill(cls);
    await page.getByTestId('palette-name').fill(name);
    await page.getByTestId('palette-save').click();
    await expect(page.getByTestId('class-palette-editor')).toHaveCount(0);
  }
  const { page } = session;
  await openEditor(page);
  await expect(page.getByTestId('palette-library-row').filter({ hasText: 'Project one' }))
    .toBeVisible();
  await expect(page.getByTestId('palette-library-row').filter({ hasText: 'Project two' }))
    .toBeVisible();
});

test('instances: new, merge, delete and frame, each undoable', async () => {
  // tree_instance holds 1 (24 points, centered z = 0.1875) and 3 (36 points,
  // centered z = 1.125).
  const { page, panel } = await openLabelToolOnTreeCloud();
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 24, '3': 36 });
  const inst = page.getByTestId('label-instances');
  await expect(inst).toBeVisible();

  // New instance: the next id after the highest, named like its siblings, and
  // made the paint class.
  await page.getByTestId('label-instance-new').click();
  await expect(panel.getByTestId('label-class-4')).toContainText('Tree 4');
  await expect(panel).toHaveAttribute('data-active-class', '4');

  // Frame: the view centers on the selected instance's points.
  await panel.getByTestId('label-class-3').click();
  await page.getByTestId('label-instance-frame').click();
  await expect.poll(async () => page.evaluate(() => (window as any).__getCameraState().target as number[]))
    .toEqual([expect.closeTo(0, 3), expect.closeTo(0, 3), expect.closeTo(1.125, 3)]);

  // Merge 1 into 3: every point of Tree 1 becomes Tree 3, wherever it is.
  await panel.getByTestId('label-class-1').click();
  await page.getByTestId('label-instance-merge').selectOption('3');
  await expect.poll(async () => await counts(panel), { timeout: 30_000 }).toEqual({ '3': 60 });
  await expect(panel).toHaveAttribute('data-active-class', '3');
  await page.getByTestId('label-undo').click();
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 24, '3': 36 });

  // Delete 3: its points return to Unassigned; Tree 1 is untouched.
  await panel.getByTestId('label-class-3').click();
  await page.getByTestId('label-instance-delete').click();
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '0': 36, '1': 24 });
  await page.getByTestId('label-undo').click();
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 24, '3': 36 });
});

test('an instance stroke can set a semantic class too, in one undo step', async () => {
  const { page, panel } = await openLabelToolOnTreeCloud();
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 24, '3': 36 });

  // "Also set" the hand-labeling column's Wood on every stroke.
  const pair = page.getByTestId('label-instance-pair');
  const wood = await pair.locator('option', { hasText: 'Wood' }).first().getAttribute('value');
  expect(wood).toMatch(/^manual_class:\d+$/);
  await pair.selectOption(wood!);

  await panel.getByTestId('label-class-1').click();
  await paintWholeViewport(page);
  await expect.poll(async () => await counts(panel), { timeout: 30_000 }).toEqual({ '1': 60 });

  // The hand-labeling column got the same points as Wood.
  const woodValue = wood!.split(':')[1];
  await page.getByTestId('label-column-select').selectOption('manual_class');
  await expect(panel).toHaveAttribute('data-label-slug', 'manual_class');
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ [woodValue]: 60 });

  // One undo takes back both columns.
  await page.getByTestId('label-undo').click();
  await expect.poll(async () => (await counts(panel))[woodValue] ?? 0, { timeout: 30_000 }).toBe(0);
  await page.getByTestId('label-column-select').selectOption('tree_instance');
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 24, '3': 36 });
});

test('strokes save to a file and replay onto the re-imported scan', async () => {
  // Paint, bake (closing the panel), paint again, save. The file must hold
  // BOTH strokes: a bake clears the undo list, and a save that only knew the
  // unbaked strokes would replay to a different result.
  const { app } = session;
  let { page, panel } = await openLabelToolOnTreeCloud();
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 24, '3': 36 });

  await panel.getByTestId('label-class-3').click();
  await paintWholeViewport(page);
  await expect.poll(async () => await counts(panel), { timeout: 30_000 }).toEqual({ '3': 60 });

  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toHaveCount(0);
  await page.getByTestId('tool-label').click();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-label-baking', 'false', { timeout: 60_000 });
  await expect(panel).toHaveAttribute('data-pending-strokes', '0');

  // Second stroke: delete Tree 3 — every point back to Unassigned.
  await panel.getByTestId('label-class-3').click();
  await page.getByTestId('label-instance-delete').click();
  await expect.poll(async () => await counts(panel), { timeout: 30_000 }).toEqual({ '0': 60 });

  const dir = mkdtempSync(join(tmpdir(), 'phyto-strokes-'));
  const file = join(dir, 'strokes.json');
  await stubSaveDialog(app, file);
  await page.getByTestId('label-save-strokes').click();
  await expect.poll(() => { try { return JSON.parse(readFileSync(file, 'utf8')).strokes.length; } catch { return 0; } },
    { timeout: 10_000 }).toBe(2);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  expect(saved).toMatchObject({ format: 'phytograph-label-strokes', slug: 'tree_instance' });
  expect(saved.strokes.map((s: { toClass: number }) => s.toClass)).toEqual([3, 0]);

  // A fresh import of the same scan, then Load: same result, as one undo step.
  await resetToFreshScene(session.app, session.page);
  ({ page, panel } = await openLabelToolOnTreeCloud());
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 24, '3': 36 });
  await stubOpenDialog(app, file);
  await page.getByTestId('label-load-strokes').click();
  await expect.poll(async () => await counts(panel), { timeout: 30_000 }).toEqual({ '0': 60 });
  await expect(panel).toHaveAttribute('data-pending-strokes', '2');
  await page.getByTestId('label-undo').click();
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 24, '3': 36 });
});

test('pre-label seeds a column from another column, through a class map, in one undo step', async () => {
  const { page, panel } = await openLabelToolOnTreeCloud();
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 24, '3': 36 });
  // Edit the hand-labeling column (wood/leaf), seeded from tree_instance.
  await page.getByTestId('label-column-select').selectOption('manual_class');
  await expect(panel).toHaveAttribute('data-label-slug', 'manual_class');
  const woodValue = await panel.locator('[data-testid^="label-class-"]:not([data-testid="label-class-list"])', { hasText: 'Wood' }).first()
    .getAttribute('data-testid').then((t) => t!.replace('label-class-', ''));
  const leafValue = await panel.locator('[data-testid^="label-class-"]:not([data-testid="label-class-list"])', { hasText: 'Leaf' }).first()
    .getAttribute('data-testid').then((t) => t!.replace('label-class-', ''));

  await page.getByTestId('label-prelabel-source').selectOption('tree_instance');
  // Nothing matches by name ("Tree 1" is not "Wood"), so nothing is mapped yet
  // and there is nothing to apply.
  await expect(page.getByTestId('label-prelabel-apply')).toBeDisabled();
  await page.getByTestId('label-prelabel-map-1').selectOption(woodValue);
  await page.getByTestId('label-prelabel-map-3').selectOption(leafValue);
  await page.getByTestId('label-prelabel-apply').click();

  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ [woodValue]: 24, [leafValue]: 36 });
  await expect(panel).toHaveAttribute('data-pending-strokes', '1');

  await page.getByTestId('label-undo').click();
  await expect.poll(async () => {
    const c = await counts(panel);
    return (c[woodValue] ?? 0) + (c[leafValue] ?? 0);
  }, { timeout: 30_000 }).toBe(0);
});

test('a LAS export carries the flags, the chosen class byte and the class names back in', async () => {
  const { app } = session;
  let { page, panel } = await openLabelToolOnTreeCloud();
  await expect.poll(async () => await counts(panel), { timeout: 30_000 })
    .toEqual({ '1': 24, '3': 36 });

  // Name Tree 1 "Almond": the name must survive the file.
  const editor = await openEditor(page);
  await page.locator('[data-testid="palette-class-row"][data-class-value="1"]')
    .getByTestId('palette-class-label').fill('Almond');
  await page.getByTestId('palette-save').click();
  await expect(editor).toHaveCount(0);

  // Withhold every point, through the LAS flag column.
  await page.getByTestId('label-column-select').selectOption('flag_withheld');
  await expect(panel).toHaveAttribute('data-label-slug', 'flag_withheld');
  await expect(panel.getByTestId('label-class-1')).toContainText('Withheld');
  await panel.getByTestId('label-class-1').click();
  await paintWholeViewport(page);
  await expect.poll(async () => await counts(panel), { timeout: 30_000 }).toEqual({ '1': 60 });

  // Export with the tree ids in the classification byte.
  const savePath = join(mkdtempSync(join(tmpdir(), 'phytograph-flags-las-')), 'trees.las');
  await stubSaveDialog(app, savePath);
  await page.evaluate(() => (window as any).__openExportPanel?.());
  await expect(page.getByTestId('export-modal')).toBeVisible();
  await page.getByTestId('export-format-las').click();
  await page.getByTestId('export-las-classification').selectOption('tree_instance');
  await page.getByTestId('export-cloud-go').click();
  await expect(page.getByTestId('toast-success').filter({ hasText: 'Export Complete' }))
    .toBeVisible({ timeout: 30_000 });

  const { classes, flags } = readLasClasses(savePath);
  expect(classes.filter((c) => c === 1)).toHaveLength(24);
  expect(classes.filter((c) => c === 3)).toHaveLength(36);
  // Bit 2 is Withheld.
  expect(flags.every((f) => (f & 0b100) !== 0)).toBe(true);

  // Re-import the file: the flag column and the class names come back.
  await resetToFreshScene(session.app, session.page);
  await importFiles(app, page, 'import-auto', savePath);
  await completeImportWizard(page);
  const row = page.locator('[data-testid="scan-row"][data-scan-name="trees"]');
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toHaveAttribute('data-point-count', '60');
  await page.getByTestId('tool-label').click();
  panel = page.getByTestId('label-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('label-column-select').selectOption('tree_instance');
  await expect(panel.getByTestId('label-class-1')).toContainText('Almond', { timeout: 15_000 });
  await page.getByTestId('label-column-select').selectOption('flag_withheld');
  await expect.poll(async () => await counts(panel), { timeout: 30_000 }).toEqual({ '1': 60 });
});
