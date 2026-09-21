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
//   docs/docs/assets/screenshots/03-first-scan.png
//   docs/docs/assets/screenshots/05-command-palette.png

import { _electron } from 'playwright';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
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

// The supervised backend now binds a per-instance port; pin one here and pass
// it to Electron via PHYTOGRAPH_BACKEND_PORT so we know where to poll.
const BACKEND_PORT = Number(process.env.PHYTOGRAPH_BACKEND_PORT) || 8008;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

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
  // Give the capture its own Chromium profile, for the same reason dev.mjs and
  // tests/e2e/helpers/launchApp.ts do. `electron .` otherwise derives userData
  // from the app NAME, which is the name the installed Phytograph.app uses, so
  // this script would (a) trip the single-instance lock and exit windowless
  // whenever the user has the desktop app open, and (b) share that app's
  // profile — including `<userData>/Cache`, which Chromium EMPTIES on startup,
  // wiping the running app's octree cache mid-session. A stable path (not
  // mkdtemp) so repeat captures reuse one profile instead of littering tmp.
  const userDataDir = join(tmpdir(), 'phytograph-screenshots-userdata');
  const app = await _electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    timeout: 60_000,
    // Deliberately NOT setting PHYTOGRAPH_E2E=1 — we want the window visible.
    env: { ...process.env, PHYTOGRAPH_BACKEND_PORT: String(BACKEND_PORT) },
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

    // ── 03: Viewer with the fixture cloud loaded ───────────────────────
    // Import through the File → Import menu pathway, the same one
    // tests/e2e/helpers/importFiles.ts drives. Setting the dropzone's hidden
    // file input directly does NOT work: the renderer reads the chosen file's
    // bytes over `fs:readBinary`, which is gated by the main process's fs
    // allowlist (src/main/fsAllowlist.ts), and only the real `dialog:open`
    // handler seeds that allowlist. A setInputFiles() import is therefore
    // denied downstream and never produces a scan row — it fails silently,
    // which is exactly how this script broke.
    const fixtureAbs = resolve(repoRoot, FIXTURE);
    await page.getByTestId('app-dropzone-input').waitFor({ state: 'attached', timeout: 60_000 });
    await app.evaluate(async ({ ipcMain }, fixturePath) => {
      ipcMain.removeHandler('dialog:open');
      const allow = globalThis.__phytographAllowPath;
      allow?.(fixturePath);
      ipcMain.handle('dialog:open', async () => [fixturePath]);
    }, fixtureAbs);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command', { kind: 'import-point-cloud' });
    });
    // Every path-backed point-cloud import now goes through the import wizard
    // (column mapping / preview), so it must be confirmed before anything lands
    // in the scene. Mirrors tests/e2e/helpers/importWizard.ts.
    const wizard = page.getByTestId('import-wizard');
    await wizard.waitFor({ state: 'visible', timeout: 120_000 });
    const next = page.getByTestId('import-wizard-next');
    while ((await next.isVisible()) && (await next.isEnabled())) await next.click();
    const importBtn = page.getByTestId('import-wizard-import');
    await importBtn.waitFor({ state: 'visible', timeout: 120_000 });
    for (let i = 0; i < 600 && (await importBtn.isDisabled()); i++) await page.waitForTimeout(200);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await importBtn.click();
    await wizard.waitFor({ state: 'hidden', timeout: 120_000 });

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
