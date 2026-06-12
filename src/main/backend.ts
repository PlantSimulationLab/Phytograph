// Sidecar supervisor for the bundled Python/FastAPI backend.
// Direct port of phytograph-desktop/src-tauri/src/lib.rs.

import { spawn, execSync, ChildProcess } from 'node:child_process';
import { existsSync, chmodSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { app } from 'electron';
import { EXPECTED_BACKEND_VERSION, BACKEND_PORT_PROD } from '../shared/constants.js';

// PyInstaller --onedir produces resources/phytograph_backend/phytograph_backend(.exe)
// alongside an _internal/ tree.
const BACKEND_BINARY_NAME = process.platform === 'win32' ? 'phytograph_backend.exe' : 'phytograph_backend';
const BACKEND_DIR_NAME = 'phytograph_backend';

let child: ChildProcess | null = null;

// The port this app instance's backend lives on. Resolved once in
// startBackend() and cached so getBackendPort() (used by the getInfo IPC) can
// report it to the renderer. Each app instance / dev session / E2E run gets its
// own free port so they never collide on a fixed 8008.
let resolvedPort: number | null = null;

/** Ask the OS for a free TCP port by binding :0 and reading back the assignment. */
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

/**
 * The backend port for this instance. Resolution order:
 *   1. PHYTOGRAPH_BACKEND_PORT — set by scripts/dev.mjs (dev) so the supervisor
 *      and the uvicorn it spawned agree on a port. Also honored if the user
 *      pins one.
 *   2. A previously resolved dynamic port (cached).
 *   3. A freshly chosen free port (packaged builds).
 * The packaged BACKEND_PORT_PROD (8008) is only the standalone-launch default
 * baked into backend_wrapper.py; it is no longer assumed here.
 */
async function resolvePort(): Promise<number> {
  const fromEnv = process.env.PHYTOGRAPH_BACKEND_PORT;
  if (fromEnv && Number.isInteger(Number(fromEnv))) {
    resolvedPort = Number(fromEnv);
    return resolvedPort;
  }
  if (resolvedPort != null) return resolvedPort;
  resolvedPort = await findFreePort();
  // Publish it so the spawned backend and the getInfo IPC see the same value.
  process.env.PHYTOGRAPH_BACKEND_PORT = String(resolvedPort);
  return resolvedPort;
}

/** The resolved backend port, or the prod default if startBackend hasn't run. */
export function getBackendPort(): number {
  return resolvedPort ?? (Number(process.env.PHYTOGRAPH_BACKEND_PORT) || BACKEND_PORT_PROD);
}

function resourcesRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources');
}

function backendBinaryPath(): string {
  return join(resourcesRoot(), BACKEND_DIR_NAME, BACKEND_BINARY_NAME);
}

async function fetchVersion(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    return json.version ?? null;
  } catch {
    return null;
  }
}

function killPort(port: number): void {
  if (process.platform === 'win32') {
    // Windows: netstat | findstr LISTENING -> taskkill /PID
    try {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const pids = new Set<string>();
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/LISTENING\s+(\d+)/);
        if (m) pids.add(m[1]);
      }
      for (const pid of pids) {
        console.log(`Killing old backend process (PID: ${pid})`);
        try { execSync(`taskkill /F /PID ${pid}`); } catch { /* ignore */ }
      }
    } catch {
      // No process on port, fine.
    }
  } else {
    try {
      const pid = execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim();
      if (pid) {
        console.log(`Killing old backend process (PID: ${pid})`);
        execSync(`kill -9 ${pid}`);
      }
    } catch {
      // No process on port, fine.
    }
  }
}

export async function startBackend(): Promise<void> {
  console.log(`Expected backend version: ${EXPECTED_BACKEND_VERSION}`);

  const port = await resolvePort();

  // PHYTOGRAPH_DEV_BACKEND=1 is set by scripts/dev.mjs when it has spawned
  // uvicorn --reload against backend-api/venv. In that case the supervisor
  // must stand down — killing the port and respawning the bundle would
  // defeat the whole point of hot-reload.
  if (process.env.PHYTOGRAPH_DEV_BACKEND === '1') {
    const v = await fetchVersion(port);
    if (v) {
      console.log(`Dev backend (uvicorn --reload) running v${v} on port ${port}; supervisor standing down.`);
    } else {
      console.warn(`PHYTOGRAPH_DEV_BACKEND=1 set but nothing answering on port ${port}. Did uvicorn fail to start?`);
    }
    return;
  }

  const existingVersion = await fetchVersion(port);
  let shouldStart = true;

  if (existingVersion) {
    if (existingVersion === EXPECTED_BACKEND_VERSION) {
      // A COMPATIBLE backend is already serving this port. Reuse it — never
      // kill it. This is what lets a second app instance (or an E2E run that
      // happened to land on the same port) coexist with a running dev backend
      // instead of murdering it with kill -9. With dynamic per-instance ports
      // a clash is now rare, but reuse is still the correct, safe response.
      console.log(`Found compatible backend v${existingVersion} on port ${port}, reusing it`);
      shouldStart = false;
    } else {
      // An INCOMPATIBLE version owns the port. This only happens when the port
      // was explicitly pinned (PHYTOGRAPH_BACKEND_PORT) to one already held by
      // a stale/older backend; a freshly chosen free port is never occupied.
      console.log(
        `Found incompatible backend v${existingVersion} (expected v${EXPECTED_BACKEND_VERSION}) on port ${port}, killing it`,
      );
      killPort(port);
    }
  }
  // Nothing answering (the common case for a dynamic port) → just start ours.
  // No pre-emptive killPort: a free port has nothing to kill, and killing a
  // pinned port we couldn't version-probe risks taking out an unrelated process.

  if (!shouldStart) return;

  const binPath = backendBinaryPath();
  console.log(`Backend path: ${binPath}`);

  if (!existsSync(binPath)) {
    if (app.isPackaged) {
      console.error(`Backend binary not found at ${binPath}. Please rebuild the bundle.`);
      return;
    }
    console.warn(
      `Backend binary not found at ${binPath}. Running in dev mode without backend — ` +
      `viewer features will work, fitting features will not.`,
    );
    return;
  }

  if (process.platform !== 'win32') {
    try { chmodSync(binPath, 0o755); } catch { /* ignore */ }
  }

  console.log(`Starting backend: ${binPath} on port ${port}`);
  // PHYTOGRAPH_RESOURCES tells the backend where extraResources live in the
  // packaged app, so it can locate the bundled PotreeConverter binary at
  // <resourcesRoot>/potree_converter/<platform>/PotreeConverter.
  // PHYTOGRAPH_BACKEND_PORT tells backend_wrapper.py which port to bind.
  child = spawn(binPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PHYTOGRAPH_RESOURCES: resourcesRoot(), PHYTOGRAPH_BACKEND_PORT: String(port) },
  });

  console.log(`Backend started with PID: ${child.pid}`);
  // Python's `logging` writes to stderr by default, so most lines here
  // (INFO/WARNING/uvicorn access logs) are not actually errors. Label by
  // stream, not severity.
  child.stdout?.on('data', (buf) => process.stdout.write(`[Backend stdout]: ${buf}`));
  child.stderr?.on('data', (buf) => process.stderr.write(`[Backend stderr]: ${buf}`));
  // Without this, spawn failures (EACCES, missing dyld, etc.) become uncaught
  // 'error' events on the ChildProcess and disappear silently.
  child.on('error', (err) => {
    console.error('[Backend] spawn failed:', err);
    child = null;
  });
  child.on('exit', (code, signal) => {
    console.log(`Backend exited (code=${code}, signal=${signal})`);
    child = null;
  });
}

export function stopBackend(): void {
  if (!child) return;
  console.log('Cleaning up backend...');
  try {
    child.kill();
  } catch (e) {
    console.error('Failed to terminate backend:', e);
  }
  child = null;
  console.log('Backend terminated');
}
