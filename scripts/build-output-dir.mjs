// Single source of truth for electron-builder's output directory.
//
// Why this isn't just the literal string "release" in package.json:
// electron-builder unpacks a full Phytograph.app under <output>/mac*/ next to
// the DMG/ZIP. When <output> lived inside the Dropbox tree, macOS Launch
// Services indexed those unpacked bundles and the app appeared three times in
// the Apps launcher and Spotlight (once per stale copy, plus the real
// /Applications install). Dropbox also burned hours syncing ~2.8 GB of
// throwaway bundles.
//
// Locally we therefore build to a path OUTSIDE the synced tree whose final
// component ends in `.noindex` — a suffix Spotlight/mds skips wholesale, which
// also stops Launch Services from registering the unpacked .app.
//
// CI keeps the repo-relative `release/` default: the release workflow refers to
// `release/latest-mac.yml` and `find release -maxdepth 2 -name '*.app'` as
// repo-relative paths, and a hardcoded ~/builds path would be wrong on the
// Windows runner besides. Runners are ephemeral and have no Dropbox or Launch
// Services to pollute, so the default is correct there.
//
// Override precedence:
//   1. PHYTOGRAPH_BUILD_OUTPUT  — explicit, wins everywhere (used by CI if ever needed)
//   2. ~/builds/phytograph.noindex  — local macOS/dev default
//   3. release/                  — CI default (env CI is set) and bare fallback

import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolve the absolute build-output directory.
 * @returns {string} absolute path
 */
export function resolveBuildOutputDir() {
  const explicit = process.env.PHYTOGRAPH_BUILD_OUTPUT;
  if (explicit) {
    return isAbsolute(explicit) ? explicit : join(repoRoot, explicit);
  }
  // CI (and any non-interactive runner) keeps the historical repo-relative dir.
  if (process.env.CI) {
    return join(repoRoot, 'release');
  }
  return join(homedir(), 'builds', 'phytograph.noindex');
}

// `node scripts/build-output-dir.mjs` prints the path, so npm scripts can
// interpolate it into the electron-builder CLI override.
if (process.argv[1] && process.argv[1].endsWith('build-output-dir.mjs')) {
  process.stdout.write(resolveBuildOutputDir());
}
