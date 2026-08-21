import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot, type LaunchedApp } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';
import { resetToFreshScene } from './helpers/resetApp';

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

  const row = page.locator('[data-testid="scan-row"][data-scan-name="tiny.xyz"]');
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
  // longer describes — they would read as unlabelled, with no warning and no
  // undo. Renaming and recolouring stay available, because those are safe.
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
