// Allowlist of filesystem paths the renderer is permitted to read/write through
// the fs IPC bridge. The bridge's contract is "user-selected paths only" — but
// the handlers used to take any raw path, so a renderer compromise (XSS, a bad
// dependency) could read ~/.ssh/id_rsa or overwrite arbitrary files. This module
// records every path the user actually chose — via a file/save dialog or a
// drag-drop / <input type=file> (resolved by webUtils.getPathForFile) — and the
// fs handlers reject anything not in the set.
//
// We store the normalized absolute path. For reads we additionally resolve
// symlinks (realpath) so an allowed symlink and its target both match; saves
// target a not-yet-existing path, so those are stored normalized-only.

import { realpathSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { IMPORTABLE_EXTENSIONS } from '../shared/constants.js';

// Exact paths the user selected (dialog results, drag-drop, file inputs).
const allowed = new Set<string>();
// Directories into which the user authorized writes (save-dialog parent /
// chosen export folder). Writes are permitted to direct children of these.
const allowedWriteDirs = new Set<string>();
// Directories whose direct children may be READ. Seeded with the parent dir of
// every user-selected file: selecting `scene.xml` implicitly authorizes the app
// to find its companion data (`scene.xyz`) sitting next to it — the Helios
// scan-import resolver probes siblings this way. Direct children only (no
// recursion), so this can't be used to walk a whole subtree.
const allowedReadDirs = new Set<string>();
// Directories whose direct children may be read ONLY if they are importable,
// non-hidden files (see importableReadOnly). Seeded by the in-app file
// browser's grants, which come from the renderer and so must not open a
// whole folder the way a native-dialog pick does.
const allowedImportDirs = new Set<string>();
// Files the in-app browser granted. Read-only: kept apart from `allowed`,
// which isWriteAllowed also honors.
const allowedImportFiles = new Set<string>();

const IMPORTABLE = new Set<string>(IMPORTABLE_EXTENSIONS);

/**
 * May a path the RENDERER chose (in-app browser) be read? Only an importable
 * format, and nothing under a hidden (dot) component — that is where
 * credentials live (~/.ssh, ~/.aws, ~/.config/gcloud/*.json), and several of
 * them carry extensions we import (.json, .txt, .csv).
 */
/** isImportablePath for the path AND what it resolves to (symlinks). */
export function isImportableTarget(p: string): boolean {
  return isImportablePath(p) && isImportablePath(realOrNorm(p));
}

export function isImportablePath(p: string): boolean {
  const n = norm(p);
  if (!IMPORTABLE.has(extname(n).slice(1).toLowerCase())) return false;
  return !n.split(sep).some((part) => part.startsWith('.') && part !== '.' && part !== '..');
}

function norm(p: string): string {
  return resolve(p);
}

// realpath if the file exists; otherwise fall back to the normalized path
// (a save target that doesn't exist yet).
function realOrNorm(p: string): string {
  try {
    return realpathSync(norm(p));
  } catch {
    return norm(p);
  }
}

/**
 * Record a path the user explicitly selected (dialog result, drag-drop, etc.).
 * `kind` distinguishes a directory the user chose (its children become
 * writable) from a file. A save-dialog FILE result also authorizes writes to
 * its parent directory, because the exporters write sibling files named by the
 * backend into the same folder.
 */
export function allowPath(
  p: string | null | undefined,
  kind: 'file' | 'saveFile' | 'directory' | 'importFile' = 'file',
): void {
  if (!p) return;
  const n = norm(p);
  if (kind === 'importFile') {
    // The in-app browser's grant: the renderer named this path, so it gets
    // only what an import needs — the file, and its importable siblings (a
    // Helios XML locates its scan files next to it) — never the folder.
    const real = realOrNorm(p);
    if (!isImportablePath(n) || !isImportablePath(real)) return;
    allowedImportFiles.add(n);
    if (real !== n) allowedImportFiles.add(real);
    allowedImportDirs.add(dirname(n));
    return;
  }
  allowed.add(n);
  const real = realOrNorm(p);
  if (real !== n) allowed.add(real);

  if (kind === 'directory') {
    allowedWriteDirs.add(n);
    allowedReadDirs.add(n);
  } else if (kind === 'saveFile') {
    allowedWriteDirs.add(dirname(n));
  } else {
    // A selected file authorizes reading its direct siblings (companion data).
    allowedReadDirs.add(dirname(n));
  }
}

/**
 * True if `p` may be READ: explicitly allowlisted, or a direct child of a
 * directory containing a user-selected file (companion-file allowance) or a
 * user-chosen directory. Direct-child only — no recursive descent.
 */
export function isPathAllowed(p: string): boolean {
  if (isSelectedPath(p)) return true;
  const n = norm(p);
  const real = realOrNorm(p);
  // Browser grants hold for what is actually READ: a symlink named scan.json
  // that resolves to ~/.ssh/id_rsa must not pass on the strength of its name.
  if (!isImportablePath(n) || !isImportablePath(real)) return false;
  if (allowedImportFiles.has(n) || allowedImportFiles.has(real)) return true;
  return allowedImportDirs.has(dirname(n));
}

// The native-dialog / drag-drop allowance (readable AND writable). Browser
// grants are deliberately not part of it.
function isSelectedPath(p: string): boolean {
  const n = norm(p);
  if (allowed.has(n)) return true;
  // A read may arrive for a symlink whose normalized form wasn't stored but
  // whose target was (or vice-versa); check the resolved form too.
  if (allowed.has(realOrNorm(p))) return true;
  return allowedReadDirs.has(dirname(n));
}

/**
 * True if `p` may be WRITTEN: either explicitly allowlisted, or a direct child
 * of a directory the user authorized for writes (save-dialog parent / chosen
 * export folder). Direct-child only — no recursive descent — so an authorized
 * folder can't be used to write into arbitrary nested paths.
 */
export function isWriteAllowed(p: string): boolean {
  if (isSelectedPath(p)) return true;
  return allowedWriteDirs.has(dirname(norm(p)));
}

/** Test-only: clear the allowlist between cases. */
export function _resetAllowlist(): void {
  allowed.clear();
  allowedWriteDirs.clear();
  allowedReadDirs.clear();
  allowedImportDirs.clear();
  allowedImportFiles.clear();
}

// E2E seam: Playwright helpers stub `dialog:open`/`dialog:save` (replacing the
// real handlers that call allowPath), so they need a way to mark the fixture
// paths they return as user-selected. The `app.evaluate` body runs in the main
// process but can't import TS modules, so we expose allowPath on globalThis for
// it to call. Harmless in production (nothing references it there).
(globalThis as unknown as { __phytographAllowPath?: typeof allowPath }).__phytographAllowPath = allowPath;
