import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForBackend } from './waitForBackend';
// @ts-expect-error -- plain .mjs helper, shared with the standalone harness scripts
import { ensureHeadlessElectron } from '../../../scripts/headless-electron.mjs';
// @ts-expect-error -- plain .mjs helper, shared with scripts/check-backend-bundle.mjs
import { checkBackendBundle, readExpectedBackendVersion } from '../../../scripts/backend-version.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, '..', '..', '..');

// Each launched app gets its own free backend port (bind :0, read the
// assignment), passed to Electron via PHYTOGRAPH_BACKEND_PORT. This keeps a
// test run from ever colliding with a developer's `npm run dev` backend (or a
// parallel spec's app) — the supervisor binds the port we hand it, and we poll
// that same port. No fixed 8008 anywhere.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  backendVersion: string;
  // The per-launch octree cache root (PHYTOGRAPH_OCTREE_CACHE_ROOT). Exposed so
  // a spec can locate/delete a cloud's cache dir to exercise the missing-octree
  // recovery path. Removed by close().
  octreeCacheRoot: string;
  // Use this instead of app.close() — it awaits the Electron process exit,
  // not just the window close. Prevents spec-N+1 from racing spec-N's
  // teardown (which on macOS can briefly surface a window).
  // Refs: playwright#20016, playwright#12189, playwright#39248.
  close: () => Promise<void>;
}

function backendBinaryPath(): string {
  return process.platform === 'win32'
    ? join(repoRoot, 'resources', 'phytograph_backend', 'phytograph_backend.exe')
    : join(repoRoot, 'resources', 'phytograph_backend', 'phytograph_backend');
}

function mainEntry(): string {
  return join(repoRoot, 'dist-main', 'main.js');
}

/**
 * Launch the app. `extraEnv` adds environment variables for this launch, applied
 * over the defaults below — used to exercise a backend threshold whose real
 * trigger would need an impractically large fixture (e.g.
 * PHYTOGRAPH_TREEISO_MAX_NODES to make a small cloud cross the cost guideline).
 * The supervisor forwards its env to the spawned backend, so backend-side
 * variables reach it.
 */
export async function launchApp(extraEnv?: Record<string, string>): Promise<LaunchedApp> {
  // Verify the built backend BEFORE spawning anything. A bundle whose version
  // doesn't match EXPECTED_BACKEND_VERSION still boots and still answers
  // /version — the renderer just refuses it, so the splash never clears and the
  // spec dies ~30s later at whatever locator it was waiting on, with a stack
  // trace that names an unrelated helper. This check is a file read: it costs
  // nothing and it names the actual problem and its one-line fix.
  const bundle = checkBackendBundle();
  if (!bundle.ok) throw new Error(bundle.message);

  const backendBin = backendBinaryPath();
  const main = mainEntry();
  if (!existsSync(main)) {
    throw new Error(
      `dist-main/main.js missing. Run \`npm run build\` before E2E.`,
    );
  }

  const backendPort = await findFreePort();

  // Isolate the on-disk octree cache per launch. The cache is otherwise a single
  // per-user dir (~/Library/Application Support/Phytograph/cache/octrees) shared
  // by every instance — a concurrent dev app or parallel spec writing/evicting
  // there can corrupt the entry another instance is streaming. Both the backend
  // (_octree_cache_root) and the Electron protocol handler (octreeCacheRoot in
  // src/main/octreeProtocol.ts) honor PHYTOGRAPH_OCTREE_CACHE_ROOT, and the
  // supervisor forwards the full env to the spawned backend, so setting it here
  // points both at this run's private dir. Mirrors the pytest cache-isolation
  // fixtures. Removed in close().
  const octreeCacheRoot = await mkdtemp(join(tmpdir(), 'phyto-octree-'));

  // Launch a Dock-less clone of the Electron bundle instead of the one in
  // node_modules. main.ts's app.setActivationPolicy('accessory') can only
  // demote the app after AppKit has already registered it, so on its own it
  // leaves a Dock icon flashing once per spec file (91 of them). The clone has
  // LSUIElement=1 in its Info.plist, which AppKit reads before any JS runs, so
  // no tile is ever drawn. See scripts/headless-electron.mjs.
  //
  // null on non-macOS, or if the clone couldn't be built: Playwright then falls
  // back to require('electron'), which is exactly the previous behavior — the
  // accessory policy still applies, we just get the flash back.
  const headlessElectron: string | null = await ensureHeadlessElectron();

  const app = await _electron.launch({
    ...(headlessElectron ? { executablePath: headlessElectron } : {}),
    args: ['.'],
    cwd: repoRoot,
    timeout: 60_000,
    env: {
      ...process.env,
      // Suppresses the visible window and devtools in main.ts. See the
      // comments next to `isE2E` in src/main/main.ts.
      PHYTOGRAPH_E2E: '1',
      // Pin the supervised backend to this run's private port.
      PHYTOGRAPH_BACKEND_PORT: String(backendPort),
      // Private octree cache for this launch (see comment above).
      PHYTOGRAPH_OCTREE_CACHE_ROOT: octreeCacheRoot,
      // Per-test overrides last so a spec can tune backend thresholds.
      ...extraEnv,
    },
  });
  const page = await app.firstWindow();

  // Wait for the supervised backend to actually serve /version. The main
  // process spawns it on backendPort in startBackend(); we don't proceed until
  // it answers.
  const { version } = await waitForBackend(backendPort);

  // Belt-and-braces on top of the pre-launch stamp check: assert the version the
  // backend ACTUALLY served. The stamp describes the bundle on disk, but the
  // supervisor can reuse a compatible backend already on the port, and
  // PHYTOGRAPH_DEV_BACKEND makes it stand down entirely — so what answers here
  // isn't always what we stamped. The renderer demands an exact match before it
  // will clear the splash, so anything else is a guaranteed 30s-per-spec hang.
  const expected = readExpectedBackendVersion();
  if (version !== expected) {
    await app.close().catch(() => {});
    throw new Error(
      `Backend version mismatch — the app will never clear its splash screen.\n` +
        `  backend serving on port ${backendPort} = ${version}\n` +
        `  EXPECTED_BACKEND_VERSION              = ${expected}\n` +
        `Fix: npm run build:backend  (or stop the stale backend still on this port).`,
    );
  }

  const close = async (): Promise<void> => {
    const proc = app.process();
    const exited = new Promise<void>((resolve) => {
      if (proc.exitCode !== null) return resolve();
      proc.once('exit', () => resolve());
    });
    await app.close().catch(() => {});
    await Promise.race([
      exited,
      new Promise<void>((r) => setTimeout(r, 5_000)),
    ]);
    // Drop this run's private octree cache. Best-effort — a cleanup failure must
    // never fail the test.
    await rm(octreeCacheRoot, { recursive: true, force: true }).catch(() => {});
  };

  return { app, page, backendVersion: version, octreeCacheRoot, close };
}
