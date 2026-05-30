// Captures screenshots of the Phytograph desktop app for the user guide.
//
// Why this script exists separately from tests/e2e:
//   - The E2E launcher sets PHYTOGRAPH_E2E=1 which hides the window. We want
//     a visible, normally-sized window so the screenshots reflect what a
//     user actually sees.
//   - This is a one-shot capture tool, not a regression test. It lives under
//     docs/ because its output is documentation.
//
// Prereqs:
//   npm run build            # populates dist-main/
//   npm run build:backend    # populates resources/phytograph_backend/
//
// Run from the repo root:
//   SCREENSHOT_FIXTURE=/path/to/scan.xyz node docs/scripts/capture-screenshots.mjs
//
// SCREENSHOT_FIXTURE must point at a point-cloud file you have locally
// (any supported format). It isn't checked into the repo — pick something
// representative of what users actually load (a real TLS scan, not a
// synthetic test fixture) so the screenshot matches the docs.
//
// Output:
//   docs/docs/assets/screenshots/01-empty-viewer.png
//   docs/docs/assets/screenshots/02-import-dropdown.png
//   docs/docs/assets/screenshots/03-first-scan.png
//   docs/docs/assets/screenshots/05-command-palette.png

import { _electron } from 'playwright';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const outDir = join(repoRoot, 'docs', 'docs', 'assets', 'screenshots');

const FIXTURE = process.env.SCREENSHOT_FIXTURE;
if (!FIXTURE) {
  console.error(
    'SCREENSHOT_FIXTURE env var is required — point it at a local point-cloud file.\n' +
      'Example: SCREENSHOT_FIXTURE=/path/to/scan.xyz node docs/scripts/capture-screenshots.mjs'
  );
  process.exit(1);
}

const BACKEND_URL = 'http://127.0.0.1:8008';

async function waitForBackend(timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${BACKEND_URL}/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return (await res.json());
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Backend at ${BACKEND_URL} never came up`);
}

async function main() {
  const backendBin = join(
    repoRoot,
    'resources',
    'phytograph_backend',
    process.platform === 'win32' ? 'phytograph_backend.exe' : 'phytograph_backend',
  );
  if (!existsSync(backendBin)) {
    throw new Error(`Backend missing — run \`npm run build:backend\` first.`);
  }
  if (!existsSync(join(repoRoot, 'dist-main', 'main.js'))) {
    throw new Error(`dist-main missing — run \`npm run build\` first.`);
  }
  if (!existsSync(FIXTURE)) {
    throw new Error(`Fixture missing: ${FIXTURE}`);
  }

  console.log('Launching Phytograph (visible window)...');
  const app = await _electron.launch({
    args: ['.'],
    cwd: repoRoot,
    timeout: 60_000,
    // Deliberately NOT setting PHYTOGRAPH_E2E=1 — we want the window visible.
  });
  const page = await app.firstWindow();

  try {
    await waitForBackend();
    console.log('Backend ready.');

    // Give the renderer a beat to finish initial layout.
    await page.waitForTimeout(1500);

    // ── 01: Empty viewer with the drag/import hint ──────────────────────
    // The app boots directly into the 3D viewport; with no scans loaded it
    // shows the empty-state hint over the canvas.
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(outDir, '01-empty-viewer.png') });
    console.log('Saved 01-empty-viewer.png');

    // ── 02: Import dropdown open ────────────────────────────────────────
    await page.waitForTimeout(600);
    // The chevron toggle next to Import opens the dropdown. The main
    // import-menu-button click opens the file picker, which we don't want
    // here — we want the menu. Look for the chevron toggle.
    const chevron = page.locator('[data-testid="import-menu-toggle"], button:has-text("Import") + button').first();
    const chevronCount = await chevron.count();
    if (chevronCount > 0) {
      await chevron.click();
    } else {
      // Fallback: click the import button itself and immediately screenshot
      // before the file picker steals focus.
      await page.getByTestId('import-menu-button').click({ noWaitAfter: true });
    }
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, '02-import-dropdown.png') });
    console.log('Saved 02-import-dropdown.png');
    // Dismiss any open menu/picker.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // ── 03: Viewer with the fixture cloud loaded ───────────────────────
    await page.getByTestId('import-menu-button').click();
    await page.waitForTimeout(200);
    const autoBtn = page.getByTestId('import-menu-auto');
    if (await autoBtn.count() > 0) {
      await autoBtn.click();
    }
    await page.getByTestId('app-dropzone-input').setInputFiles(FIXTURE);
    // Wait for the cloud to appear in the scene panel. The row testid is
    // "scan-row" (matches tests/e2e). Allow a generous timeout — a real TLS
    // scan can be hundreds of MB and take a while to parse and render.
    await page.locator('[data-testid="scan-row"]').first().waitFor({ timeout: 180_000 });
    // Extra beat for the viewer camera to settle on the imported data.
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(outDir, '03-first-scan.png') });
    console.log('Saved 03-first-scan.png');

    // ── 05: Command palette ─────────────────────────────────────────────
    // Open via Cmd+K (mac) — Playwright maps "Meta+K" to Cmd on darwin.
    const cmdKey = process.platform === 'darwin' ? 'Meta+K' : 'Control+K';
    await page.keyboard.press(cmdKey);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, '05-command-palette.png') });
    console.log('Saved 05-command-palette.png');
    await page.keyboard.press('Escape');
  } finally {
    console.log('Closing app...');
    await app.close().catch(() => {});
  }
  console.log(`Done. Screenshots in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
