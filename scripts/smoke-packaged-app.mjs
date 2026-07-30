// Smoke-test the PACKAGED Electron app (not the dev build) — confirms the
// shipped installer produces an app that actually opens and runs, the gap our
// component smoke-tests (backend binary, notarization) and the dev-build E2E
// can't cover. This is what would have caught the first-launch crash dialog /
// macOS-reopen-no-backend class of bugs at the artifact level.
//
// It is intentionally NOT full E2E. It asserts only "opens and runs without
// instantly breaking":
//   1. the packaged binary launches and the process stays alive,
//   2. the first window opens,
//   3. the supervised backend answers /version with the expected version,
//   4. the renderer mounts (the #app-root element appears = splash cleared).
//
// Run after `electron-builder` has produced the build output dir. Usage:
//   node scripts/smoke-packaged-app.mjs
// On Linux/CI, wrap in a virtual display: xvfb-run -a node scripts/smoke-packaged-app.mjs

import { _electron } from 'playwright';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildOutputDir } from './build-output-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
// Must match wherever electron-builder actually wrote — local builds go to
// ~/builds/phytograph.noindex, CI keeps repo-relative release/.
const releaseDir = resolveBuildOutputDir();

const EXPECTED_VERSION = JSON.parse(
  readFileSync(join(repoRoot, 'package.json'), 'utf-8'),
).version;

function fail(msg) {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

// Locate the packaged executable that electron-builder produced under the
// build output dir (see build-output-dir.mjs).
//   macOS:   <output>/mac*/Phytograph.app/Contents/MacOS/Phytograph
//   Linux:   <output>/linux-unpacked/phytograph        (the unpacked binary)
//   Windows: <output>/win-unpacked/Phytograph.exe
function findPackagedBinary() {
  if (process.platform === 'darwin') {
    const macDirs = readdirSync(releaseDir).filter((d) => d.startsWith('mac'));
    for (const d of macDirs) {
      const bin = join(releaseDir, d, 'Phytograph.app', 'Contents', 'MacOS', 'Phytograph');
      if (existsSync(bin)) return bin;
    }
    return null;
  }
  if (process.platform === 'win32') {
    const bin = join(releaseDir, 'win-unpacked', 'Phytograph.exe');
    return existsSync(bin) ? bin : null;
  }
  // linux
  const bin = join(releaseDir, 'linux-unpacked', 'phytograph');
  return existsSync(bin) ? bin : null;
}

async function main() {
  if (!existsSync(releaseDir)) {
    fail(
      `no build output directory at ${releaseDir} — run electron-builder first ` +
        `(e.g. SKIP_NOTARIZATION=1 npm run package).`,
    );
  }
  const bin = findPackagedBinary();
  if (!bin) {
    fail(
      `could not find a packaged Phytograph binary under ${releaseDir}. ` +
        `Contents: ${readdirSync(releaseDir).join(', ')}`,
    );
  }
  console.log(`Smoke-testing packaged app: ${bin}`);
  console.log(`Expected backend/app version: ${EXPECTED_VERSION}`);

  const backendPort = await findFreePort();

  const app = await _electron.launch({
    executablePath: bin,
    // No args: launch the app exactly as a user would (don't pass '.' — that's
    // only for the dev `electron .` entry; the packaged binary already knows
    // its main).
    timeout: 90_000, // packaged cold start (PyInstaller unpack) is slow
    env: {
      ...process.env,
      PHYTOGRAPH_E2E: '1', // suppress devtools; keep behavior headless-friendly
      PHYTOGRAPH_BACKEND_PORT: String(backendPort),
    },
  });

  // Guard: if the process dies during startup, surface it as a crash rather
  // than hanging until a timeout.
  let exitedEarly = null;
  app.process().once('exit', (code) => {
    exitedEarly = code;
  });

  try {
    // 2. First window opens.
    const page = await app.firstWindow({ timeout: 90_000 });
    if (exitedEarly !== null) fail(`app process exited (code ${exitedEarly}) before a window opened — instant crash.`);
    console.log('✓ window opened');

    // 3. Backend answers /version with the expected version.
    const deadline = Date.now() + 120_000;
    let version = null;
    while (Date.now() < deadline) {
      if (exitedEarly !== null) fail(`app process exited (code ${exitedEarly}) while waiting for the backend.`);
      try {
        const res = await fetch(`http://127.0.0.1:${backendPort}/version`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) {
          const json = await res.json();
          if (json.version) { version = json.version; break; }
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!version) fail('backend never answered /version within 120s.');
    if (version !== EXPECTED_VERSION) {
      fail(`backend version "${version}" != package.json "${EXPECTED_VERSION}".`);
    }
    console.log(`✓ backend serving /version (${version})`);

    // 4. Renderer mounts (splash cleared → #app-root present). data-testid maps
    // to the [data-testid="app-root"] wrapper in src/renderer/App.tsx.
    await page.waitForSelector('[data-testid="app-root"]', { timeout: 60_000 });
    console.log('✓ renderer mounted (app-root visible)');

    // 1. Still alive after the UI is up (no delayed instant-crash).
    if (app.process().exitCode !== null) {
      fail(`app process exited (code ${app.process().exitCode}) right after startup.`);
    }
    console.log('✓ process healthy');
  } finally {
    await app.close().catch(() => {});
  }

  console.log('SMOKE PASS: packaged app launches, backend connects, UI mounts.');
}

main().catch((e) => fail(e?.stack || String(e)));
