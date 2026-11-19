import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';
import { installRendererDiagnostics, resetRendererDiagnosticsForTest } from './rendererDiagnostics';

function setup(logCrashes: boolean) {
  const webContents = new EventEmitter();
  const app = new EventEmitter();
  const lines: Array<[string, string]> = [];
  const log = {
    info: (m: string) => lines.push(['info', m]),
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
});
