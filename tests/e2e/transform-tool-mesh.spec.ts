import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';

// The Transform toolbar button is a PICKER tool: its panel lists every cloud and
// mesh in the scene and moves the checked ones. It used to be gated on the pane
// SELECTION (and to route to one of two different panels by what was selected),
// which made it easy to transform the wrong thing or to find the button grayed
// out with the object you wanted to move sitting right there. Now:
//
//  - the button is enabled whenever there is anything to move, selected or not;
//  - with nothing selected the panel opens with NOTHING checked (a cloud bake
//    cannot be undone, so the tool never arms objects the user didn't pick);
//  - the mesh row's own transform button still opens the per-mesh ABSOLUTE
//    editor (position / scale / grid / Fit to Scans), which the toolbar button
//    no longer does.
//
// One launch: the steps build on each other's scene state.
const CUBE_PLY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'cube-mesh.ply');

test('Transform is available with nothing selected and moves a mesh checked in its picker', async () => {
  const { app, page, close } = await launchApp();

  try {
    await expect(page.getByTestId('backend-splash')).toBeHidden({ timeout: 90_000 });
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    const transformBtn = page.getByTestId('tool-cloud-translate');
    // An empty scene has nothing to move.
    await expect(transformBtn).toBeDisabled();

    await importFiles(app, page, 'import-mesh', CUBE_PLY);
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('meshes-deselect-all').click();
    await expect(meshRow).toHaveAttribute('data-selected', 'false');

    // THE CHANGE: enabled although nothing is selected.
    await expect(transformBtn).toBeEnabled();
    await transformBtn.click();
    const panel = page.getByTestId('translate-panel');
    await expect(panel).toBeVisible();
    // The toolbar button never opens the per-mesh absolute editor any more.
    await expect(page.getByTestId('mesh-pos-x')).toHaveCount(0);

    // The picker lists the mesh, unchecked, and OK is disabled until a row is.
    const rows = page.getByTestId('transform-target-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-checked', 'false');
    await expect(page.getByTestId('translate-ok')).toBeDisabled();

    const before = (await meshRow.getAttribute('data-mesh-position'))!.split(',').map(Number);

    await rows.first().click();
    await expect(rows.first()).toHaveAttribute('data-checked', 'true');
    // Checked, but nothing to apply yet: Apply stays grayed out, so a lit
    // button always means there are changes waiting.
    await expect(page.getByTestId('translate-ok')).toBeDisabled();
    await expect(page.getByTestId('translate-ok')).toHaveAttribute('title', 'No changes to apply');

    const moveX = page.getByTestId('translate-input-x');
    await moveX.fill('4');
    await moveX.press('Enter');
    // A draft: the mesh's stored transform is untouched until Apply.
    await expect(meshRow).toHaveAttribute('data-mesh-position', before.map(v => v.toFixed(2)).join(','));

    await expect(page.getByTestId('translate-ok')).toBeEnabled();
    await expect(page.getByTestId('translate-ok')).toHaveText('Apply');
    // Apply commits and leaves the tool open (fields back to zero); then close.
    await page.getByTestId('translate-ok').click();
    await expect(page.getByTestId('translate-panel')).toHaveAttribute('data-dirty', 'false', { timeout: 20_000 });
    await expect(page.getByTestId('translate-panel')).toHaveAttribute('data-applying', 'false');
    // Applied: nothing pending again, so Apply grays back out.
    await expect(page.getByTestId('translate-ok')).toBeDisabled();
    await page.getByTestId('translate-cancel').click();
    await expect(page.getByTestId('translate-panel')).toBeHidden();
    await expect.poll(async () => {
      const attr = await meshRow.getAttribute('data-mesh-position');
      return attr ? Number(attr.split(',')[0]) : NaN;
    }, { timeout: 10_000 }).toBeCloseTo(before[0] + 4, 2);

    // Undoable, as a mesh transform always was.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await expect.poll(async () => {
      const attr = await meshRow.getAttribute('data-mesh-position');
      return attr ? Number(attr.split(',')[0]) : NaN;
    }, { timeout: 10_000 }).toBeCloseTo(before[0], 2);

    // The row's own button still opens the absolute per-mesh editor.
    await meshRow.getByTestId('mesh-transform-toggle').click();
    await expect(page.getByTestId('mesh-pos-x')).toBeVisible();
    await expect(page.getByTestId('translate-panel')).toHaveCount(0);
  } finally {
    await close();
  }
});
