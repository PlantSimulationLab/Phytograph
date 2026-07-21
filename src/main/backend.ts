// Sidecar supervisor for the bundled Python/FastAPI backend.
// Direct port of phytograph-desktop/src-tauri/src/lib.rs.

import { spawn, execSync, ChildProcess } from 'node:child_process';
import { existsSync, chmodSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { EXPECTED_BACKEND_VERSION, BACKEND_PORT_PROD } from '../shared/constants.js';
import { IPC, type BackendStatusPayload } from '../shared/ipc.js';
import { backendLog } from './logger.js';

// Split a possibly-multi-line stdout/stderr chunk into clean lines for the log
// file. Carries a trailing partial line across chunks so a traceback split mid-
// write isn't logged as two mangled fragments. The carry is capped so a stream
// that never emits a newline (e.g. a \r-only progress spinner, which the split
// below intentionally does NOT break on) can't grow it without bound.
const MAX_CARRY = 64 * 1024;
function makeLineTee(emit: (line: string) => void): (buf: Buffer) => void {
  let carry = '';
  return (buf: Buffer) => {
    const text = carry + buf.toString();
    const lines = text.split(/\r?\n/);
    carry = lines.pop() ?? '';
    for (const line of lines) if (line.length) emit(line);
    if (carry.length > MAX_CARRY) {
      emit(carry);
      carry = '';
    }
  };
}

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

// --- Crash recovery state ----------------------------------------------------
// The sidecar can die mid-session (an open3d/PyHelios native crash, an OOM
// kill). Without recovery, every later /api/* call fails for the rest of the
// session with no surfaced reason. We respawn it on the SAME port (the renderer
// caches the backend URL once at init and never re-fetches it, so the port must
// not change) with a capped backoff, and push a status event so the renderer
// can tell the user their in-RAM sessions were lost and need re-importing.
let intentionalStop = false;        // true while stopBackend() is tearing down
let restartAttempts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = [500, 2000, 5000];

// How main reaches the renderer to push status. Set by setBackendWindowGetter()
// from main.ts (same pattern as installApplicationMenu / setupAutoUpdater).
let getMainWindow: () => BrowserWindow | null = () => null;

export function setBackendWindowGetter(getter: () => BrowserWindow | null): void {
  getMainWindow = getter;
}

// Called when the sidecar exhausts its restart budget ('failed'). main.ts wires
// this to the native crash dialog. Kept as a callback so the supervisor stays
// decoupled from the dialog/UI module.
let onBackendFailed: () => void = () => {};

export function setBackendFailedHandler(handler: () => void): void {
  onBackendFailed = handler;
}

function emitBackendStatus(payload: BackendStatusPayload): void {
  try {
    getMainWindow()?.webContents.send(IPC.BackendStatus, payload);
  } catch {
    // Window may be gone (quitting) — a dropped status event is harmless.
  }
}

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
  // Fresh start (or restart after a clean stop): re-arm crash recovery.
  intentionalStop = false;
  restartAttempts = 0;

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

  spawnChild(binPath, port);
}

/**
 * Spawn the backend child on `port` and wire its stdio + lifecycle handlers.
 * Factored out of startBackend so a crash recovery can re-run JUST the spawn
 * (reusing the already-resolved port) without re-doing the version probe.
 */
function spawnChild(binPath: string, port: number): void {
  console.log(`Starting backend: ${binPath} on port ${port}`);
  // PHYTOGRAPH_RESOURCES tells the backend where extraResources live in the
  // packaged app, so it can locate the bundled PotreeConverter binary at
  // <resourcesRoot>/potree_converter/<platform>/PotreeConverter.
  // PHYTOGRAPH_BACKEND_PORT tells backend_wrapper.py which port to bind.
  child = spawn(binPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Detach on POSIX so the child leads its own process group. The bundled
    // backend is a PyInstaller --onedir bootloader that forks the real Python
    // (uvicorn) server as a *grandchild*; killing only child.pid leaves that
    // grandchild orphaned, holding the port and file handles. With a dedicated
    // group we can `process.kill(-pid)` the whole tree in stopBackend(). Windows
    // has no process groups here — we fall back to taskkill /T in stopBackend().
    detached: process.platform !== 'win32',
    env: { ...process.env, PHYTOGRAPH_RESOURCES: resourcesRoot(), PHYTOGRAPH_BACKEND_PORT: String(port) },
  });

  console.log(`Backend started with PID: ${child.pid}`);
  // Python's `logging` writes to stderr by default, so most lines here
  // (INFO/WARNING/uvicorn access logs) are not actually errors. Label by
  // stream, not severity. Each chunk is (a) passed through to this process's
  // own stdout/stderr (terminal in dev) AND (b) teed line-by-line into the
  // unified session log under the [backend] scope, so packaged builds — where
  // there's no terminal — still capture the sidecar's diagnostics.
  const outTee = makeLineTee((line) => backendLog.info(line));
  const errTee = makeLineTee((line) => backendLog.info(line));
  child.stdout?.on('data', (buf) => {
    process.stdout.write(`[Backend stdout]: ${buf}`);
    outTee(buf);
  });
  child.stderr?.on('data', (buf) => {
    process.stderr.write(`[Backend stderr]: ${buf}`);
    errTee(buf);
  });
  // Without this, spawn failures (EACCES, missing dyld, etc.) become uncaught
  // 'error' events on the ChildProcess and disappear silently.
  child.on('error', (err) => {
    console.error('[Backend] spawn failed:', err);
    child = null;
  });
  child.on('exit', (code, signal) => {
    console.log(`Backend exited (code=${code}, signal=${signal})`);
    child = null;
    if (!intentionalStop) handleUnexpectedExit(binPath, port);
  });
}

/**
 * The sidecar died and we didn't ask it to. Respawn it on the same port with a
 * capped backoff; notify the renderer along the way so the user learns their
 * in-RAM sessions are gone and a re-import is needed.
 */
function handleUnexpectedExit(binPath: string, port: number): void {
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.error(`[Backend] crashed and exhausted ${MAX_RESTART_ATTEMPTS} restart attempts; giving up.`);
    emitBackendStatus({ status: 'failed', port });
    onBackendFailed();
    return;
  }
  const delay = RESTART_BACKOFF_MS[Math.min(restartAttempts, RESTART_BACKOFF_MS.length - 1)];
  restartAttempts += 1;
  console.warn(`[Backend] crashed; respawning (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS}) in ${delay}ms on port ${port}.`);
  emitBackendStatus({ status: 'restarting', port });
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (intentionalStop) return;  // app started quitting while we waited
    if (!existsSync(binPath)) {
      console.error(`[Backend] binary missing at ${binPath}; cannot respawn.`);
      emitBackendStatus({ status: 'failed', port });
      onBackendFailed();
      return;
    }
    spawnChild(binPath, port);
    // Confirm the respawn actually bound the port before declaring success, so
    // the renderer's `ready` toast is reliable. The bundled backend takes a
    // moment to import + bind, so poll /version a few times. If it never
    // answers, the child's own 'exit' drives the next attempt; a success resets
    // the attempt counter so later, unrelated crashes get a fresh budget.
    void confirmHealthy(port).then((v) => {
      if (v && !intentionalStop) {
        restartAttempts = 0;
        console.log(`[Backend] respawned and healthy (v${v}) on port ${port}.`);
        emitBackendStatus({ status: 'ready', port });
      }
    });
  }, delay);
}

/** Poll /version up to ~10s; resolve with the version string or null. */
async function confirmHealthy(port: number): Promise<string | null> {
  for (let i = 0; i < 5; i++) {
    if (intentionalStop || child === null) return null;
    const v = await fetchVersion(port);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// Signal every process in the backend's tree. On POSIX the child leads its own
// group (spawn `detached`), so a negative PID targets the whole group — the
// PyInstaller bootloader AND the uvicorn Python grandchild it forked. Falls back
// to a plain single-PID kill if the group send fails (e.g. the group is already
// gone, or `detached` was somehow not honored). On Windows there's no group; we
// use taskkill /T /F to take down the child and all descendants forcefully.
function signalBackendTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // /T kills the child and all descendants; /F forces it. (Windows has no
    // graceful group SIGTERM equivalent here — Node's kill() is already a
    // forceful TerminateProcess — so we go straight to the whole-tree force.)
    try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-pid, signal); // negative pid → the whole process group
  } catch {
    try { proc.kill(signal); } catch { /* already gone */ }
  }
}

// Block the calling thread for `ms` without spawning a subprocess. Node permits
// Atomics.wait on the main thread (unlike browsers); wrapped defensively so a
// surprise throw degrades to "no wait" rather than breaking quit.
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* fall through — caller tolerates a shorter/absent wait */ }
}

// Synchronously wait (up to timeoutMs) for a POSIX process to disappear, polling
// liveness with signal 0 (throws ESRCH once gone) and breaking as soon as it
// exits. We can't observe the async 'exit' event here: stopBackend runs on the
// synchronous signal-shutdown path (postMortem.ts calls process.exit(0) the
// instant we return), so the event loop never turns to deliver it. Returns true
// if the process exited within the window.
function waitForExitSync(pid: number, timeoutMs: number): boolean {
  const stepMs = 50;
  for (let waited = 0; waited < timeoutMs; waited += stepMs) {
    try { process.kill(pid, 0); } catch { return true; } // ESRCH → gone
    sleepSync(stepMs);
  }
  try { process.kill(pid, 0); } catch { return true; }
  return false;
}

export function stopBackend(): void {
  intentionalStop = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const dying = child;
  if (!dying) return;
  console.log('Cleaning up backend...');
  // Track actual exit (not `dying.killed`, which flips true the instant we send
  // SIGTERM regardless of whether the process honored it). Without this, a
  // sidecar stuck in a long native open3d/Helios call would never get SIGKILL'd
  // and would orphan, holding its port and RAM.
  let exited = dying.exitCode !== null || dying.signalCode !== null;
  dying.once('exit', () => { exited = true; });
  // SIGTERM the whole tree — let uvicorn shut down gracefully if it can.
  signalBackendTree(dying, 'SIGTERM');
  // Then escalate to SIGKILL if it doesn't go, *synchronously*. This must finish
  // before we return, because the signal-shutdown path (postMortem.ts) calls
  // process.exit(0) the instant stopBackend() returns — an async timer would
  // never fire, which is exactly what previously left the backend tree orphaned
  // on every SIGTERM-driven quit (Playwright's _electron teardown, Ctrl-C). An
  // orphaned uvicorn (often mid native open3d/Helios call, deaf to SIGTERM) held
  // its port and file handles and, under CI's slower runner, wedged the next
  // launch / the Playwright worker teardown into the 180s timeout. Windows
  // already force-killed the whole tree above (taskkill /T /F), so it needs no
  // grace; on POSIX, block briefly for a clean group exit, then hard-kill.
  if (process.platform !== 'win32' && dying.pid !== undefined && !exited) {
    const stillAlive = !waitForExitSync(dying.pid, 1500);
    if (stillAlive) {
      console.warn('[Backend] did not exit on SIGTERM within grace; SIGKILL to the tree.');
      signalBackendTree(dying, 'SIGKILL');
    }
  }
  child = null;
  console.log('Backend terminated');
}
