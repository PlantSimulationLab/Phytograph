// Cross-platform electron-builder launcher that injects the resolved output
// directory (see build-output-dir.mjs for why the path is not a literal).
//
// This exists instead of `$(npm run --silent build:output-dir)` inline in the
// npm script because the release workflow runs `npm run release` on the Windows
// runner without a bash shell — POSIX command substitution does not expand
// under cmd.exe and would hand electron-builder a literal "$(npm run ...)"
// string as its output path.
//
// Any extra CLI args are forwarded verbatim, so
//   npm run release -- --mac --arm64
// still reaches electron-builder intact.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBuildOutputDir } from './build-output-dir.mjs';

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

// electron-builder leaves a fully-formed Phytograph.app under <output>/mac*/
// next to the DMG/ZIP, and macOS Launch Services registers ANY app bundle it
// notices — which makes the throwaway build copy show up in the Apps launcher
// alongside the real /Applications install.
//
// The `.noindex` suffix on the output dir does NOT prevent this: `.noindex` is
// a Spotlight/mds convention that suppresses *content indexing* only. Launch
// Services is a separate subsystem and registers the bundle regardless
// (verified — a build into the .noindex dir still appeared in `lsregister
// -dump`). So the unpacked copy has to be explicitly de-registered after each
// local build, which is what this does.
//
// macOS-only and best-effort: failure here must never fail a build, and CI
// has no Launch Services to pollute.
function unregisterUnpackedApps(outputDir) {
  if (process.platform !== 'darwin' || process.env.CI) return;
  if (!existsSync(LSREGISTER) || !existsSync(outputDir)) return;

  let macDirs = [];
  try {
    macDirs = readdirSync(outputDir).filter((d) => d.startsWith('mac'));
  } catch {
    return;
  }

  for (const d of macDirs) {
    const app = join(outputDir, d, 'Phytograph.app');
    if (!existsSync(app)) continue;
    const r = spawnSync(LSREGISTER, ['-u', app], { stdio: 'ignore' });
    if (r.status === 0) {
      console.log(`unregistered from Launch Services: ${app}`);
    }
  }
}

const outputDir = resolveBuildOutputDir();
const forwarded = process.argv.slice(2);

const args = [...forwarded, `-c.directories.output=${outputDir}`];

console.log(`electron-builder output dir: ${outputDir}`);

const result = spawnSync('electron-builder', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`failed to run electron-builder: ${result.error.message}`);
  process.exit(1);
}

// Runs even on a failed build — a partially-packaged .app registers too.
unregisterUnpackedApps(outputDir);
process.exit(result.status ?? 1);
