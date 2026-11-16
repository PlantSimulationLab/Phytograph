import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_HEAD_BYTES, readFileHead } from './readFileHead';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'phyto-head-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('readFileHead', () => {
  it('returns exactly the first bytes', async () => {
    const p = join(dir, 'a.bin');
    const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
    await writeFile(p, bytes);
    const head = new Uint8Array(await readFileHead(p, 100));
    expect(Array.from(head)).toEqual(Array.from(bytes.subarray(0, 100)));
  });

  it('returns the whole file when it is shorter than the request', async () => {
    const p = join(dir, 'short.bin');
    await writeFile(p, Buffer.from('ply\nformat ascii 1.0\n'));
    expect(new TextDecoder().decode(await readFileHead(p, 65536))).toBe('ply\nformat ascii 1.0\n');
  });

  it('reads the head of a file past the 2 GiB that readFile refuses', async () => {
    // A sparse 3 GB file: free on APFS/ext4, and exactly the size that made
    // File → Import fail with ERR_FS_FILE_TOO_LARGE before this existed.
    const p = join(dir, 'huge.las');
    const fh = await open(p, 'w');
    try {
      await fh.write(Buffer.from('LASF'), 0, 4, 0);
      await fh.truncate(3 * 1024 ** 3);
    } finally {
      await fh.close();
    }
    const head = await readFileHead(p, 65536);
    expect(head.byteLength).toBe(65536);
    expect(new TextDecoder().decode(head.slice(0, 4))).toBe('LASF');
  });

  it('bounds the request, and reads nothing for a nonsense size', async () => {
    const p = join(dir, 'a.bin');
    expect((await readFileHead(p, Number.NaN)).byteLength).toBe(0);
    expect((await readFileHead(p, -5)).byteLength).toBe(0);
    expect(MAX_HEAD_BYTES).toBeLessThan(2 ** 31);
  });
});
