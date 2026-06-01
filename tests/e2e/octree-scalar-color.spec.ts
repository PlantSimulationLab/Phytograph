import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'scalars.xyz');

// Imported scalar columns on an octree-backed cloud must be selectable and
// colour-mappable. scalars.xyz is a comma-headered, space-delimited XYZ with
// three named scalar columns (Timestamp[s], Deviation[], Target Index[]) —
// exactly the shape terrestrial scanners export. On import it routes through
// convert_to_octree, so the renderer never holds the points; the scalars
// survive as LAS extra dimensions in the octree and decode into named
// potree-core buffers.
//
// This drives the real DOM: import → select cloud → open Display panel →
// pick the scalar field → assert the picker reflects the selection AND the
// colorbar overlay appears with the scalar's clean label and value range.
test('colors an octree-backed cloud by an imported scalar attribute', async () => {
  const { page, close } = await launchApp();

  try {
    await page.getByTestId('import-menu-button').click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByTestId('import-menu-pointcloud').click(),
    ]);
    await chooser.setFiles(FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="scalars.xyz"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    // 60 data points (1 header row skipped).
    const pointCount = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(pointCount).toBe(60);

    await cloudRow.click();
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Open the Display panel (collapsed by default).
    await page.getByRole('button', { name: 'Display' }).click();
    const colorMode = page.getByTestId('display-color-mode');
    await expect(colorMode).toBeVisible();

    // The imported scalars must appear as picker options with clean labels —
    // value is the on-disk slug, text is the humanised header. Builtin LAS
    // attributes PotreeConverter also writes (return number, scan angle rank,
    // point source id, gps-time, …) must NOT appear in the Scalar fields group.
    const optionValues = await colorMode
      .locator('optgroup[label="Scalar fields"] option')
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    const optionLabels = await colorMode
      .locator('optgroup[label="Scalar fields"] option')
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).textContent));
    expect(optionValues).toContain('scalar:Timestamp_s');
    expect(optionValues).toContain('scalar:Deviation');
    expect(optionValues).toContain('scalar:Target_Index');
    expect(optionLabels).toContain('Timestamp [s]');
    expect(optionLabels).toContain('Target Index');
    // No builtin LAS attributes leaked into the picker.
    for (const v of optionValues) {
      expect(v.toLowerCase()).not.toContain('source id');
      expect(v.toLowerCase()).not.toContain('scan angle');
      expect(v.toLowerCase()).not.toContain('user data');
      expect(v.toLowerCase()).not.toContain('gps');
    }

    // Select Timestamp and assert the picker drives scalar mode.
    await colorMode.selectOption('scalar:Timestamp_s');
    await expect(colorMode).toHaveValue('scalar:Timestamp_s');

    // The colormap picker only renders for continuous scalar modes.
    await expect(page.getByTestId('display-colormap')).toBeVisible();

    // The colorbar overlay must appear, captioned with the clean label and
    // showing the attribute's real value range (Timestamp spans [100, 247.5])
    // — NOT the [0,1] intensity default, proving it reads the actual attribute.
    const colorbar = page.getByTestId('colorbar');
    await expect(colorbar).toBeVisible();
    await expect(colorbar).toHaveAttribute('data-colorbar-label', 'Timestamp [s]');
    const cbMin = parseFloat((await colorbar.getAttribute('data-colorbar-min')) ?? 'NaN');
    const cbMax = parseFloat((await colorbar.getAttribute('data-colorbar-max')) ?? 'NaN');
    expect(cbMax).toBeGreaterThan(cbMin);
    expect(cbMin).toBeGreaterThanOrEqual(100);
    expect(cbMax).toBeLessThanOrEqual(248);

    // Switching to another scalar re-captions the colorbar with its own range
    // (Target Index spans [1, 8]) — confirms field switching re-applies.
    await colorMode.selectOption('scalar:Target_Index');
    await expect(colorMode).toHaveValue('scalar:Target_Index');
    await expect(colorbar).toHaveAttribute('data-colorbar-label', 'Target Index');
    const tgtMin = parseFloat((await colorbar.getAttribute('data-colorbar-min')) ?? 'NaN');
    const tgtMax = parseFloat((await colorbar.getAttribute('data-colorbar-max')) ?? 'NaN');
    expect(tgtMin).toBeGreaterThanOrEqual(1);
    expect(tgtMax).toBeLessThanOrEqual(8);
    expect(tgtMax).toBeGreaterThan(tgtMin);
  } finally {
    await close();
  }
});
