// The crash-recovery dialog runs in the session AFTER the crash, and logs are
// per session (main-<tag>.log). It used to reveal and name the NEW session's
// log, which holds nothing about the crash; the marker now records which log
// belongs to the session that left it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userData = mkdtempSync(join(tmpdir(), 'pm-userdata-'));
vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '0.0.0' },
  crashReporter: { start: vi.fn() },
  dialog: {}, shell: {}, BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('./logger.js', () => ({
  getLogDir: () => '', getLogFilePath: () => '/logs/main-this-session.log',
  log: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { previousSessionLog, markSessionStarted } = await import('./postMortem');

it('the marker names this session log, for the next launch to find', async () => {
  const { readFileSync } = await import('node:fs');
  markSessionStarted();
  const marker = JSON.parse(readFileSync(join(userData, 'clean-shutdown.marker'), 'utf-8'));
  expect(marker.log).toBe('/logs/main-this-session.log');
  expect(typeof marker.started).toBe('string');
});

let dir: string;
const touch = (name: string, mtimeSec: number) => {
  const p = join(dir, name);
  writeFileSync(p, 'log');
  utimesSync(p, mtimeSec, mtimeSec);
  return p;
};

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pm-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('previousSessionLog', () => {
  it('returns the log the crashed session recorded in its marker', () => {
    const crashed = touch('main-2026-01-01-pid1.log', 1000);
    const current = touch('main-2026-01-02-pid2.log', 3000);
    const marker = JSON.stringify({ started: '2026-01-01', log: crashed });
    expect(previousSessionLog(marker, current, dir)).toBe(crashed);
  });

  it('falls back to the newest OTHER session log for an old-format marker', () => {
    touch('main-a-pid1.log', 1000);
    const newestOther = touch('main-b-pid2.log', 2000);
    touch('main-b-pid2.old.log', 2500);          // a rotated archive, not a session
    const current = touch('main-c-pid3.log', 3000);
    expect(previousSessionLog('2026-01-01T00:00:00.000Z', current, dir)).toBe(newestOther);
  });

  it('falls back when the recorded log no longer exists', () => {
    const other = touch('main-a-pid1.log', 1000);
    const current = touch('main-b-pid2.log', 3000);
    const marker = JSON.stringify({ log: join(dir, 'main-deleted.log') });
    expect(previousSessionLog(marker, current, dir)).toBe(other);
  });

  it('is null when there is no other session log', () => {
    const current = touch('main-only-pid1.log', 1000);
    expect(previousSessionLog('garbage', current, dir)).toBeNull();
  });
});
