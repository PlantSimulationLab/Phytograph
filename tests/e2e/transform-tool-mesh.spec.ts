import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

// The Transform toolbar button was declared `requires: 'cloud'`, so it greyed
// out whenever a MESH was selected — even though the mesh transform machinery
// (position / rotation / scale, Move to Origin, Fit to Scans) was fully built
// in its own floating TransformPanel. The only way in was the transform button
// on the mesh's own row in the Meshes panel, so the prominent toolbar button
// was advertising "unavailable" for a selection it could serve.
//
// It's now `requires: 'cloud-or-mesh'` and routes on the selection: a mesh
// opens the mesh TransformPanel, a cloud keeps the editMode draft panel it has
// always had. QSMs are deliberately NOT covered — they have no transform state
// at all, so the button correctly stays greyed for them.
const CUBE_PLY = join(repoRoot, 'tests', 'e2e', 'fixtures', 'cube-mesh.ply');
const CLOUD_XYZ = join(repoRoot, 'tests', 'e2e', 'fixtures', 'sparse.xyz');

test('the Transform toolbar button works for a mesh, not just a cloud', async () => {
  const { app, page, close } = await launchApp();

  try {
    await expect(page.getByTestId('backend-splash')).toBeHidden({ timeout: 90_000 });
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    const transformBtn = page.getByTestId('tool-cloud-translate');

    // Nothing selected → the button is greyed out (unchanged behavior).
    await expect(transformBtn).toBeDisabled();

    await importFiles(app, page, 'import-mesh', CUBE_PLY);
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 60_000 });

    // Select the mesh through the Meshes panel row.
    await meshRow.click();
    await expect(meshRow).toHaveAttribute('data-selected', 'true');

    // THE BUG: this used to stay disabled with a mesh selected.
    await expect(transformBtn).toBeEnabled();

    // Pressing it opens the MESH transform panel (position/rotation/scale),
    // not the cloud draft panel.
    await transformBtn.click();
    await expect(page.getByTestId('mesh-pos-x')).toBeVisible();
    await expect(page.getByTestId('mesh-scale-x')).toBeVisible();
    await expect(page.getByTestId('translate-panel')).toHaveCount(0);

    // And it really transforms: type a position, the mesh row reflects it.
    const posInput = page.getByTestId('mesh-pos-x');
    await posInput.fill('4');
    await posInput.press('Enter');
    await expect.poll(async () => {
      const attr = await meshRow.getAttribute('data-mesh-position');
      return attr ? Number(attr.split(',')[0]) : NaN;
    }, { timeout: 10_000 }).toBeCloseTo(4, 2);

    // The button is a toggle: pressing again closes the panel.
    await transformBtn.click();
    await expect(page.getByTestId('mesh-pos-x')).toHaveCount(0);

    // ---- A CLOUD still gets the cloud draft panel -------------------------
    await importFiles(app, page, 'import-point-cloud', CLOUD_XYZ);
    await completeImportWizard(page);
    const scanRow = page.getByTestId('scan-row').first();
    await expect(scanRow).toBeVisible({ timeout: 60_000 });

    // Importing the cloud selects it and drops the mesh selection; make sure.
    await expect(meshRow).toHaveAttribute('data-selected', 'false');
    if (await scanRow.getAttribute('data-selected') !== 'true') {
      await scanRow.getByTestId('scan-row-name').click();
    }
    await expect(scanRow).toHaveAttribute('data-selected', 'true');

    await expect(transformBtn).toBeEnabled();
    await transformBtn.click();
    // The CLOUD path: the OK/Cancel draft panel, and NOT the mesh panel.
    await expect(page.getByTestId('translate-panel')).toBeVisible();
    await expect(page.getByTestId('mesh-pos-x')).toHaveCount(0);
  } finally {
    await close();
  }
});
