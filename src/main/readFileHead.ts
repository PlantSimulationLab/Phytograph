// The first bytes of a file, for a renderer that only needs to sniff a header.
//
// File → Import reads every chosen path BY PATH in the backend; the renderer
// looks at the file only to tell a mesh PLY from a cloud PLY or a QSM CSV from
// a point CSV, which reads the first 64 KB. Handing it the whole file for that
// cost a full copy per selected file in main and again in the renderer, and
// Node's readFile refuses anything over 2 GiB, so a large scan failed to import
// before the import even started. Electron-free so it is unit-testable.
import { open } from 'node:fs/promises';

/** Upper bound on a head read, so a caller cannot use it as an unbounded read. */
export const MAX_HEAD_BYTES = 16 * 1024 * 1024;

/** Up to `maxBytes` from the start of `path` (fewer for a shorter file). */
export async function readFileHead(path: string, maxBytes: number): Promise<ArrayBuffer> {
  const n = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.min(Math.floor(maxBytes), MAX_HEAD_BYTES)
    : 0;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    // Buffer.alloc never hands out a slice of the shared pool, so offset is 0.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) as ArrayBuffer;
  } finally {
    await fh.close();
  }
}
