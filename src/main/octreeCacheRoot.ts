// The on-disk root where cached Potree octrees live.
//
// This value is computed in TWO processes and they MUST agree:
//   - the Python backend WRITES octrees there (`_octree_cache_root()` in
//     backend-api/main.py),
//   - the Electron main process READS them back out through the app://
//     protocol handler (src/main/octreeProtocol.ts).
//
// They did not agree, and it shipped. Main used to derive the root from
// `app.getPath('userData')`, which on Windows is %APPDATA% (Roaming) while the
// backend writes to %LOCALAPPDATA% (Local) — so every import on Windows built
// an octree the renderer could never fetch. The protocol handler 404'd, its
// plain-text body ("no such file: …") failed potree-core's JSON.parse, and the
// cloud silently never rendered (GitHub issue #4). Linux diverged the same way
// (~/.config/<name> vs ~/.cache/Phytograph). macOS was the ONLY platform where
// the two happened to land on the same directory, and only because
// `app.getName()` returns "phytograph" while the backend hardcodes
// "Phytograph" and the default APFS volume is case-insensitive — i.e. the
// platform we develop and run E2E on was passing by accident.
//
// Two things keep it fixed:
//   1. `startBackend` pins the resolved value into the backend's spawn env as
//      PHYTOGRAPH_OCTREE_CACHE_ROOT, so at runtime there is exactly one
//      directory in play regardless of what the Python fallback would guess.
//   2. The defaults below still mirror the Python fallback exactly (for a
//      standalone `backend_wrapper.py` launch), pinned by the shared contract
//      in src/shared/octreeCacheRoot.contract.json — asserted from BOTH sides
//      (octreeCacheRoot.test.ts and backend-api/tests/test_octree_cache_root.py).
//      Change one side and the other side's test fails.
//
// Direction of the fix is deliberate: main moved to the backend's location
// rather than the reverse. Local (not Roaming) is the correct home for a
// multi-gigabyte regenerable cache on Windows — Roaming profiles sync it —
// and ~/.cache is the correct XDG location on Linux. It also means octrees
// existing users already paid to build become readable instead of orphaned.

// SECOND failure, macOS-only, same "one path, two owners" shape. macOS used to
// be ~/Library/Application Support/Phytograph/cache/octrees — i.e. inside
// `<userData>`, whose `Cache` subdirectory is CHROMIUM'S HTTP cache. The
// default APFS volume is case-insensitive, so `cache` and `Cache` are one
// directory, and Chromium empties that directory when it initializes its disk
// cache. Every launch therefore deleted the entire octree cache; a second
// concurrent instance (a dev or E2E app alongside the packaged one) deleted it
// out from under the running app mid-session. It read as a cache that "kept
// getting cleared", and for a cloud EDITED since import — whose octree is the
// only copy of those edits — as "Edited point cloud unavailable".
//
// macOS now mirrors Linux: the OS cache directory, not the user-data
// directory. Nothing was migrated because there was never anything to migrate
// — the old location could not survive a single relaunch.
//
// The invariant to preserve: this path must never land inside a directory
// Chromium manages. On darwin that means never under Application Support with
// a segment that case-folds to "cache"; pinned by octreeCacheRoot.test.ts.

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the octree cache root. Parameters exist for testability — production
 * callers pass nothing and get the live platform/env/home.
 *
 * PHYTOGRAPH_OCTREE_CACHE_ROOT overrides everything (set by scripts/dev.mjs,
 * the E2E launcher, and — for the packaged app — by startBackend itself).
 */
export function resolveOctreeCacheRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = env.PHYTOGRAPH_OCTREE_CACHE_ROOT;
  if (override) return override;

  if (platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'Phytograph', 'octrees');
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(base, 'Phytograph', 'cache', 'octrees');
  }
  const base = env.XDG_CACHE_HOME || join(home, '.cache');
  return join(base, 'Phytograph', 'octrees');
}
