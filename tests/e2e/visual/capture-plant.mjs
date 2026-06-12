// Visual render check for textured plant rendering.
//
// Why this exists separately from the Playwright specs: the E2E launcher hides
// the window (`show:false`), and an offscreen Electron window returns a black
// WebGL buffer to toDataURL/drawImage — so the specs can't assert on rendered
// pixels. This launches the app with a VISIBLE, real-size window, generates a
// textured plant, zooms in, and writes a screenshot you can eyeball. Use it to
// confirm leaves render as full textured shapes (not faint/whispy slivers, the
// bug that the data-level spec could not catch) after touching the textured
// material in TexturedPlantMesh.tsx.
//
// Prereqs (same as E2E):
//   npm run build && npm run build:backend
//
// Run from the repo root:
//   node tests/e2e/visual/capture-plant.mjs [species] [age]
// Output: tests/e2e/visual/plant-render.png

import { _electron } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const species = process.argv[2] || 'bean';
const age = process.argv[3] || '30';
const outPath = join(repoRoot, 'tests', 'e2e', 'visual', 'plant-render.png');

// Per-instance backend port; pin one and pass it to Electron. See backend.ts.
const BACKEND_PORT = Number(process.env.PHYTOGRAPH_BACKEND_PORT) || 8008;

async function waitForBackend(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(`http://127.0.0.1:${BACKEND_PORT}/version`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('backend never came up');
}

const app = await _electron.launch({
  args: ['.'],
  cwd: repoRoot,
  timeout: 60000,
  // Intentionally NOT setting PHYTOGRAPH_E2E so the window renders at real size.
  env: { ...process.env, PHYTOGRAPH_BACKEND_PORT: String(BACKEND_PORT) },
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');
await waitForBackend();
await page.waitForTimeout(2000);

await page.getByTestId('tool-plant-generate').click();
await page.getByTestId('plant-generation-popup').waitFor();
await page.getByTestId('plant-species-select').selectOption(species);
await page.getByTestId('plant-age-input').fill(String(age));
await page.getByTestId('plant-generate-button').click();

await page.getByTestId('mesh-row').first().waitFor({ timeout: 120000 });
await page.waitForTimeout(4000);

// Zoom toward the plant so leaves fill the frame.
const box = await page.locator('canvas').first().boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 18; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(60); }
await page.waitForTimeout(1500);

await page.screenshot({ path: outPath });
console.log(`saved ${outPath} (species=${species}, age=${age})`);
await app.close();
