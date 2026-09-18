import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// backend.ts pulls in electron, node:child_process, and ./logger.js (which imports
// electron-log). Mock all three so the module loads headless and we can drive the
// supervisor's spawn → exit → respawn loop deterministically.

const spawnMock = vi.fn();
const execSyncMock = vi.fn(() => '');

vi.mock('node:child_process', () => {
  const mod = {
    spawn: (...args: unknown[]) => spawnMock(...(args as [])),
    execSync: (...args: unknown[]) => execSyncMock(...(args as [])),
    ChildProcess: class {},
  };
  return { ...mod, default: mod };
});

// existsSync(binPath) must be true so respawn proceeds; chmodSync is a no-op.
vi.mock('node:fs', () => {
  const mod = { existsSync: () => true, chmodSync: () => undefined };
  return { ...mod, default: mod };
});

// resolvePort() may call createServer when no port is pinned; we pin one, but
// keep node:net mockable so it never binds a real socket.
vi.mock('node:net', () => {
  const mod = { createServer: () => ({ once() {}, listen() {}, close() {}, address: () => ({ port: 0 }) }) };
  return { ...mod, default: mod };
});

// A minimal BrowserWindow-less electron surface. app.isPackaged/getAppPath are
// only touched by paths we don't exercise here.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/repo' },
  BrowserWindow: class {},
}));

// logger.ts imports electron-log; stub the scoped logger backend.ts uses.
vi.mock('./logger.js', () => ({
  backendLog: { info: vi.fn() },
}));

// A fake child process: an EventEmitter with a pid and null stdio streams, plus
// killed/exitCode/signalCode fields the supervisor reads. Tests emit 'exit' on it
// to simulate the backend dying.
function makeFakeChild(pid: number) {
  const ee = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: null;
    stderr: null;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (sig?: NodeJS.Signals) => boolean;
  };
  ee.pid = pid;
  ee.stdout = null;
  ee.stderr = null;
  ee.exitCode = null;
  ee.signalCode = null;
  ee.kill = () => true;
  return ee;
}

describe('describeExit', () => {
  let describeExit: typeof import('./backend.js').describeExit;
  beforeEach(async () => {
    vi.resetModules();
    ({ describeExit } = await import('./backend.js'));
  });

  it('code 0 is a clean exit, not a crash', () => {
    expect(describeExit(0, null)).toBe('exited cleanly');
    expect(describeExit(0, null)).not.toContain('crash');
  });

  it('a bare external signal is "terminated", not "crashed"', () => {
    expect(describeExit(null, 'SIGTERM')).toBe('was terminated (signal=SIGTERM)');
    expect(describeExit(null, 'SIGKILL')).not.toContain('crash');
  });

  it('a non-zero exit code is a genuine crash', () => {
    expect(describeExit(1, null)).toBe('crashed (code=1)');
    expect(describeExit(139, 'SIGSEGV')).toContain('crashed');
  });
});

// A backend that cannot LOAD is not a crash to retry — it is the wrong machine.
// The Linux AppImage is compiled on ubuntu-24.04 and needs glibc 2.38+, so on
// Ubuntu 22.04 / RHEL 8-9 the window opens and the sidecar dies instantly. Before
// this classifier the user saw an app that silently did nothing, and the crash
// dialog offered a Reload that could never succeed.
describe('classifyBackendFailure', () => {
  let classifyBackendFailure: typeof import('./backend.js').classifyBackendFailure;
  beforeEach(async () => {
    vi.resetModules();
    ({ classifyBackendFailure } = await import('./backend.js'));
  });

  // Verbatim from the Ubuntu 22.04 HPC node where this was found.
  const REAL_GLIBC_FAILURE = [
    '[PYI-10069:ERROR] Failed to load Python shared library',
    "'/tmp/.mount_PhytogitPFFl/resources/resources/phytograph_backend/_internal/libpython3.11.so.1.0':",
    "/lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found",
  ];

  it('recognises the real glibc loader error and names the version needed', () => {
    const cause = classifyBackendFailure(REAL_GLIBC_FAILURE);
    expect(cause).toBeTruthy();
    expect(cause).toContain('GLIBC_2.38');
    expect(cause).toMatch(/glibc/i);
  });

  it('tells the user retrying cannot help', () => {
    // The whole point: the old dialog offered Reload, which loops forever.
    expect(classifyBackendFailure(REAL_GLIBC_FAILURE)).toMatch(/will not help/i);
  });

  it('points at a check the user can actually run', () => {
    expect(classifyBackendFailure(REAL_GLIBC_FAILURE)).toContain('ldd --version');
  });

  it('recognises a libstdc++ (GLIBCXX) mismatch too', () => {
    const cause = classifyBackendFailure([
      "./phytograph_backend: /lib/libstdc++.so.6: version `GLIBCXX_3.4.32' not found",
    ]);
    expect(cause).toContain('GLIBCXX_3.4.32');
  });

  it('recognises a missing shared library', () => {
    const cause = classifyBackendFailure([
      './phytograph_backend: error while loading shared libraries: libGL.so.1: cannot open shared object file',
    ]);
    expect(cause).toContain('libGL.so.1');
  });

  it('returns null for an ordinary crash, leaving the normal restart path alone', () => {
    // Must NOT hijack a real crash: those are retryable and the generic dialog
    // (with its Reload button) is the right response.
    expect(classifyBackendFailure(['Traceback (most recent call last):', 'MemoryError'])).toBeNull();
    expect(classifyBackendFailure([])).toBeNull();
    // A log line that merely mentions glibc is not a loader failure.
    expect(classifyBackendFailure(['INFO: built against GLIBC_2.38'])).toBeNull();
  });
});

describe('restart budget (Bug B: healthy /version must not reset it)', () => {
  let startBackend: typeof import('./backend.js').startBackend;
  let setBackendFailedHandler: typeof import('./backend.js').setBackendFailedHandler;
  const onFailed = vi.fn();
  let children: ReturnType<typeof makeFakeChild>[] = [];

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    spawnMock.mockReset();
    onFailed.mockReset();
    children = [];
    // Every spawn returns a fresh fake child and records it.
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild(1000 + children.length);
      children.push(c);
      return c;
    });
    // /version behavior: the FIRST probe (startBackend's pre-start check) must
    // FAIL so the supervisor spawns its own backend instead of reusing an existing
    // one on the pinned port. Every probe after that answers 200, so each respawn
    // is "healthy" the instant it binds — exactly the condition that used to reset
    // the budget every cycle (Bug B).
    let probeCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        probeCount += 1;
        if (probeCount === 1) throw new Error('nothing on port yet');
        return { ok: true, json: async () => ({ version: 'test' }) };
      }),
    );
    // Pin a port so resolvePort() doesn't bind a real socket.
    process.env.PHYTOGRAPH_BACKEND_PORT = '52999';
    process.env.PHYTOGRAPH_E2E = ''; // don't take the E2E branch anywhere

    ({ startBackend, setBackendFailedHandler } = await import('./backend.js'));
    setBackendFailedHandler(onFailed);
  });

  afterEach(() => {
    delete process.env.PHYTOGRAPH_BACKEND_PORT;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('gives up after MAX_RESTART_ATTEMPTS when each respawn dies before the stable window', async () => {
    await startBackend();
    // The first probe failed → the supervisor spawned its own backend.
    expect(children.length).toBe(1);

    // Churn: each live child answers /version (healthy → emits 'ready') but dies
    // shortly after, before HEALTHY_RESET_MS. The budget must NOT reset, so after
    // 3 attempts the supervisor gives up and calls onBackendFailed.
    for (let i = 0; i < 5 && onFailed.mock.calls.length === 0; i++) {
      const current = children[children.length - 1];
      current.emit('exit', 1, null); // crash (non-zero) — unexpected exit
      // Advance past the backoff so the respawn timer fires and spawns the next,
      // plus confirmHealthy's /version poll + its .then. Deliberately do NOT
      // advance past HEALTHY_RESET_MS (45s) — so the budget is never reset.
      await vi.advanceTimersByTimeAsync(8000);
    }

    expect(onFailed).toHaveBeenCalled();
    // Sanity: without the fix, the budget would reset on every 'ready' and we'd
    // spawn far more than the capped attempts. Bound the spawn count.
    expect(children.length).toBeLessThanOrEqual(1 + 3);
  });

  it('resets the budget once a respawn stays healthy past the stable window', async () => {
    await startBackend();
    expect(children.length).toBe(1);

    // First crash → respawn #1 comes up healthy and STAYS up past HEALTHY_RESET_MS.
    children[0].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(8000); // backoff + /version → 'ready'
    expect(children.length).toBe(2);
    await vi.advanceTimersByTimeAsync(46_000); // cross the 45s stable window → reset

    // Now a fresh crash should get the FULL budget again (not fail immediately),
    // proving the reset happened. Drive one more crash and confirm it respawns
    // rather than giving up.
    children[1].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(8000);
    expect(children.length).toBe(3);
    expect(onFailed).not.toHaveBeenCalled();
  });
});

describe('synchronous spawn throw (wrong-arch backend: EBADARCH on Intel Macs)', () => {
  // The v0.50.0 x64 dmg shipped an arm64 backend; on an Intel Mac spawn()
  // THROWS synchronously (`spawn Unknown system error -86`) instead of
  // emitting the async 'error' event. That throw used to reject startBackend(),
  // which killed main.ts's startup chain before createWindow() — the app sat
  // in the Dock with no window. The contract now: startBackend() RESOLVES, the
  // recovery retries burn out, and onBackendFailed fires (→ crash dialog).
  let startBackend: typeof import('./backend.js').startBackend;
  let setBackendFailedHandler: typeof import('./backend.js').setBackendFailedHandler;
  const onFailed = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    spawnMock.mockReset();
    onFailed.mockReset();
    spawnMock.mockImplementation(() => {
      throw Object.assign(new Error('spawn Unknown system error -86'), { errno: -86 });
    });
    // Nothing ever answers /version: the pre-start probe fails (so the
    // supervisor decides to spawn) and no respawn ever reports healthy.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('nothing on port'); }));
    process.env.PHYTOGRAPH_BACKEND_PORT = '52998';
    ({ startBackend, setBackendFailedHandler } = await import('./backend.js'));
    setBackendFailedHandler(onFailed);
  });

  afterEach(() => {
    delete process.env.PHYTOGRAPH_BACKEND_PORT;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('startBackend resolves (never rejects) and gives up into onBackendFailed', async () => {
    await expect(startBackend()).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled(); // budget not yet exhausted

    // Each retry (backoffs 500/2000/5000ms) throws the same way; after
    // MAX_RESTART_ATTEMPTS the supervisor must give up and pop the dialog.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spawnMock).toHaveBeenCalledTimes(1 + 3);
    expect(onFailed).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// A SLOW respawn is still a successful one
// ---------------------------------------------------------------------------
//
// `useBackendReady` documents the envelope: "Cold-start of the bundled
// PyInstaller backend is 10-40s (open3d + pyhelios + uvicorn init)", and the
// splash waits 120s on it. confirmHealthy used to poll 5 times at 500ms and give
// up after ~12.5s — inside that range. Both the 'ready' status AND the restart
// budget reset lived behind `if (v)`, so a respawn that merely took longer than
// the poll got neither: the renderer kept a duration:0 "restarting…" error toast
// against a backend that was serving fine, and three such recoveries exhausted
// MAX_RESTART_ATTEMPTS so the fourth crash showed a permanent-failure dialog.
// The machine most likely to be slow here is the one under the memory pressure
// that killed the backend to begin with.

describe('a respawn slower than the health poll', () => {
  let startBackend: typeof import('./backend.js').startBackend;
  let setBackendFailedHandler: typeof import('./backend.js').setBackendFailedHandler;
  const onFailed = vi.fn();
  let children: ReturnType<typeof makeFakeChild>[] = [];

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    spawnMock.mockReset();
    onFailed.mockReset();
    children = [];
    spawnMock.mockImplementation(() => {
      const c = makeFakeChild(2000 + children.length);
      children.push(c);
      return c;
    });
    // /version NEVER answers: the worst case of a cold start that outruns the
    // poll budget. The child stays alive throughout.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('not up yet'); }));
    process.env.PHYTOGRAPH_BACKEND_PORT = '52998';
    process.env.PHYTOGRAPH_E2E = '';
    ({ startBackend, setBackendFailedHandler } = await import('./backend.js'));
    setBackendFailedHandler(onFailed);
  });

  afterEach(() => {
    delete process.env.PHYTOGRAPH_BACKEND_PORT;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('still resets the restart budget by surviving the stable window', async () => {
    await startBackend();
    expect(children.length).toBe(1);

    // Three crashes, each respawn alive but never answering /version. Under the
    // old code none of these reset the budget, so the next crash gave up.
    for (let i = 0; i < 3; i++) {
      children[children.length - 1].emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(8000);    // backoff → respawn
      await vi.advanceTimersByTimeAsync(46_000);  // survive the 45s window → reset
    }

    expect(onFailed).not.toHaveBeenCalled();

    // And the budget really is full: one more crash still respawns.
    const before = children.length;
    children[children.length - 1].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(8000);
    expect(children.length).toBe(before + 1);
    expect(onFailed).not.toHaveBeenCalled();
  });

  it('does not reset the budget for a respawn that dies inside the window', async () => {
    // The anti-churn guarantee the reset must not weaken: arming the timer on
    // the spawn is only safe because the exit handler clears it.
    await startBackend();
    for (let i = 0; i < 5 && onFailed.mock.calls.length === 0; i++) {
      children[children.length - 1].emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(8000);    // never reach 45s
    }
    expect(onFailed).toHaveBeenCalled();
    expect(children.length).toBeLessThanOrEqual(1 + 3);
  });
});
