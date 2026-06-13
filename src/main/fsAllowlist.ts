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
import { dirname, resolve } from 'node:path';

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
  kind: 'file' | 'saveFile' | 'directory' = 'file',
): void {
  if (!p) return;
  const n = norm(p);
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
  if (isPathAllowed(p)) return true;
  return allowedWriteDirs.has(dirname(norm(p)));
}

/** Test-only: clear the allowlist between cases. */
export function _resetAllowlist(): void {
  allowed.clear();
  allowedWriteDirs.clear();
  allowedReadDirs.clear();
}

// E2E seam: Playwright helpers stub `dialog:open`/`dialog:save` (replacing the
// real handlers that call allowPath), so they need a way to mark the fixture
// paths they return as user-selected. The `app.evaluate` body runs in the main
// process but can't import TS modules, so we expose allowPath on globalThis for
// it to call. Harmless in production (nothing references it there).
(globalThis as unknown as { __phytographAllowPath?: typeof allowPath }).__phytographAllowPath = allowPath;
