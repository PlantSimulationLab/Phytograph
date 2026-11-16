import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HEADER_BYTES, headerOnlyFile, isHeaderOnly, wholeFile } from './headerOnlyFile';

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill).buffer;

describe('headerOnlyFile', () => {
  it('holds only the header and fetches the rest by path, once asked', async () => {
    const readAll = vi.fn(async (path: string) => {
      expect(path).toBe('/scans/plot.ply');
      return bytes(HEADER_BYTES * 3);
    });
    const head = headerOnlyFile(bytes(HEADER_BYTES), 'plot.ply', '/scans/plot.ply');
    expect(head.size).toBe(HEADER_BYTES);
    expect(isHeaderOnly(head)).toBe(true);
    expect(readAll).not.toHaveBeenCalled();

    const whole = await wholeFile(head, readAll);
    expect(whole.size).toBe(HEADER_BYTES * 3);
    expect(whole.name).toBe('plot.ply');
    expect(readAll).toHaveBeenCalledTimes(1);
  });

  it('is already whole when the file is shorter than the header', async () => {
    const readAll = vi.fn(async () => bytes(1));
    const small = headerOnlyFile(bytes(100), 'tiny.obj', '/x/tiny.obj');
    expect(isHeaderOnly(small)).toBe(false);
    expect(await wholeFile(small, readAll)).toBe(small);
    expect(readAll).not.toHaveBeenCalled();
  });

  it('passes every other File through untouched (a drag-drop, a fixture)', async () => {
    const readAll = vi.fn(async () => bytes(1));
    const dropped = new File([bytes(HEADER_BYTES * 2)], 'dropped.las');
    expect(await wholeFile(dropped, readAll)).toBe(dropped);
    expect(readAll).not.toHaveBeenCalled();
  });
});

describe('App reads only headers on File → Import and whole files where it parses', () => {
  it('routes every renderer parse of an imported File through readWholeFile', async () => {
    const src = (await readFile(join(process.cwd(), 'src/renderer/App.tsx'), 'utf8')).replace(/\0/g, '');
    // The browser's picks are header-only...
    expect(src).toMatch(/fs\.readBinary\(p, HEADER_BYTES\)/);
    expect(src).toMatch(/files\.push\(headerOnlyFile\(head, name, p\)\)/);
    // ...so a parser handed one directly would parse 64 KB of a larger file.
    for (const parser of ['parseMesh', 'parseSkeleton', 'parsePointCloud']) {
      const calls = src.match(new RegExp(`\\b${parser}\\(`, 'g')) ?? [];
      const guarded = src.match(new RegExp(`\\b${parser}\\(await readWholeFile\\(file\\)\\)`, 'g')) ?? [];
      expect(calls.length, parser).toBeGreaterThan(0);
      expect(guarded.length, `${parser}: every call must go through readWholeFile`).toBe(calls.length);
    }
    expect(src).not.toMatch(/await file\.arrayBuffer\(\)/);
  });
});
