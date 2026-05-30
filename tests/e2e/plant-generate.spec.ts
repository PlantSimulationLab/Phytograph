import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launchApp';

// Generates a procedural plant model via the UI. The generation popup is
// triggered from the right toolbar (Sprout icon). The backend's
// /api/plant/generate calls into pyhelios — a non-trivial native dependency
// that's exactly what end-to-end testing exists to cover.
test('generates a procedural plant model with non-default species and age', async () => {
  const { page, close } = await launchApp();

  try {

    // On a fresh launch the empty-state hint is shown over the viewer.
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    // Open plant generation popup.
    await page.getByTestId('tool-plant-generate').click();
    const popup = page.getByTestId('plant-generation-popup');
    await expect(popup).toBeVisible();

    // Wait for the species options to load (the popup fires
    // GET /api/plant/models on open).
    const species = page.getByTestId('plant-species-select');
    await expect(species).toBeVisible();
    await expect(species.locator('option')).not.toHaveCount(0);

    // Non-default species: "tomato" if available, else fall back to the first
    // non-default option. The default is "bean" per PlantGenerationPopup.tsx.
    const optionValues = await species.locator('option').evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.value),
    );
    expect(optionValues.length).toBeGreaterThan(1);
    const chosen = optionValues.includes('tomato')
      ? 'tomato'
      : optionValues.find((v) => v !== 'bean') ?? optionValues[0];
    await species.selectOption(chosen);
    await expect(species).toHaveValue(chosen);

    // Non-default age: 15 days (default is 30 per the component).
    const age = page.getByTestId('plant-age-input');
    await age.fill('15');
    await expect(age).toHaveValue('15');

    // Generate.
    await page.getByTestId('plant-generate-button').click();

    // The popup closes on generation start. A new plant mesh row should
    // appear in the Meshes panel. Plant generation can take 20-60s on
    // first call (pyhelios cold init).
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 120_000 });
    await expect(meshRow).toHaveAttribute('data-is-plant', 'true');

    // The mesh name is "{species} ({age}d)" per PointCloudViewer.tsx.
    const meshName = await meshRow.getAttribute('data-mesh-name');
    expect(meshName).toContain(chosen);
    expect(meshName).toContain('15d');

    // Triangle count from the live pyhelios output should be substantial
    // for a 15-day plant of any species. Assert on a robust lower bound.
    const trianglesStr = await meshRow.getAttribute('data-triangle-count');
    expect(trianglesStr).not.toBeNull();
    const triangles = parseInt(trianglesStr!, 10);
    expect(triangles).toBeGreaterThan(100);

    // The visible row should label this as a Helios plant.
    await expect(meshRow.getByTestId('mesh-row-count')).toContainText('Helios Plant');

    // A generated plant is a mesh, not a scan — but the viewer is no longer
    // empty, so the import hint must be gone (regression: it used to linger
    // because the hint was gated on scan count only).
    await expect(page.getByTestId('empty-viewer-hint')).toHaveCount(0);
  } finally {
    await close();
  }
});
