// Captures QSM-workflow screenshots for the user guide.
//
// Companion to capture-screenshots.mjs (the generic onboarding captures). This
// one drives the actual Build-QSM workflow end-to-end against the live backend
// and shoots the states a user sees: the build panel, the rank-colored model
// with its results panel, and the per-shoot coloring.
//
// Same launch path as capture-screenshots.mjs (visible window, NOT the hidden
// E2E mode). Prereqs identical:
//   npm run build           # dist-main/
//   npm run build:backend   # resources/phytograph_backend/
//
// Run from the repo root (the committed tree fixture is the default; override
// with SCREENSHOT_FIXTURE to shoot a real dormant scan):
//   node docs/scripts/capture-qsm-screenshots.mjs
//
// Output (docs/docs/assets/screenshots/):
//   qsm-01-panel.png        the Build QSM panel
//   qsm-02-rank.png         built model colored by shoot rank + results panel
//   qsm-03-shoot.png        the same model colored by shoot id

import { _electron } from 'playwright';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const outDir = join(repoRoot, 'docs', 'docs', 'assets', 'screenshots');

// Default to the committed Y-tree fixture so this runs on any checkout; a real
// dormant TLS scan makes a richer picture (set SCREENSHOT_FIXTURE).
const FIXTURE =
  process.env.SCREENSHOT_FIXTURE || join(repoRoot, 'tests', 'e2e', 'fixtures', 'tree.xyz');

// Per-instance backend port; pin one and pass it to Electron. See backend.ts.
const BACKEND_PORT = Number(process.env.PHYTOGRAPH_BACKEND_PORT) || 8008;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

async function waitForBackend(timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${BACKEND_URL}/version`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return await res.json();
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
  if (!existsSync(backendBin)) throw new Error('Backend missing — run `npm run build:backend` first.');
  if (!existsSync(join(repoRoot, 'dist-main', 'main.js'))) throw new Error('dist-main missing — run `npm run build` first.');
  if (!existsSync(FIXTURE)) throw new Error(`Fixture missing: ${FIXTURE}`);

  console.log('Launching Phytograph...');
  // PHYTOGRAPH_E2E=1 makes main.ts load the BUILT renderer (dist-renderer) via
  // loadFile instead of the Vite dev server at :1427 (which isn't running here),
  // and keeps the OS window hidden. Playwright still captures the rendered page,
  // so the screenshots are real — we just don't need the window painted on a
  // physical display. (Without this, an unpackaged launch tries localhost:1427
  // and lands on chrome-error.)
  const app = await _electron.launch({
    args: ['.'],
    cwd: repoRoot,
    timeout: 60_000,
    env: { ...process.env, PHYTOGRAPH_E2E: '1', PHYTOGRAPH_BACKEND_PORT: String(BACKEND_PORT) },
  });
  const page = await app.firstWindow();

  try {
    await waitForBackend();
    console.log('Backend ready.');
    // Wait for the renderer shell to actually mount before driving it (the
    // visible-window launch can take a beat longer than the hidden E2E mode).
    await page.getByTestId('app-dropzone-input').waitFor({ state: 'attached', timeout: 60_000 });
    await page.waitForTimeout(1000);

    // ── Import the fixture as a point cloud ──
    // E2E mode disables the native menu chrome and the in-window import
    // dropdown was removed, so fire the File → Import menu command over IPC
    // (exactly what a native menu click does) to set the import type, then
    // feed the dropzone's hidden input directly — the menu command arrives
    // without user activation, so react-dropzone's open() can't surface a
    // native chooser here. Mirrors tests/e2e/helpers/importFiles.ts.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: 'import-point-cloud' });
    });
    await page.getByTestId('app-dropzone-input').setInputFiles(FIXTURE);

    // Complete the import wizard (mirrors tests/e2e/helpers/importWizard.ts):
    // step to the last scan, then click Import once it enables.
    await page.getByTestId('import-wizard').waitFor({ timeout: 30_000 });
    const next = page.getByTestId('import-wizard-next');
    while ((await next.isVisible().catch(() => false)) && (await next.isEnabled().catch(() => false))) {
      await next.click();
    }
    const importBtn = page.getByTestId('import-wizard-import');
    await importBtn.waitFor({ timeout: 30_000 });
    for (let i = 0; i < 60 && !(await importBtn.isEnabled().catch(() => false)); i++) {
      await page.waitForTimeout(500);
    }
    await importBtn.click();
    await page.getByTestId('import-wizard').waitFor({ state: 'hidden', timeout: 30_000 });

    const cloudRow = page.locator('[data-testid="scan-row"]').first();
    await cloudRow.waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);

    // ── qsm-01: the Build QSM panel ─────────────────────────────────────────
    await page.getByTestId('tool-qsm').click();
    await page.getByTestId('qsm-panel').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, 'qsm-01-panel.png') });
    console.log('Saved qsm-01-panel.png');

    // ── Run the build ───────────────────────────────────────────────────────
    await page.getByTestId('qsm-build-button').click();
    const qsmRow = page.getByTestId('qsm-row').first();
    await qsmRow.waitFor({ timeout: 90_000 });
    // Let the cylinder mesh render and the camera settle.
    await page.waitForTimeout(2500);

    // HIDE the source point cloud, so the screenshots show the QSM cylinder
    // model on its own. On a dense real scan the 60k points otherwise sit on top
    // of the thin tubes and you see only the cloud, not the QSM (its whole point
    // — the rank/shoot coloring — is hidden underneath). The scan-row's eye
    // button is titled "Hide" while the scan is visible.
    const hideBtn = page.locator('[data-testid="scan-row"] button[title="Hide"]').first();
    if (await hideBtn.count().catch(() => 0)) {
      await hideBtn.click();
      await page.waitForTimeout(1500);
    }

    // ── qsm-02: model colored by shoot rank + results panel ─────────────────
    await page.getByTestId('qsm-color-mode').selectOption('rank').catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(outDir, 'qsm-02-rank.png') });
    console.log('Saved qsm-02-rank.png');

    // ── qsm-03: model colored by shoot id ───────────────────────────────────
    await page.getByTestId('qsm-color-mode').selectOption('shoot').catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(outDir, 'qsm-03-shoot.png') });
    console.log('Saved qsm-03-shoot.png');

    await page.getByTestId('qsm-color-mode').selectOption('rank').catch(() => {});
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
