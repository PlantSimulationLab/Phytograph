import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// logger.ts imports electron-log/main.js, electron, and node:fs. Mock all three
// so initLogging() runs headless and we can inspect the per-session filename it
// resolves and which old files the retention sweep unlinks.

// A stand-in electron-log whose file transport captures resolvePathFn.
const fileTransport: Record<string, unknown> = {
  level: 'info',
  maxSize: 0,
  format: '',
  resolvePathFn: undefined as unknown,
  getFile: () => ({ path: '/logs/main-current.log' }),
};
const electronLogMock = {
  transports: {
    file: fileTransport,
    console: { level: 'info', writeFn: (_: unknown) => undefined },
  },
  initialize: vi.fn(),
  functions: {},
  errorHandler: { startCatching: vi.fn() },
  scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
};
vi.mock('electron-log/main.js', () => ({ default: electronLogMock }));
vi.mock('electron', () => ({ app: { isPackaged: false } }));

// Controllable fs for the retention sweep.
let dirEntries: string[] = [];
const mtimes: Record<string, number> = {};
const unlinked: string[] = [];
vi.mock('node:fs', () => {
  const mod = {
    existsSync: () => true,
    readdirSync: () => dirEntries,
    statSync: (p: string) => ({ mtimeMs: mtimes[p] ?? 0 }),
    unlinkSync: (p: string) => { unlinked.push(String(p)); },
  };
  return { ...mod, default: mod };
});
vi.mock('node:fs/promises', () => {
  const mod = { mkdir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() };
  return { ...mod, default: mod };
});

describe('per-session log naming', () => {
  beforeEach(() => { vi.resetModules(); delete process.env.PHYTOGRAPH_E2E; });
  afterEach(() => { fileTransport.resolvePathFn = undefined; });

  it('resolvePathFn yields a per-session main-<tag>.log with a pid', async () => {
    const { initLogging, getLogSessionTag } = await import('./logger.js');
    dirEntries = [];
    initLogging();
    const tag = getLogSessionTag();
    expect(tag).toMatch(/pid\d+$/);
    const resolve = fileTransport.resolvePathFn as (v: { libraryDefaultDir: string }) => string;
    const path = resolve({ libraryDefaultDir: '/logs' });
    expect(path).toBe(`/logs/main-${tag}.log`);
  });
});

describe('retention sweep (keep last 10 sessions)', () => {
  beforeEach(() => {
    vi.resetModules();
    dirEntries = [];
    unlinked.length = 0;
    for (const k of Object.keys(mtimes)) delete mtimes[k];
    delete process.env.PHYTOGRAPH_E2E;
  });

  it('deletes all but the 10 newest session groups and never the current one', async () => {
    // Seed 12 past sessions (main + backend files each) with ascending mtimes,
    // so sessions 0 and 1 are the two oldest and must be pruned.
    for (let i = 0; i < 12; i++) {
      const main = `main-sess${i}.log`;
      const back = `phytograph-backend-sess${i}.log`;
      dirEntries.push(main, back);
      mtimes[`/logs/${main}`] = 1000 + i;
      mtimes[`/logs/${back}`] = 1000 + i;
    }
    const { initLogging, getLogSessionTag } = await import('./logger.js');
    initLogging();
    // The current session's own files (if they happened to match) are never touched.
    const currentTag = getLogSessionTag();

    // 12 seeded − 10 kept = 2 oldest sessions pruned → 4 files (main+backend each).
    expect(unlinked.sort()).toEqual([
      '/logs/main-sess0.log',
      '/logs/main-sess1.log',
      '/logs/phytograph-backend-sess0.log',
      '/logs/phytograph-backend-sess1.log',
    ]);
    // The newest 10 sessions survive.
    expect(unlinked).not.toContain('/logs/main-sess11.log');
    expect(unlinked.some((f) => f.includes(currentTag))).toBe(false);
  });

  it('is skipped entirely under E2E (never unlinks a concurrent worker’s file)', async () => {
    process.env.PHYTOGRAPH_E2E = '1';
    for (let i = 0; i < 12; i++) {
      dirEntries.push(`main-sess${i}.log`);
      mtimes[`/logs/main-sess${i}.log`] = 1000 + i;
    }
    const { initLogging } = await import('./logger.js');
    initLogging();
    expect(unlinked).toEqual([]);
  });
});
