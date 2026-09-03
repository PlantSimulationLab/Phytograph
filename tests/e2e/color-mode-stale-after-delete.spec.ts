import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const WOOD_FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree_wood_leaf.xyz');
const PLAIN_FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree-view1.xyz');

// Regression for a recurring bug: a scalar color mode (e.g. wood_class from a
// segmentation) used to be GLOBAL state, but the field only exists on the cloud
// that produced it. After deleting that cloud and importing a different one,
// the mode stayed 'scalar:wood_class' — a field the new cloud doesn't have — so
// the renderer fell back to a flat gray/z-height ramp and the dropdown showed a
// dead value.
//
// The colour mode now lives on the cloud that owns the field, so the selection
// is deleted along with its cloud and can never be inherited by an unrelated
// import. What the new cloud shows is simply the scene default — this test
// asserts the stale field is gone and the dropdown offers a mode the cloud
// actually has, rather than pinning one specific fallback name.
test('scalar color mode resets to per-scan after the source cloud is deleted', async () => {
  const { app, page, close } = await launchApp();

  try {
    // 1. Import a segmentable cloud and run wood/leaf segmentation. This drives
    //    the global color mode to scalar:wood_class (proven by the discrete
    //    class legend keyed on wood_class).
    await importFiles(app, page, 'import-point-cloud', WOOD_FIXTURE);
    await completeImportWizard(page);

    const woodRow = page.locator('[data-testid="scan-row"][data-scan-name="tree_wood_leaf"]');
    await expect(woodRow).toBeVisible({ timeout: 20_000 });
    await expect(woodRow).toHaveAttribute('data-selected', 'true');

    await page.getByTestId('tool-wood-segment').click();
    await expect(page.getByTestId('wood-segment-panel')).toBeVisible();
    await page.getByTestId('wood-segment-run-button').click();

    const legend = page.getByTestId('class-legend');
    await expect(legend).toBeVisible({ timeout: 60_000 });
    await expect(legend).toHaveAttribute('data-legend-attribute', 'wood_class');

    // The color-by dropdown now reflects the scalar selection. Open the
    // Display panel (collapsed by default) to read it, then collapse it again
    // so its body doesn't overlay the import wizard's controls later.
    const displayToggle = page.getByRole('button', { name: 'Display' });
    await displayToggle.click();
    const colorMode = page.getByTestId('display-color-mode');
    await expect(colorMode).toHaveValue('scalar:wood_class');
    await displayToggle.click();
    await expect(colorMode).toBeHidden();

    // 2. Delete the segmented cloud.
    await woodRow.locator('button[data-testid^="scan-delete-"]').click();
    await page.getByTestId('confirm-delete').click();
    await expect(woodRow).toHaveCount(0);

    // 3. Import a different plain cloud with no wood_class field.
    await importFiles(app, page, 'import-point-cloud', PLAIN_FIXTURE);
    await completeImportWizard(page);

    const plainRow = page.locator('[data-testid="scan-row"][data-scan-name="tree-view1"]');
    await expect(plainRow).toBeVisible({ timeout: 20_000 });

    // 4. The stale scalar:wood_class mode must NOT survive. With the bug it
    //    stayed 'scalar:wood_class' (rendering gray); the wood_class legend is
    //    gone and the dropdown no longer names the dead field.
    await expect(legend).toBeHidden();
    await displayToggle.click();
    await expect(colorMode).not.toHaveValue('scalar:wood_class');

    // The selected mode must be one the dropdown actually offers — the precise
    // failure of the old bug was a <select> displaying a value absent from its
    // own options, which is what made the cloud render gray.
    const selected = await colorMode.inputValue();
    const options = await colorMode.locator('option').evaluateAll(
      (opts) => opts.map(o => (o as HTMLOptionElement).value),
    );
    expect(options, `"${selected}" must be a real option`).toContain(selected);
    // And no scalar option may reference the deleted cloud's field.
    expect(options.filter(o => o.includes('wood_class'))).toHaveLength(0);
  } finally {
    await close();
  }
});
