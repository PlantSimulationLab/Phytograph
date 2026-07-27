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
import { resolveBuildOutputDir } from './build-output-dir.mjs';

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
process.exit(result.status ?? 1);
