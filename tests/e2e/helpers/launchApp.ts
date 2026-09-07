import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForBackend } from './waitForBackend';
// @ts-expect-error -- plain .mjs helper, shared with the standalone harness scripts
import { ensureHeadlessElectron } from '../../../scripts/headless-electron.mjs';
// @ts-expect-error -- plain .mjs helper, shared with scripts/check-backend-bundle.mjs
import { checkBackendBundle, readExpectedBackendVersion } from '../../../scripts/backend-version.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(__dirname, '..', '..', '..');

/**
 * The tails of the log files this launch wrote, for a launch that failed.
 *
 * The main process routes console.* through electron-log (src/main/logger.ts),
 * so nothing useful reaches the Electron process's stdout — the file is the
 * record. logger.ts names it `main-<iso>-pid<PID>.log`, and the sidecar names
 * its own `phytograph-backend-<same tag>.log` beside it, so the main process's
 * pid is enough to find both. The directory is electron-log's default:
 * `~/Library/Logs/<app name>` on macOS, `<userData>/logs` elsewhere — and
 * userData here is the private `--user-data-dir` this launch was given. The
 * app name is lowercase `phytograph` because main.ts only calls
 * app.setName('Phytograph') outside E2E.
 */
async function sessionLogTails(pid: number | undefined, userDataDir: string, lines = 60): Promise<string> {
  const dir = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Logs', 'phytograph')
    : join(userDataDir, 'logs');
  if (pid === undefined) return `(no main-process pid; cannot locate logs under ${dir})`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return `(no log directory at ${dir} — the main process never got as far as logging)`;
  }
  const main = names.find((n) => n.startsWith('main-') && n.endsWith(`-pid${pid}.log`));
  if (!main) return `(no main-*-pid${pid}.log under ${dir}; files present: ${names.join(', ') || 'none'})`;
  const tag = main.slice('main-'.length, -'.log'.length);
  const out: string[] = [];
  for (const name of [main, `phytograph-backend-${tag}.log`]) {
    let text: string;
    try {
      text = await readFile(join(dir, name), 'utf8');
    } catch {
      out.push(`--- ${name}: not written (the sidecar never started logging) ---`);
      continue;
    }
    const all = text.split('\n').filter((l) => l.trim().length > 0);
    out.push(`--- ${join(dir, name)} (last ${Math.min(lines, all.length)} of ${all.length} lines) ---`);
    out.push(...all.slice(-lines));
  }
  return out.join('\n');
}

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
  // The per-launch Electron userData dir (--user-data-dir). Exposed so a spec
  // can inspect the persisted store it writes. Removed by close().
  userDataDir: string;
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
  // per-user dir (~/Library/Caches/Phytograph/octrees on macOS) shared
  // by every instance — a concurrent dev app or parallel spec writing/evicting
  // there can corrupt the entry another instance is streaming. Both the backend
  // (_octree_cache_root) and the Electron protocol handler (octreeCacheRoot in
  // src/main/octreeProtocol.ts) honor PHYTOGRAPH_OCTREE_CACHE_ROOT, and the
  // supervisor forwards the full env to the spawned backend, so setting it here
  // points both at this run's private dir. Mirrors the pytest cache-isolation
  // fixtures. Removed in close().
  const octreeCacheRoot = await mkdtemp(join(tmpdir(), 'phyto-octree-'));

  // Isolate the ELECTRON PROFILE per launch, for the same reason as the octree
  // cache but with sharper teeth. `electron .` derives userData from the app
  // name, which is the same name the packaged app uses — so a test run, a
  // developer's `npm run dev`, and the installed Phytograph.app all shared ONE
  // directory: ~/Library/Application Support/phytograph. That directory holds
  // the user's real preferences (`phytograph-store.json`: theme, point size,
  // class palettes, rivlib path, synthetic-scan defaults) AND Chromium's
  // profile. Two concrete failures came out of it:
  //
  //   - Any spec that changes a setting through the UI overwrote the
  //     developer's actual preferences, permanently and silently.
  //   - Chromium EMPTIES <userData>/Cache when it initialises its disk cache,
  //     so every launch here wiped whatever the running desktop app had in
  //     there. That is how the octree cache (once <userData>/cache/octrees, the
  //     same directory on case-insensitive APFS) was destroyed mid-session,
  //     costing a user the edits on a cloud that had diverged from its file.
  //
  // --user-data-dir is a Chromium switch Electron honours before any JS runs,
  // and app.getPath('userData') follows it, so electron-store lands here too.
  // Per-launch rather than stable: specs must not inherit each other's settings.
  // Note this makes every launch a "first run" (ipc.ts probes for the store
  // file), which only changes splash wording — no spec asserts on it.
  const userDataDir = await mkdtemp(join(tmpdir(), 'phyto-userdata-'));

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
    args: ['.', `--user-data-dir=${userDataDir}`],
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
  // it answers. If it never does, say WHY: attach the tails of this launch's
  // own log files, which is where the supervisor's decision (spawn threw, port
  // taken, stood down, respawn budget exhausted) and the sidecar's own startup
  // trace actually live. Without them a launch failure reports only "did not
  // become ready within 120000ms" — all that CI shard 2 had to offer for
  // lad-export.spec.ts on run 34081346174, a first-time failure with nothing
  // to chase.
  let version: string;
  try {
    ({ version } = await waitForBackend(backendPort));
  } catch (err) {
    const pid = app.process().pid;
    await app.close().catch(() => {});
    throw new Error(`${(err as Error).message}\n\n${await sessionLogTails(pid, userDataDir)}`);
  }

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
    // Drop this run's private octree cache and Electron profile. Best-effort —
    // a cleanup failure must never fail the test.
    await rm(octreeCacheRoot, { recursive: true, force: true }).catch(() => {});
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  };

  return { app, page, backendVersion: version, octreeCacheRoot, userDataDir, close };
}
