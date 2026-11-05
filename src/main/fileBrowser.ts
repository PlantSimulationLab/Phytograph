// Backing for the in-app file browser (File -> Import).
//
// The fs bridge reads only paths the user chose (fsAllowlist.ts). With the OS
// dialog, main showed the picker, so "chosen" was main's own observation. An
// in-app browser runs IN the renderer, so whatever it reports as chosen is the
// renderer's say-so — and a compromised renderer can call these IPCs directly,
// with no browser on screen. So the rules here do not try to tell a real click
// from a forged one. They bound what a forged one can get:
//
//  - a grant is refused unless one of main's own listings returned the path
//    as a FILE (no directories, no typed-in paths);
//  - only importable formats (IMPORTABLE_EXTENSIONS) can be granted, and
//    nothing under a hidden (dot) folder, which is where credentials live
//    (~/.ssh/id_rsa has no extension; ~/.config/gcloud/*.json does) — hidden
//    folders cannot even be listed;
//  - a grant is READ-only and opens no folder: siblings become readable only
//    if they too are importable (a Helios XML finds its scans that way).
//
// What remains: a compromised renderer can list file NAMES in non-hidden
// folders and read files in the formats Phytograph imports. The backend can
// already read any path for a renderer holding its token, so this is defense
// in depth, not the only line.
//
// Electron-free on purpose, so it is unit-testable (fileBrowser.test.ts).

import { readdir, stat, access, readlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, extname, join, resolve, sep as pathSep } from 'node:path';
import { allowPath, isImportableTarget } from './fsAllowlist.js';
import type {
  BrowserEntry,
  BrowserGrantResult,
  BrowserPlace,
  BrowserPlaces,
  ListDirResult,
} from '../shared/ipc.js';

// ─── Grant registry ────────────────────────────────────────────────────────

// dir -> the FILES its most recent listing returned. Insertion order is
// recency (a re-listed dir moves to the end), so the oldest is evicted first
// once the cap is reached. Only a direct child of a listed dir can be granted,
// so the lookup is by parent directory.
const MAX_LISTED_DIRS = 256;
const listed = new Map<string, Set<string>>();

function recordListing(dir: string, entries: BrowserEntry[]): void {
  listed.delete(dir);
  listed.set(dir, new Set(entries.filter((e) => e.kind === 'file').map((e) => e.path)));
  while (listed.size > MAX_LISTED_DIRS) {
    const oldest = listed.keys().next().value as string;
    listed.delete(oldest);
  }
}

/** Was `p` returned as a file by a listing in this session? */
export function wasListed(p: string): boolean {
  const n = resolve(p);
  return listed.get(dirname(n))?.has(n) ?? false;
}

/**
 * Make `paths` readable through the fs bridge: only files a listing in this
 * session returned, in an importable format, outside hidden folders.
 * Everything else is refused, not thrown, so the renderer can say which file
 * it could not open.
 */
export function grant(paths: unknown): BrowserGrantResult {
  const granted: string[] = [];
  const refused: string[] = [];
  if (!Array.isArray(paths)) return { granted, refused };
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    if (wasListed(p) && isImportableTarget(p)) {
      allowPath(p, 'importFile');
      granted.push(resolve(p));
    } else {
      refused.push(p);
    }
  }
  return { granted, refused };
}

/** Test-only: forget every listing. */
export function _resetListings(): void {
  listed.clear();
}

// ─── Listing ───────────────────────────────────────────────────────────────

function parentOf(dir: string): string | null {
  const p = dirname(dir);
  return p === dir ? null : p;
}

// A cloud-storage placeholder reports its real size but occupies no blocks:
// the data is on a server until something reads it. Measured on Box Drive,
// where such a file read EMPTY inside a Docker mount; iCloud and Dropbox
// "online-only" files present the same way. `blocks` is undefined on Windows,
// so this never fires there.
export function isPlaceholder(st: Pick<Stats, 'blocks' | 'size'>, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
    && typeof st.blocks === 'number'
    && st.blocks === 0
    && st.size > 0;
}

// Stat in bounded batches: a folder of 10k scans would otherwise queue 10k
// stats at once behind libuv's 4-thread pool, starving every other fs call
// (including the import that follows) until they drain.
async function statAll(paths: string[], batch = 64): Promise<Array<Stats | null>> {
  const out: Array<Stats | null> = new Array(paths.length).fill(null);
  for (let i = 0; i < paths.length; i += batch) {
    const slice = paths.slice(i, i + batch);
    const res = await Promise.all(slice.map((p) => stat(p).catch(() => null)));
    res.forEach((st, j) => { out[i + j] = st; });
  }
  return out;
}

function hasHiddenComponent(p: string): boolean {
  return p.split(pathSep).some((part) => part.startsWith('.') && part !== '.' && part !== '..');
}

export async function listDir(dirIn: unknown): Promise<ListDirResult> {
  const dir = resolve(typeof dirIn === 'string' && dirIn ? dirIn : homedir());
  const base = { dir, parent: parentOf(dir), sep: pathSep };
  // Hidden folders hold credentials, not scans, and nothing in one could be
  // granted anyway; refusing to list them keeps even the names private.
  if (hasHiddenComponent(dir)) {
    return {
      ...base,
      ok: false,
      code: 'EHIDDEN',
      message: 'Hidden folders can\'t be browsed for import. Move the files to a regular folder.',
    };
  }
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      ...base,
      ok: false,
      code: e.code ?? 'EUNKNOWN',
      message: e.code === 'EACCES' || e.code === 'EPERM'
        ? 'Phytograph does not have permission to read this folder.'
        : e.code === 'ENOENT'
          ? 'This folder does not exist.'
          : e.code === 'ENOTDIR'
            ? 'This is a file, not a folder.'
            : (e.message || 'This folder could not be read.'),
    };
  }

  const candidates = names.filter((d) => !d.name.startsWith('.'));
  const paths = candidates.map((d) => join(dir, d.name));
  // stat (not lstat) follows symlinks, so a link to a folder browses as one.
  // A broken link stats to null and is left out: there is nothing to open.
  const stats = await statAll(paths);
  const entries: BrowserEntry[] = [];
  candidates.forEach((d, i) => {
    const st = stats[i];
    if (!st) return;
    const isDir = st.isDirectory();
    if (!isDir && !st.isFile()) return; // sockets, fifos, devices
    entries.push({
      name: d.name,
      path: paths[i],
      kind: isDir ? 'dir' : 'file',
      size: isDir ? 0 : st.size,
      mtimeMs: st.mtimeMs,
      ext: isDir ? '' : extname(d.name).slice(1).toLowerCase(),
      placeholder: !isDir && isPlaceholder(st),
    });
  });
  recordListing(dir, entries);
  return { ...base, ok: true, entries };
}

// ─── Places ────────────────────────────────────────────────────────────────

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// Mount points under /Volumes, /media/<user>, /mnt. Read from the PARENT's
// directory entries only: stat-ing or realpath-ing a mount itself blocks for
// the network timeout when it is a dead SMB/NFS share, and that would hold up
// opening the browser.
async function childMounts(root: string): Promise<Array<{ name: string; path: string }>> {
  try {
    const kids = await readdir(root, { withFileTypes: true });
    const out: Array<{ name: string; path: string }> = [];
    for (const k of kids) {
      if (k.name.startsWith('.')) continue;
      const p = join(root, k.name);
      if (k.isSymbolicLink()) {
        // macOS lists the boot volume as a link to '/', which the 'Computer'
        // entry already covers. readlink reads the link, not the target.
        const target = await readlink(p).catch(() => '');
        if (target === '/' || target === '') continue;
      } else if (!k.isDirectory()) {
        continue;
      }
      out.push({ name: k.name, path: p });
    }
    return out;
  } catch {
    return [];
  }
}

// A drive letter can belong to a disconnected network share, whose access()
// hangs for the SMB timeout (tens of seconds). Each probe gets a short
// deadline. A late probe still occupies a libuv thread until Windows gives
// up, so results are cached: reopening the browser does not re-probe, and
// cannot stack up stalled probes that starve the import's own file reads.
const DRIVE_PROBE_TTL_MS = 60_000;
let driveCache: { at: number; letters: string[] } | null = null;
let driveProbe: Promise<string[]> | null = null;

async function probeDrive(root: string, ms = 400): Promise<boolean> {
  return Promise.race([
    access(root).then(() => true, () => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
}

async function presentDrives(): Promise<string[]> {
  if (driveCache && Date.now() - driveCache.at < DRIVE_PROBE_TTL_MS) return driveCache.letters;
  if (!driveProbe) {
    driveProbe = (async () => {
      const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
      const present = await Promise.all(letters.map((l) => probeDrive(`${l}:\\`)));
      const found = letters.filter((_, i) => present[i]);
      driveCache = { at: Date.now(), letters: found };
      driveProbe = null;
      return found;
    })();
  }
  return driveProbe;
}

export interface PlacesEnv {
  home?: string;
  platform?: NodeJS.Platform;
  user?: string;
}

export async function listPlaces(env: PlacesEnv = {}): Promise<BrowserPlaces> {
  const home = env.home ?? homedir();
  const platform = env.platform ?? process.platform;
  const places: BrowserPlace[] = [{ label: 'Home', path: home, kind: 'home' }];

  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const p = join(home, name);
    if (await isDirectory(p)) places.push({ label: name, path: p, kind: 'folder' });
  }

  if (platform === 'win32') {
    for (const l of await presentDrives()) {
      places.push({ label: `${l}:`, path: `${l}:\\`, kind: 'volume' });
    }
  } else {
    places.push({ label: platform === 'darwin' ? 'Computer' : 'File System', path: '/', kind: 'root' });
    let user = env.user;
    if (!user) {
      try { user = userInfo().username; } catch { user = ''; }
    }
    const roots = platform === 'darwin'
      ? ['/Volumes']
      : [`/media/${user}`, `/run/media/${user}`, '/mnt'];
    for (const root of roots) {
      for (const m of await childMounts(root)) {
        places.push({ label: m.name, path: m.path, kind: 'volume' });
      }
    }
  }
  return { home, sep: platform === 'win32' ? '\\' : '/', places };
}
