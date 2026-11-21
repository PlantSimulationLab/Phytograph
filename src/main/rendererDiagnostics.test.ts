import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installRendererDiagnostics, logGpuBaseline, resetRendererDiagnosticsForTest, stallSnapshot } from './rendererDiagnostics';

function setup(logCrashes: boolean) {
  const webContents = new EventEmitter();
  const app = new EventEmitter();
  const lines: Array<[string, string]> = [];
  const log = {
    // The page-load GPU baseline has its own tests below; leave it out here.
    info: (m: string) => { if (!m.startsWith('[window] gpu at page load')) lines.push(['info', m]); },
    warn: (m: string) => lines.push(['warn', m]),
    error: (m: string) => lines.push(['error', m]),
  };
  installRendererDiagnostics(webContents, app, log, { logCrashes });
  return { webContents, app, lines };
}

describe('installRendererDiagnostics', () => {
  beforeEach(() => resetRendererDiagnosticsForTest());

  it('marks a page that loaded, so a log without the line means it never did', () => {
    const { webContents, lines } = setup(true);
    webContents.emit('did-finish-load');
    expect(lines).toEqual([['info', '[window] renderer page loaded']]);
  });

  it('logs a main-frame load failure and ignores a sub-resource one', () => {
    const { webContents, lines } = setup(true);
    webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x/index.html', true);
    webContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'file:///x/img.png', false);
    expect(lines).toEqual([['error', '[window] renderer page failed to load: ERR_FILE_NOT_FOUND (-6) file:///x/index.html']]);
  });

  it('logs a preload that threw, an unresponsive renderer and its recovery', () => {
    const { webContents, lines } = setup(true);
    webContents.emit('preload-error', {}, '/p/preload.js', new Error('boom'));
    webContents.emit('unresponsive');
    webContents.emit('responsive');
    expect(lines[0][0]).toBe('error');
    expect(lines[0][1]).toContain('preload script threw (/p/preload.js): Error: boom');
    expect(lines.slice(1)).toEqual([
      ['warn', '[window] renderer is unresponsive'],
      ['info', '[window] renderer is responsive again'],
    ]);
  });

  it('logs uncaught exceptions only, since console.error is already forwarded', () => {
    const { webContents, lines } = setup(true);
    webContents.emit('console-message', {}, 3, 'Uncaught TypeError: x is undefined', 12, 'file:///a.js');
    webContents.emit('console-message', {}, 3, 'a console.error call', 1, 'file:///a.js');
    webContents.emit('console-message', {}, 2, 'Uncaught-looking warning', 1, 'file:///a.js');
    expect(lines).toEqual([['error', '[window] Uncaught TypeError: x is undefined (file:///a.js:12)']]);
  });

  it('logs a renderer or child process death only when asked, never a clean exit', () => {
    const on = setup(true);
    on.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 });
    on.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    on.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
    expect(on.lines).toEqual([
      ['error', '[window] renderer process gone: reason=crashed exitCode=139'],
      ['warn', '[window] child process gone: type=GPU reason=crashed exitCode=1'],
    ]);

    resetRendererDiagnosticsForTest();
    const off = setup(false);
    off.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 });
    off.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
    expect(off.lines).toEqual([]);
  });

  it('installs the app-wide listener once however many windows are created', () => {
    const app = new EventEmitter();
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    installRendererDiagnostics(new EventEmitter(), app, log, { logCrashes: true });
    installRendererDiagnostics(new EventEmitter(), app, log, { logCrashes: true });
    expect(app.listenerCount('child-process-gone')).toBe(1);
  });

  it('marks navigation start and DOM ready, the two stages before a page load', () => {
    const { webContents, lines } = setup(true);
    webContents.emit('did-start-loading');
    webContents.emit('dom-ready');
    webContents.emit('did-finish-load');
    expect(lines).toEqual([
      ['info', '[window] renderer navigation started'],
      ['info', '[window] renderer DOM ready'],
      ['info', '[window] renderer page loaded'],
    ]);
  });
});

describe('the stall watchdog', () => {
  beforeEach(() => {
    resetRendererDiagnosticsForTest();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  function stalled() {
    const webContents = Object.assign(new EventEmitter(), {
      isLoading: () => true,
      isLoadingMainFrame: () => true,
      isWaitingForResponse: () => false,
      isCrashed: () => false,
      getOSProcessId: () => 4242,
      getURL: () => 'file:///app/dist-renderer/index.html',
    });
    const app = Object.assign(new EventEmitter(), {
      getAppMetrics: () => [
        { type: 'Browser', pid: 100, cpu: { percentCPUUsage: 1.25, idleWakeupsPerSecond: 3 }, memory: { workingSetSize: 204800 } },
        { type: 'Tab', pid: 4242, cpu: { percentCPUUsage: 99.5, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 51200 } },
        { type: 'GPU', pid: 101 },
      ],
      getGPUFeatureStatus: () => ({ webgl: 'enabled', gpu_compositing: 'disabled_software' }),
    });
    const lines: Array<[string, string]> = [];
    const log = {
      info: (m: string) => lines.push(['info', m]),
      warn: (m: string) => lines.push(['warn', m]),
      error: (m: string) => lines.push(['error', m]),
    };
    installRendererDiagnostics(webContents, app, log, { logCrashes: true, stallCheckMs: [15_000, 60_000] });
    return { webContents, app, warns: () => lines.filter(([lvl]) => lvl === 'warn').map(([, m]) => m) };
  }

  it('snapshots a load that never finishes at 15 s and again at 60 s', () => {
    const { webContents, warns } = stalled();
    webContents.emit('did-start-loading');
    vi.advanceTimersByTime(14_999);
    expect(warns()).toEqual([]);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(45_000);
    const w = warns();
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/^\[window\] renderer page not loaded after 15s: /);
    expect(w[1]).toMatch(/^\[window\] renderer page not loaded after 60s: /);
    expect(w[0]).toContain('"loading":true');
    expect(w[0]).toContain('"rendererPid":4242');
    expect(w[0]).toContain('Tab:4242 cpu=99.5% wakeups=0/s mem=50MB');
    expect(w[0]).toContain('Browser:100 cpu=1.3% wakeups=3/s mem=200MB');
    expect(w[0]).toContain('GPU:101 cpu=?% wakeups=?/s mem=?MB');
    expect(w[0]).toContain('"gpu_compositing":"disabled_software"');
  });

  it('stands down once the page loads or the main frame fails', () => {
    for (const end of ['did-finish-load', 'did-fail-load'] as const) {
      resetRendererDiagnosticsForTest();
      const { webContents, warns } = stalled();
      webContents.emit('did-start-loading');
      vi.advanceTimersByTime(5_000);
      if (end === 'did-fail-load') webContents.emit(end, {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///x', true);
      else webContents.emit(end);
      vi.advanceTimersByTime(120_000);
      expect(warns(), end).toEqual([]);
    }
  });

  it('primes the CPU baseline when it arms, so the first snapshot measures real CPU', () => {
    const { webContents, app } = stalled();
    let calls = 0;
    const real = app.getAppMetrics;
    app.getAppMetrics = () => { calls += 1; return real(); };
    webContents.emit('did-start-loading');
    expect(calls).toBe(1);
    vi.advanceTimersByTime(15_000);
    expect(calls).toBe(2);
  });

  it('snapshots a window closed while its load is still pending, once', () => {
    for (const exit of ['before-quit', 'destroyed'] as const) {
      resetRendererDiagnosticsForTest();
      const { webContents, app, warns } = stalled();
      webContents.emit('did-start-loading');
      vi.advanceTimersByTime(8_000);
      if (exit === 'before-quit') app.emit('before-quit');
      else webContents.emit('destroyed');
      webContents.emit('destroyed');            // the second exit path adds nothing
      vi.advanceTimersByTime(120_000);           // and the 15 s / 60 s checks never fire
      expect(warns(), exit).toHaveLength(1);
      expect(warns()[0], exit).toMatch(/^\[window\] renderer closing before its page loaded \(after 8s\): state=/);
    }
  });

  it('says nothing on the way out once the page has loaded', () => {
    const { webContents, app, warns } = stalled();
    webContents.emit('did-start-loading');
    webContents.emit('did-finish-load');
    app.emit('before-quit');
    webContents.emit('destroyed');
    expect(warns()).toEqual([]);
  });

  it('a reload re-arms it from the new start, without the old timers firing', () => {
    const { webContents, warns } = stalled();
    webContents.emit('did-start-loading');
    vi.advanceTimersByTime(10_000);
    webContents.emit('did-start-loading');
    vi.advanceTimersByTime(14_999);
    expect(warns()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(warns()).toHaveLength(1);
    expect(warns()[0]).toContain('after 15s');
  });

  it('a snapshot never throws, whatever a probe does', () => {
    const webContents = Object.assign(new EventEmitter(), {
      isLoading: () => { throw new Error('destroyed'); },
    });
    const app = Object.assign(new EventEmitter(), {
      getAppMetrics: () => { throw new Error('no metrics'); },
    });
    const text = stallSnapshot(webContents, app);
    expect(text).toContain('"loading":"error: destroyed"');
    expect(text).toContain('processes=[error: no metrics]');
  });
});

describe('the GPU baseline at page load', () => {
  function capture() {
    const lines: string[] = [];
    return { lines, log: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } };
  }

  it('logs the feature status and the GL implementation once per window', async () => {
    resetRendererDiagnosticsForTest();
    const { lines, log } = capture();
    const webContents = new EventEmitter();
    const app = Object.assign(new EventEmitter(), {
      getGPUFeatureStatus: () => ({ webgl: 'enabled_on' }),
      getGPUInfo: async () => ({
        auxAttributes: { glRenderer: 'ANGLE (llvmpipe)', glVendor: 'Mesa', glVersion: '4.5', other: 'x' },
        gpuDevice: [{ vendorId: 0, deviceId: 0, active: true }],
      }),
    });
    installRendererDiagnostics(webContents, app, log, { logCrashes: true });
    webContents.emit('did-finish-load');
    webContents.emit('did-finish-load');   // a reload: no second baseline
    await new Promise((r) => setTimeout(r, 0));
    const baseline = lines.filter((l) => l.startsWith('[window] gpu at page load'));
    expect(baseline).toHaveLength(1);
    expect(baseline[0]).toContain('features={"webgl":"enabled_on"}');
    expect(baseline[0]).toContain('"glRenderer":"ANGLE (llvmpipe)"');
    expect(baseline[0]).not.toContain('other');
  });

  it('never waits on a GPU process that does not answer, and never throws', async () => {
    vi.useFakeTimers();
    try {
      const { lines, log } = capture();
      const app = Object.assign(new EventEmitter(), {
        getGPUFeatureStatus: () => { throw new Error('gone'); },
        getGPUInfo: () => new Promise<unknown>(() => {}),
      });
      const done = logGpuBaseline(app, log);
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(lines[0]).toBe('[window] gpu at page load: features=error: gone info=error: no answer in 5000 ms');
    } finally {
      vi.useRealTimers();
    }
  });
});

