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

    // Regression guard: typing a negative position coordinate one keystroke at a
    // time must work. These fields were a controlled type="number" reset to 0 on
    // any non-finite parse, so the default "0" couldn't be cleared and a leading
    // "-" snapped back to 0 — you literally couldn't enter a negative coordinate.
    // Clear the X field and type "-1.5" char by char; the minus must survive.
    const posX = page.getByTestId('plant-position-x');
    await posX.click();
    await posX.fill('');
    await posX.pressSequentially('-1.5', { delay: 30 });
    await expect(posX).toHaveValue('-1.5');
    // Reset to origin so the rest of the test is unaffected.
    await posX.fill('0');
    await posX.blur();

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

// Bean has leaf textures in the Helios library, so generation must surface
// textured materials (the data the textured renderer consumes). This guards the
// real-Helios-UV fix: previously textures were disabled and no material carried
// texture data into the renderer.
//
// SCOPE / LIMITATION: this asserts the data that DRIVES the render reaches the
// renderer (a textured material count > 0). It does NOT assert the rendered
// pixels — the offscreen E2E window (`show:false`) returns a black WebGL buffer
// to toDataURL/drawImage, so pixel checks aren't possible here. A material-setup
// bug (e.g. wrong opacity/alpha) would still pass this. Pixel-accurate leaf
// rendering is verified with a visible window via
// `node tests/e2e/visual/capture-plant.mjs` (see that file); keep it in sync
// when changing the textured material.
test('a textured plant carries texture materials into the renderer', async () => {
  const { page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await page.getByTestId('tool-plant-generate').click();
    const popup = page.getByTestId('plant-generation-popup');
    await expect(popup).toBeVisible();

    const species = page.getByTestId('plant-species-select');
    await expect(species).toBeVisible();
    await expect(species.locator('option')).not.toHaveCount(0);

    // Bean is the default and is textured.
    await species.selectOption('bean');
    await page.getByTestId('plant-age-input').fill('20');
    await page.getByTestId('plant-generate-button').click();

    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 120_000 });
    await expect(meshRow).toHaveAttribute('data-is-plant', 'true');

    // At least one textured material reached the renderer.
    const texturedStr = await meshRow.getAttribute('data-textured-materials');
    expect(parseInt(texturedStr ?? '0', 10)).toBeGreaterThan(0);
  } finally {
    await close();
  }
});

// Building a canopy goes through the same popup with the "Generate as canopy"
// toggle on, hitting /api/plant/canopy/generate (pyhelios
// buildPlantCanopyFromLibrary). The whole grid comes back as one merged mesh,
// so a 2x2 canopy must have substantially more geometry than a single plant.
test('generates a 2x2 canopy as a single merged mesh', async () => {
  const { page, close } = await launchApp();

  try {
    await expect(page.getByTestId('empty-viewer-hint')).toBeVisible();

    await page.getByTestId('tool-plant-generate').click();
    const popup = page.getByTestId('plant-generation-popup');
    await expect(popup).toBeVisible();

    const species = page.getByTestId('plant-species-select');
    await expect(species).toBeVisible();
    await expect(species.locator('option')).not.toHaveCount(0);
    await species.selectOption('bean');

    await page.getByTestId('plant-age-input').fill('15');

    // Enable canopy mode — this reveals spacing + count fields and switches the
    // submit to /api/plant/canopy/generate.
    await page.getByTestId('plant-canopy-toggle').check();
    const countX = page.getByTestId('canopy-count-x');
    const countY = page.getByTestId('canopy-count-y');
    await expect(countX).toBeVisible();
    await countX.fill('2');
    await countY.fill('2');
    await page.getByTestId('canopy-spacing-x').fill('0.5');
    await page.getByTestId('canopy-spacing-y').fill('0.5');

    await page.getByTestId('plant-generate-button').click();

    // The popup stays open during the build and shows a live progress bar
    // (fed by Server-Sent Events from the canopy build).
    await expect(page.getByTestId('plant-generate-progress')).toBeVisible();

    // Building 4 plants takes longer than one; allow the full cold-init budget.
    const meshRow = page.getByTestId('mesh-row').first();
    await expect(meshRow).toBeVisible({ timeout: 180_000 });
    await expect(meshRow).toHaveAttribute('data-is-plant', 'true');

    // The canopy name encodes the grid, e.g. "bean canopy 2×2 (15d)".
    const meshName = await meshRow.getAttribute('data-mesh-name');
    expect(meshName).toContain('bean');
    expect(meshName).toContain('2×2');
    expect(meshName).toContain('15d');

    // 4 plants merged: triangle count must dwarf a single plant's lower bound.
    const trianglesStr = await meshRow.getAttribute('data-triangle-count');
    expect(trianglesStr).not.toBeNull();
    expect(parseInt(trianglesStr!, 10)).toBeGreaterThan(400);
  } finally {
    await close();
  }
});
