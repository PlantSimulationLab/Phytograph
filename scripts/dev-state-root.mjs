// Single source of truth for the durable per-user directory that DEVELOPER
// tooling keeps its state in: the dev session's Electron profile and octree
// cache (scripts/dev.mjs), and the docs screenshot capture's Electron profile
// (docs/scripts/capture-screenshots.mjs).
//
// Two properties, and the second is the one that keeps getting lost.
//
// 1. OUTSIDE the packaged app's profile. `electron .` derives
//    `app.getPath('userData')` from the app NAME, which is the same name the
//    installed Phytograph.app uses — so without an explicit --user-data-dir,
//    dev runs, screenshot captures and the user's desktop app all resolve to
//    one directory. Sharing it means trampling the user's real preferences
//    (`phytograph-store.json`), tripping the single-instance lock, and sharing
//    `<userData>/Cache`, which Chromium EMPTIES on startup — the delivery
//    mechanism for the octree-cache loss documented in src/main/
//    octreeCacheRoot.ts, and it fires mid-session on a desktop app that
//    happens to be open at the time.
//
// 2. DURABLE. "Stable" has to mean the DIRECTORY survives, not merely that the
//    path string is deterministic. Both of these lived under `tmpdir()`, which
//    satisfies the string reading and fails the real one: temp is reaped
//    (macOS empties /tmp on boot and runs /usr/libexec/tmp_cleaner nightly from
//    a launchd daemon; systemd-tmpfiles does the same on Linux), and a
//    developer who exports TMPDIR=/tmp/$USER forfeits even the per-user
//    /var/folders protection. The dev profile therefore evaporated every day or
//    two and NOTHING ERRORED — the symptoms were preferences silently reverting
//    (the RiVLib path most visibly, being hand-entered) and a "starting for the
//    first time" splash on a months-old checkout, since `isFirstRun` probes for
//    the store file in exactly that directory.
//
// Mirrors the platform conventions in src/main/octreeCacheRoot.ts — the same
// per-OS cache directories, one level up — so dev state sits beside the cache
// the app already uses rather than inventing another location. It is a sibling
// of, never inside, anything Chromium manages.
//
// Shared rather than copied into each caller deliberately: a per-OS path
// computed twice and validated on only one OS is the exact shape that shipped
// the octree-cache divergence (see the "Octree cache root" section of
// CLAUDE.md). One definition, asserted once.

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Durable per-user root for developer-tooling state.
 *
 * @param {string} [subdir] Optional child directory (e.g. 'userdata',
 *   'octrees', 'screenshots'). Omitted returns the root itself.
 */
export function devStateRoot(subdir) {
  let base;
  if (process.platform === 'darwin') {
    base = join(homedir(), 'Library', 'Caches', 'Phytograph', 'dev');
  } else if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    base = join(local, 'Phytograph', 'cache', 'dev');
  } else {
    const xdg = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
    base = join(xdg, 'Phytograph', 'dev');
  }
  return subdir ? join(base, subdir) : base;
}
