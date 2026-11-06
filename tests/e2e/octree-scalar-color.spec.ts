import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { launchApp, repoRoot } from './helpers/launchApp';
import { importFiles } from './helpers/importFiles';
import { completeImportWizard } from './helpers/importWizard';

const FIXTURE = join(repoRoot, 'tests', 'e2e', 'fixtures', 'scalars.xyz');

// Imported scalar columns on an octree-backed cloud must be selectable and
// color-mappable. scalars.xyz is a comma-headered, space-delimited XYZ with
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
  const { app, page, close } = await launchApp();

  try {
    await importFiles(app, page, 'import-point-cloud', FIXTURE);
    await completeImportWizard(page);

    const cloudRow = page.locator('[data-testid="scan-row"][data-scan-name="scalars"]');
    await expect(cloudRow).toBeVisible({ timeout: 20_000 });
    // 60 data points (1 header row skipped).
    const pointCount = parseInt((await cloudRow.getAttribute('data-point-count')) ?? '0', 10);
    expect(pointCount).toBe(60);

    // Freshly imported scan is auto-selected (no re-click — that would toggle off).
    await expect(cloudRow).toHaveAttribute('data-selected', 'true');

    // Open the Display panel (collapsed by default).
    await page.getByRole('button', { name: 'Display' }).click();
    const colorMode = page.getByTestId('display-color-mode');
    await expect(colorMode).toBeVisible();

    // The imported scalars must appear as picker options with clean labels —
    // value is the on-disk slug, text is the humanised header. Builtin LAS
    // attributes PotreeConverter also writes (return number, scan angle rank,
    // point source id, gps-time, …) must NOT appear in the Scalar fields group.
    //
    // Two of the three headers auto-detect into Helios per-pulse multi-return
    // fields: 'Timestamp[s]' and 'Target Index[]' match the canonical
    // _MULTI_RETURN_SLUGS ('timestamp', 'target_index'), so the importer pins
    // them to those lowercase slugs and canonical labels ('Timestamp',
    // 'Target Index') — dropping the '[s]' unit — so the LAD accessor can
    // recover them by name. 'Deviation[]' isn't a multi-return field, so it
    // takes the generic sanitized slug 'Deviation'. (When the user instead
    // marks Target Index categorical in the wizard, it bypasses this and keeps
    // the sanitized 'Target_Index' slug — see import-wizard.spec.ts.)
    const optionValues = await colorMode
      .locator('optgroup[label="Scalar fields"] option')
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    const optionLabels = await colorMode
      .locator('optgroup[label="Scalar fields"] option')
      .evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).textContent));
    // The time column's option value is its octree BUFFER key — PotreeConverter's
    // `gps-time`, because the import writes it to the LAS standard float64
    // gps_time field rather than a float32 extra dim (which quantizes
    // GPS-magnitude times to 32 s). It is offered because it carries REAL data
    // here; a plain XYZ import's all-zero gps-time is filtered out (the
    // degenerate-range rule in octreeScalarFieldOptions), and that is what the
    // legacy "no gps in the picker" assertion used to guard. The user-facing
    // name is still "Timestamp", asserted on the label.
    expect(optionValues).toContain('scalar:gps-time');
    expect(optionValues).toContain('scalar:Deviation');
    expect(optionValues).toContain('scalar:target_index');
    expect(optionLabels).toContain('Timestamp');
    expect(optionLabels).toContain('Target Index');
    // No builtin LAS schema padding leaked into the picker.
    for (const v of optionValues) {
      expect(v.toLowerCase()).not.toContain('source id');
      expect(v.toLowerCase()).not.toContain('scan angle');
      expect(v.toLowerCase()).not.toContain('user data');
      expect(v.toLowerCase()).not.toContain('return');
    }

    // Select Timestamp and assert the picker drives scalar mode.
    await colorMode.selectOption('scalar:gps-time');
    await expect(colorMode).toHaveValue('scalar:gps-time');

    // The colormap picker only renders for continuous scalar modes.
    await expect(page.getByTestId('display-colormap')).toBeVisible();

    // The colorbar overlay must appear, captioned with the clean label and
    // showing the attribute's real value range (Timestamp spans [100, 247.5])
    // — NOT the [0,1] intensity default, proving it reads the actual attribute.
    const colorbar = page.getByTestId('colorbar');
    await expect(colorbar).toBeVisible();
    await expect(colorbar).toHaveAttribute('data-colorbar-label', 'Timestamp');
    const cbMin = parseFloat((await colorbar.getAttribute('data-colorbar-min')) ?? 'NaN');
    const cbMax = parseFloat((await colorbar.getAttribute('data-colorbar-max')) ?? 'NaN');
    expect(cbMax).toBeGreaterThan(cbMin);
    expect(cbMin).toBeGreaterThanOrEqual(100);
    expect(cbMax).toBeLessThanOrEqual(248);

    // Switching to another scalar re-captions the colorbar with its own range
    // (Target Index spans [1, 8]) — confirms field switching re-applies.
    await colorMode.selectOption('scalar:target_index');
    await expect(colorMode).toHaveValue('scalar:target_index');
    await expect(colorbar).toHaveAttribute('data-colorbar-label', 'Target Index');
    const tgtMin = parseFloat((await colorbar.getAttribute('data-colorbar-min')) ?? 'NaN');
    const tgtMax = parseFloat((await colorbar.getAttribute('data-colorbar-max')) ?? 'NaN');
    expect(tgtMin).toBeGreaterThanOrEqual(1);
    expect(tgtMax).toBeLessThanOrEqual(8);
    expect(tgtMax).toBeGreaterThan(tgtMin);

    // ── Discrete label colormap on an integer column left as Scalar ─────────
    // Target Index is integer labels 1..8. Under a gradient, neighbors 4 and 5
    // render nearly the same color; a label colormap must give each VALUE its
    // own palette color (palette[v mod 20] for Tab20), drawn through a
    // nearest-filtered class texture so no two values blend.
    //
    // Read from the texture actually bound to the shader (the material
    // effect's own seam), not from what the picker says it asked for.
    const readClassTexture = () => page.evaluate(() => {
      const all = (window as any).__octreeRenderMode ?? {};
      const entry = (Object.values(all) as any[]).find((m) => m.scalarField === 'target_index');
      return entry?.classTexture ?? null;
    });
    // Independent oracle: matplotlib's tab20, written out here rather than
    // imported from the code under test.
    const TAB20 = ['1f77b4', 'aec7e8', 'ff7f0e', 'ffbb78', '2ca02c', '98df8a', 'd62728', 'ff9896', '9467bd'];
    const hexAt = (tex: { width: number; range: [number, number]; rgba: number[] }, v: number) => {
      const t = (v - tex.range[0]) / ((tex.range[1] - tex.range[0]) || 1);
      const i = Math.min(tex.width - 1, Math.max(0, Math.floor(t * tex.width)));
      return tex.rgba.slice(4 * i, 4 * i + 3).map((b) => b.toString(16).padStart(2, '0')).join('');
    };

    // Before: a smooth gradient, so no class texture is bound.
    expect(await readClassTexture()).toBeNull();

    const displayColormap = page.getByTestId('display-colormap');
    await displayColormap.selectOption('tab20');
    await expect(displayColormap).toHaveValue('tab20');

    await expect.poll(async () => (await readClassTexture())?.nearest ?? false, { timeout: 10_000 }).toBe(true);
    const tex = await readClassTexture();
    const observed = [] as string[];
    for (let v = Math.ceil(tgtMin); v <= Math.floor(tgtMax); v++) {
      observed.push(hexAt(tex, v));
      expect(hexAt(tex, v)).toBe(TAB20[v % 20]);
    }
    // Every label present gets its own color.
    expect(new Set(observed).size).toBe(observed.length);
    expect(observed.length).toBeGreaterThanOrEqual(2);

    // The legend says how the map works instead of drawing min/mid/max ticks
    // that would imply the colors encode magnitude.
    const discreteLegend = colorbar.getByTestId('legend-discrete');
    await expect(discreteLegend).toBeVisible();
    await expect(discreteLegend).toContainText('repeats every 20');

    // Back to a gradient: the class texture must be unbound (the colormap
    // change does not remount the material, so this is a real transition).
    await displayColormap.selectOption('viridis');
    await expect.poll(readClassTexture, { timeout: 10_000 }).toBeNull();
    await expect(colorbar.getByTestId('legend-discrete')).toHaveCount(0);
  } finally {
    await close();
  }
});
