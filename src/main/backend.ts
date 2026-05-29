// Sidecar supervisor for the bundled Python/FastAPI backend.
// Direct port of phytograph-desktop/src-tauri/src/lib.rs.

import { spawn, execSync, ChildProcess } from 'node:child_process';
import { existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { EXPECTED_BACKEND_VERSION, BACKEND_PORT_PROD } from '../shared/constants.js';

// PyInstaller --onedir produces resources/phytograph_backend/phytograph_backend(.exe)
// alongside an _internal/ tree.
const BACKEND_BINARY_NAME = process.platform === 'win32' ? 'phytograph_backend.exe' : 'phytograph_backend';
const BACKEND_DIR_NAME = 'phytograph_backend';

let child: ChildProcess | null = null;

function resourcesRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources');
}

function backendBinaryPath(): string {
  return join(resourcesRoot(), BACKEND_DIR_NAME, BACKEND_BINARY_NAME);
}

async function fetchVersion(): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${BACKEND_PORT_PROD}/version`, {
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

  // PHYTOGRAPH_DEV_BACKEND=1 is set by scripts/dev.mjs when it has spawned
  // uvicorn --reload against backend-api/venv. In that case the supervisor
  // must stand down — killing the port and respawning the bundle would
  // defeat the whole point of hot-reload.
  if (process.env.PHYTOGRAPH_DEV_BACKEND === '1') {
    const v = await fetchVersion();
    if (v) {
      console.log(`Dev backend (uvicorn --reload) running v${v} on port ${BACKEND_PORT_PROD}; supervisor standing down.`);
    } else {
      console.warn(`PHYTOGRAPH_DEV_BACKEND=1 set but nothing answering on port ${BACKEND_PORT_PROD}. Did uvicorn fail to start?`);
    }
    return;
  }

  const existingVersion = await fetchVersion();
  let shouldStart = true;

  if (existingVersion) {
    if (existingVersion === EXPECTED_BACKEND_VERSION) {
      console.log(`Found compatible backend v${existingVersion} on port ${BACKEND_PORT_PROD}, reusing it`);
      shouldStart = false;
    } else {
      console.log(
        `Found incompatible backend v${existingVersion} (expected v${EXPECTED_BACKEND_VERSION}), killing it`,
      );
      killPort(BACKEND_PORT_PROD);
    }
  } else {
    // Either nothing there or a very old version that doesn't expose /version.
    killPort(BACKEND_PORT_PROD);
  }

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

  console.log(`Starting backend: ${binPath}`);
  // PHYTOGRAPH_RESOURCES tells the backend where extraResources live in the
  // packaged app, so it can locate the bundled PotreeConverter binary at
  // <resourcesRoot>/potree_converter/<platform>/PotreeConverter.
  child = spawn(binPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PHYTOGRAPH_RESOURCES: resourcesRoot() },
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
