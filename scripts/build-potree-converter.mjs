// Builds PotreeConverter 2.x from source and drops the binary into
// ./resources/potree_converter/<platform>/ so electron-builder picks it up
// as an extra resource.
//
// PotreeConverter upstream doesn't build on macOS without PR #686 (libc++
// parallel STL fix). This script applies that patch before configuring;
// when #686 merges, drop the patch step.
//
// BOTH inputs are pinned: the upstream commit (POTREE_COMMIT) and the patch
// (scripts/patches/potree-converter-pr686.patch, checked by PATCH_SHA256).
// They used to float — `git clone --depth 1` of the default branch plus a live
// `gh pr diff 686` — and upstream merging #697 ("compressed_chunks") on
// 2026-09-22 broke every cold build: #686 stopped applying, and had it applied
// we would have shipped an unreviewed octree-format change. Bumping either
// edits this file, which is also what moves every workflow's potree cache key
// (they hash this script), so a bump always forces a real rebuild.
//
// Usage:
//   npm run build:potree-converter                # build for the current platform
//   FORCE=1 npm run build:potree-converter        # rebuild even if binary exists
//   POTREE_REPO=https://... npm run build:potree-converter   # alternate source repo
//
// Prerequisites:
//   macOS / Linux: cmake, a C++20 compiler, Intel TBB
//     - macOS: brew install cmake tbb
//     - Linux: apt install cmake libtbb-dev patchelf   (patchelf makes the
//       installed binary find its bundled libs — see install())
//   Windows: Visual Studio 2019+, CMake. TBB is pulled via vcpkg if present.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const SRC_DIR = join(repoRoot, 'tmp', 'potree-converter-src');
const BUILD_DIR = join(SRC_DIR, 'build');
const POTREE_REPO = process.env.POTREE_REPO ?? 'https://github.com/potree/PotreeConverter.git';
// Upstream commit every shipped converter has been built from: the tip of the
// default branch immediately before the #697 merge ("Add support for point data
// format 8", 2026-06-22).
const POTREE_COMMIT = 'a70ef212198b0e5ae1d071713a0c8cbda8fcc9a7';
// PR #686 as `gh pr diff 686` returned it at head 9def4f9 (last updated
// 2026-01-01), vendored so the build needs no network call to GitHub's API.
const PR_NUMBER = 686;
const PATCH_FILE = join(__dirname, 'patches', 'potree-converter-pr686.patch');
const PATCH_SHA256 = '1fd6fa2a2a5417606ac9c5f4c12a13ef0eaa64b89667cb8b0e67052c4916cb59';
const FORCE = process.env.FORCE === '1';

function platformTag() {
  const p = platform();
  if (p === 'darwin') return arch() === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (p === 'win32') return 'win-x64';
  if (p === 'linux') return arch() === 'arm64' ? 'linux-arm64' : 'linux-x64';
  throw new Error(`Unsupported platform: ${p}/${arch()}`);
}

function binaryName() {
  return platform() === 'win32' ? 'PotreeConverter.exe' : 'PotreeConverter';
}

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    throw new Error(`Command failed (${r.status}): ${cmd} ${args.join(' ')}`);
  }
}

function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`Command failed (${r.status}): ${cmd} ${args.join(' ')}\n${r.stderr ?? ''}`);
  }
  return r.stdout;
}

function preflight() {
  // cmake is required everywhere.
  try {
    runCapture('cmake', ['--version']);
  } catch {
    throw new Error('cmake not found on PATH. Install: macOS `brew install cmake`, Linux `apt install cmake`.');
  }

  if (platform() === 'darwin') {
    // TBB is the trickiest part — verify before kicking off a long build.
    if (spawnSync('brew', ['list', 'tbb'], { stdio: 'ignore' }).status !== 0) {
      throw new Error('Intel TBB not installed. Run `brew install tbb` and retry.');
    }
  } else if (platform() === 'linux') {
    if (spawnSync('pkg-config', ['--exists', 'tbb'], { stdio: 'ignore' }).status !== 0) {
      throw new Error('Intel TBB headers/lib not found via pkg-config. Run `apt install libtbb-dev` or your distro equivalent.');
    }
    // patchelf is what makes the installed binary relocatable (see install()).
    // Check it HERE rather than discovering it missing after the build: without
    // it the binary still builds, still passes outputUsable(), and is broken
    // everywhere except this machine.
    if (spawnSync('patchelf', ['--version'], { stdio: 'ignore' }).status !== 0) {
      throw new Error('patchelf not found on PATH. Needed to point the binary at its bundled libs. Run `apt install patchelf` or your distro equivalent.');
    }
  }

  const patchHash = createHash('sha256').update(readFileSync(PATCH_FILE)).digest('hex');
  if (patchHash !== PATCH_SHA256) {
    throw new Error(`${PATCH_FILE} does not match PATCH_SHA256 (got ${patchHash}). Update the constant deliberately if the patch was meant to change.`);
  }
}

function ensureSourceTree() {
  if (!existsSync(SRC_DIR)) {
    console.log(`cloning ${POTREE_REPO} -> ${SRC_DIR}`);
    mkdirSync(dirname(SRC_DIR), { recursive: true });
    // A shallow fetch of one exact commit (GitHub serves any reachable SHA).
    mkdirSync(SRC_DIR, { recursive: true });
    run('git', ['init', '-q'], { cwd: SRC_DIR });
    run('git', ['remote', 'add', 'origin', POTREE_REPO], { cwd: SRC_DIR });
    run('git', ['fetch', '--depth', '1', 'origin', POTREE_COMMIT], { cwd: SRC_DIR });
    run('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: SRC_DIR });
  } else {
    console.log(`reusing source tree at ${SRC_DIR}`);
  }
  const head = runCapture('git', ['rev-parse', 'HEAD'], { cwd: SRC_DIR }).trim();
  if (head !== POTREE_COMMIT) {
    throw new Error(
      `${SRC_DIR} is at ${head}, not the pinned ${POTREE_COMMIT}. ` +
      `Delete that directory and re-run to fetch the pinned source.`);
  }
}

function applyPatchIfNeeded() {
  // `git apply --reverse --check` succeeds iff the patch is already applied.
  // This handles the case where the source tree was patched in a previous
  // run (or by a developer manually) and we'd otherwise fail with "patch
  // does not apply".
  const reverseCheck = spawnSync('git', ['apply', '--reverse', '--check', PATCH_FILE], { cwd: SRC_DIR, stdio: 'ignore' });
  if (reverseCheck.status === 0) {
    console.log(`PR #${PR_NUMBER} already applied to source tree; skipping patch`);
    return;
  }
  console.log(`applying PR #${PR_NUMBER}`);
  run('git', ['apply', PATCH_FILE], { cwd: SRC_DIR });
}

function configure() {
  if (existsSync(BUILD_DIR)) {
    // Clean reconfigure prevents cmake from holding onto a stale toolchain.
    rmSync(BUILD_DIR, { recursive: true, force: true });
  }
  mkdirSync(BUILD_DIR, { recursive: true });
  // -DCMAKE_POLICY_VERSION_MINIMUM=3.5 unblocks the brotli sub-project's
  // ancient cmake_minimum_required under CMake 4.x.
  run('cmake', ['..', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5'], { cwd: BUILD_DIR });
}

function build() {
  // -j defaults to all cores; on CI runners this is the build's hot path.
  run('cmake', ['--build', '.', '--config', 'Release', '-j'], { cwd: BUILD_DIR });
}

// Parse the LC_RPATH entries out of `otool -l`. Each one appears as a
// three-line stanza:
//     cmd LC_RPATH
//     cmdsize 80
//     path /some/dir (offset 12)
function machoRpaths(bin) {
  const r = spawnSync('otool', ['-l', bin], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  const paths = [];
  const lines = r.stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== 'cmd LC_RPATH') continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const m = lines[j].match(/^\s*path (.+?) \(offset \d+\)\s*$/);
      if (m) { paths.push(m[1]); break; }
    }
  }
  return paths;
}

function install() {
  const tag = platformTag();
  const outDir = join(repoRoot, 'resources', 'potree_converter', tag);
  mkdirSync(outDir, { recursive: true });
  // Single-config generators (Make/Ninja on macOS/Linux) write the binary
  // directly into BUILD_DIR; multi-config generators (MSVC/Visual Studio on
  // Windows) write it into a per-config subdir, BUILD_DIR/Release/. Check both.
  const candidates = [
    join(BUILD_DIR, binaryName()),
    join(BUILD_DIR, 'Release', binaryName()),
  ];
  const srcBin = candidates.find((p) => existsSync(p));
  if (!srcBin) {
    throw new Error(`build did not produce ${binaryName()} (looked in: ${candidates.join(', ')})`);
  }
  const dstBin = join(outDir, binaryName());
  copyFileSync(srcBin, dstBin);
  chmodSync(dstBin, 0o755);
  console.log(`installed ${dstBin} (${statSync(dstBin).size} bytes)`);

  // PotreeConverter links its sibling libraries (e.g. liblaszip) via @rpath,
  // and CMake bakes in an rpath pointing at the BUILD tree. Copying only the
  // binary leaves it dependent on a path that won't exist on a user's machine
  // — on macOS it aborts at launch with "Library not loaded:
  // @rpath/liblaszip.dylib". Bundle the sibling shared libs next to the binary
  // so it loads them from its own directory.
  const buildOutDir = dirname(srcBin);
  const bundleSiblings = (predicate) => {
    for (const lib of readdirSync(buildOutDir).filter(predicate)) {
      copyFileSync(join(buildOutDir, lib), join(outDir, lib));
      console.log(`bundled ${lib}`);
    }
  };
  if (platform() === 'darwin') {
    bundleSiblings((f) => f.endsWith('.dylib'));
    // Add the binary's own directory to its rpath search list (idempotent: a
    // duplicate -add_rpath is only a non-fatal warning).
    spawnSync('install_name_tool', ['-add_rpath', '@loader_path', dstBin], { stdio: 'inherit' });
    // Then drop CMake's baked-in build-tree rpath. `-add_rpath` only appends,
    // so without this the binary keeps searching BUILD_DIR *first* and only
    // falls through to @loader_path when that misses. That ordering is what
    // makes the failure mode so slippery: on the build machine the stale path
    // still resolves, so a binary that is broken everywhere else tests fine
    // here — and it breaks the moment `tmp/` is cleaned. Removing it makes
    // @loader_path the only search path, so local behaviour matches shipped.
    for (const stale of machoRpaths(dstBin).filter((p) => p !== '@loader_path')) {
      const r = spawnSync('install_name_tool', ['-delete_rpath', stale, dstBin], { encoding: 'utf8' });
      if (r.status === 0) console.log(`removed stale rpath ${stale}`);
      else console.warn(`could not remove rpath ${stale}: ${(r.stderr ?? '').trim()}`);
    }
  } else if (platform() === 'linux') {
    bundleSiblings((f) => f.includes('.so'));
    // $ORIGIN lets the ELF binary load siblings from its own directory, and
    // REPLACES the build-tree RUNPATH CMake baked in — same reasoning as the
    // -delete_rpath above, and the same slippery failure if it doesn't happen:
    // the stale path still resolves here, so the binary tests fine on the build
    // machine and is broken the moment `tmp/` is cleaned or it ships.
    //
    // So a failure is fatal, not advisory. preflight() already refuses to start
    // without patchelf; this catches the rarer case where it exists but errors.
    const r = spawnSync('patchelf', ['--set-rpath', '$ORIGIN', dstBin], { encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      const why = r.error?.message ?? (r.stderr ?? '').trim() ?? '';
      throw new Error(
        `patchelf --set-rpath failed on ${dstBin}: ${why || 'exit ' + r.status}\n` +
        "The binary would keep CMake's build-tree RUNPATH and break once tmp/ is cleaned.",
      );
    }
  } else if (platform() === 'win32') {
    // Windows searches the executable's own directory for DLLs, so just copy
    // any sibling DLLs next to the .exe.
    bundleSiblings((f) => f.toLowerCase().endsWith('.dll'));
  }
}

// Is the installed binary present AND actually runnable? Mere existence is
// not enough: a binary built before this script bundled sibling libs carries
// an rpath into the (long-since-deleted) build tree, so it aborts under dyld
// with "Library not loaded: @rpath/liblaszip.dylib" — exit -6, before main().
// `resources/potree_converter/` is gitignored, so that stale binary survives
// pulls and a plain existence check would skip the rebuild forever, leaving
// imports broken with a dyld backtrace far from the actual cause. Executing
// it is the only check that catches a missing/unresolvable dependency.
function outputUsable() {
  const dst = join(repoRoot, 'resources', 'potree_converter', platformTag(), binaryName());
  if (!existsSync(dst)) return { ok: false, reason: 'not built yet' };
  // --help exits 0 without touching the filesystem, but still forces dyld to
  // resolve every dependent library first — which is the part that fails.
  const r = spawnSync(dst, ['--help'], { encoding: 'utf8', timeout: 30_000 });
  if (r.error) return { ok: false, reason: `cannot execute: ${r.error.message}` };
  if (r.status !== 0) {
    const tail = ((r.stderr || r.stdout) ?? '').trim().split('\n').slice(0, 3).join('\n  ');
    return { ok: false, reason: `exits ${r.status ?? r.signal}:\n  ${tail}` };
  }
  return { ok: true };
}

async function main() {
  if (!FORCE) {
    const state = outputUsable();
    if (state.ok) {
      console.log(`PotreeConverter for ${platformTag()} already built and runnable. Set FORCE=1 to rebuild.`);
      return;
    }
    console.log(`Rebuilding PotreeConverter for ${platformTag()} — existing binary ${state.reason}`);
  }
  preflight();
  ensureSourceTree();
  applyPatchIfNeeded();
  configure();
  build();
  install();
  console.log(`\nDone. Binary at: resources/potree_converter/${platformTag()}/${binaryName()}`);
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
