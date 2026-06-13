// Custom Electron protocol that serves Potree 2.0 octree files (metadata.json,
// hierarchy.bin, octree.bin) from the disk cache.
//
// The renderer issues `fetch('app://octree/<sha1>/<filename>')` via
// potree-core's RequestManager. This module translates that into a file read
// under the user-data dir's `cache/octrees/<sha1>/` and returns a Response
// containing the bytes.
//
// Path safety: only sha1 hex cache ids are accepted, and only specific
// filenames (the three files PotreeConverter produces). Anything else gets
// a 400 or 404 — no path traversal possible.

import { app, protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join, basename } from 'node:path';

const SCHEME = 'app';

// Files PotreeConverter writes that the renderer needs to fetch. We allowlist
// these instead of blanket-serving the cache dir, so a misbehaving renderer
// can't read arbitrary files.
const ALLOWED_FILES = new Set<string>(['metadata.json', 'hierarchy.bin', 'octree.bin']);

const SHA1_RE = /^[0-9a-f]{40}$/;

function isSha1(s: string): boolean {
  return SHA1_RE.test(s);
}

function contentTypeFor(name: string): string {
  if (name === 'metadata.json') return 'application/json';
  return 'application/octet-stream';
}

/**
 * The on-disk cache root the backend writes octrees to. Mirrors the Python
 * helper `_octree_cache_root()` in backend-api/main.py for macOS / Windows /
 * Linux. Honors PHYTOGRAPH_OCTREE_CACHE_ROOT so dev/test overrides line up.
 */
function octreeCacheRoot(): string {
  const env = process.env.PHYTOGRAPH_OCTREE_CACHE_ROOT;
  if (env) return env;
  return join(app.getPath('userData'), 'cache', 'octrees');
}

/**
 * Must be called at top-level of main.ts BEFORE app.whenReady(). Standard
 * fetch() against `app://octree/...` won't work otherwise — Electron treats
 * unprivileged custom protocols differently (no fetch, CORS errors, etc.).
 *
 * `standard: true` lets URLs follow the regular origin model.
 * `secure: true` lets the renderer's mixed-content rules treat it as https.
 * `supportFetchAPI: true` enables the fetch() global.
 * `stream: true` allows large file streaming (octree.bin is hundreds of MB).
 * `bypassCSP: true` lets potree-core's Worker scripts execute when the page
 * has a strict CSP without app: in script-src.
 */
export function registerOctreeSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
      },
    },
  ]);
}

/**
 * Wire the handler. Must be called after app.whenReady() and before any
 * window navigates to a URL that references app://.
 *
 * URL shape: app://octree/<sha1>/<filename>
 *   - <sha1>: 40-char hex, matches a cache dir name
 *   - <filename>: one of metadata.json / hierarchy.bin / octree.bin
 *
 * Anything else returns 400 (bad shape) or 404 (no such file). Range
 * requests are passed through to the underlying file read — potree-core
 * uses Range headers when streaming octree.bin chunks.
 */
export function registerOctreeProtocol(): void {
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'octree') {
      return new Response(`unknown app:// host: ${url.host}`, { status: 400 });
    }

    // URL.pathname starts with '/'. Split into [<sha1>, <file>].
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) {
      return new Response('expected app://octree/<sha1>/<filename>', { status: 400 });
    }
    const [cacheId, fileNameRaw] = parts;
    if (!isSha1(cacheId)) {
      return new Response('cache id must be 40-char sha1 hex', { status: 400 });
    }
    const fileName = basename(fileNameRaw);
    if (!ALLOWED_FILES.has(fileName)) {
      return new Response(`disallowed file: ${fileName}`, { status: 400 });
    }

    const absPath = join(octreeCacheRoot(), cacheId, fileName);
    let total: number;
    try {
      total = (await stat(absPath)).size;
    } catch {
      return new Response(`no such file: ${cacheId}/${fileName}`, { status: 404 });
    }
    const rangeHeader = req.headers.get('range');

    // metadata.json gets a rewrite of non-standard `inf`/`-inf`/`nan` to
    // `null` so the renderer's JSON.parse accepts it. Do NOT dedupe the
    // attribute list here even though it contains two `position` entries
    // — that's Potree 2.0's two-uint32 morton-encoded position format
    // (16 bytes total across both entries, de-interleaved in the decoder).
    // Removing the duplicate makes potree-core read positions from the
    // wrong offsets and every point collapses near its node's corner.
    // The backend's `_read_octree_metadata` still dedupes for the
    // convert_to_octree JSON response — that path is rendered-as-JSON
    // for the UI, not consumed by potree-core, so the dedupe is fine
    // there. Range requests on metadata.json are not expected, so this
    // whole-file path is fine.
    if (fileName === 'metadata.json') {
      const text = (await readFile(absPath, 'utf8'))
        .replace(/(?<![\w.])-?inf(?![\w.])/g, 'null')
        .replace(/(?<![\w.])nan(?![\w.])/g, 'null');
      const body = new TextEncoder().encode(text);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': contentTypeFor(fileName),
          'Content-Length': String(body.length),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }

    // For octree.bin / hierarchy.bin: potree-core fetches per-node byte
    // ranges via the standard `Range: bytes=N-M` header. Without HTTP 206
    // Partial Content support the response body comes back empty and the
    // decoder writes zeros into the geometry buffer (visible as all points
    // collapsed onto each node's corner).
    let start = 0;
    let end = total - 1;
    let isPartial = false;
    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (match) {
        start = parseInt(match[1], 10);
        end = match[2] ? parseInt(match[2], 10) : total - 1;
        if (start > end || start >= total) {
          return new Response('', {
            status: 416,
            headers: { 'Content-Range': `bytes */${total}` },
          });
        }
        if (end >= total) end = total - 1;
        isPartial = true;
      }
    }

    const length = end - start + 1;
    // Stream the byte range straight off disk instead of buffering the whole
    // range into RAM with a synchronous read. octree.bin is hundreds of MB; the
    // old openSync/readSync into Buffer.allocUnsafe(length) both spiked
    // main-process memory and BLOCKED the event loop (freezing all IPC/windows)
    // for the duration of the read. createReadStream → web ReadableStream lets
    // Electron pull bytes incrementally. `end` is inclusive for both
    // createReadStream and the HTTP Range spec, so it passes through directly.
    const nodeStream = createReadStream(absPath, { start, end });
    const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

    const headers: Record<string, string> = {
      'Content-Type': contentTypeFor(fileName),
      'Content-Length': String(length),
      'Accept-Ranges': 'bytes',
      // Octree contents are immutable for a given cache id (the id is a
      // hash of source + mtime + format). Aggressive caching is safe.
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
    if (isPartial) {
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }
    return new Response(body, {
      status: isPartial ? 206 : 200,
      headers,
    });
  });
}
