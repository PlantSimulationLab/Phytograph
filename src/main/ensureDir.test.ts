import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDir } from './ensureDir';

// Windows' recursive mkdir on a drive root: the directory exists, and mkdir
// throws anyway (issue #7: `EPERM: operation not permitted, mkdir 'D:\'`).
const windowsDriveRootMkdir = async (dir: string) => {
  throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${dir}'`), { code: 'EPERM' });
};

describe('ensureDir', () => {
  it('accepts an existing directory that mkdir refuses (a Windows drive root)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ensuredir-'));
    try {
      await expect(ensureDir(dir, windowsDriveRootMkdir)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts it even when the first existence check misses', async () => {
    // stat fails once (a transient lock), mkdir then throws EPERM, and the
    // directory turns out to exist: still not an error.
    const dir = await mkdtemp(join(tmpdir(), 'ensuredir-'));
    let calls = 0;
    const flakyStat = async (p: string) => {
      calls += 1;
      if (calls === 1) throw new Error('EBUSY');
      return stat(p);
    };
    try {
      await expect(ensureDir(dir, windowsDriveRootMkdir, flakyStat)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates a missing directory, parents included', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensuredir-'));
    try {
      const nested = join(root, 'a', 'b');
      await ensureDir(nested);
      expect((await stat(nested)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still reports a real failure', async () => {
    const missing = join(tmpdir(), `ensuredir-missing-${process.pid}-${Date.now()}`);
    await expect(ensureDir(missing, windowsDriveRootMkdir)).rejects.toThrow(/EPERM/);
  });

  it('is what the log export uses for its destination folder', () => {
    // The export was the failing call site; a plain mkdir there would bring
    // the bug back while every test above kept passing.
    const src = readFileSync(join(__dirname, 'logger.ts'), 'utf-8');
    const body = src.slice(src.indexOf('export async function copySessionLogTo'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toMatch(/await ensureDir\(dirname\(destPath\)\)/);
    expect(fn).not.toMatch(/\bmkdir\(/);
  });
});
