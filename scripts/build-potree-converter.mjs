// Builds PotreeConverter 2.x from source and drops the binary into
// ./resources/potree_converter/<platform>/ so electron-builder picks it up
// as an extra resource.
//
// PotreeConverter upstream doesn't build on macOS without PR #686 (libc++
// parallel STL fix). This script applies that patch before configuring;
// when #686 merges, drop the patch step.
//
// Usage:
//   npm run build:potree-converter                # build for the current platform
//   FORCE=1 npm run build:potree-converter        # rebuild even if binary exists
//   POTREE_REPO=https://... npm run build:potree-converter   # alternate source repo
//
// Prerequisites:
//   macOS / Linux: cmake, a C++20 compiler, Intel TBB
//     - macOS: brew install cmake tbb
//     - Linux: apt install cmake libtbb-dev
//   Windows: Visual Studio 2019+, CMake. TBB is pulled via vcpkg if present.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const SRC_DIR = join(repoRoot, 'tmp', 'potree-converter-src');
const BUILD_DIR = join(SRC_DIR, 'build');
const POTREE_REPO = process.env.POTREE_REPO ?? 'https://github.com/potree/PotreeConverter.git';
// The patch is a snapshot of PR #686 saved alongside this script. We fetch
// it dynamically (instead of vendoring the diff) so the script tracks the PR
// if its author updates it. Pinning the SHA would avoid surprises — TODO
// once #686 stabilises.
const PR_NUMBER = 686;
const PATCH_FILE = join(SRC_DIR, '.phytograph-pr686.patch');
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
  }

  if (spawnSync('gh', ['--version'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('gh CLI not found on PATH. Needed to fetch PR #686 as a patch until upstream merges.');
  }
}

function ensureSourceTree() {
  if (!existsSync(SRC_DIR)) {
    console.log(`cloning ${POTREE_REPO} -> ${SRC_DIR}`);
    mkdirSync(dirname(SRC_DIR), { recursive: true });
    run('git', ['clone', '--depth', '1', POTREE_REPO, SRC_DIR]);
  } else {
    console.log(`reusing source tree at ${SRC_DIR}`);
  }
}

function applyPatchIfNeeded() {
  if (!existsSync(PATCH_FILE)) {
    console.log(`fetching upstream PR #${PR_NUMBER} as patch...`);
    const diff = runCapture('gh', ['pr', 'diff', String(PR_NUMBER), '--repo', 'potree/PotreeConverter']);
    writeFileSync(PATCH_FILE, diff);
  }
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
  } else if (platform() === 'linux') {
    bundleSiblings((f) => f.includes('.so'));
    // $ORIGIN lets the ELF binary load siblings from its own directory.
    spawnSync('patchelf', ['--set-rpath', '$ORIGIN', dstBin], { stdio: 'inherit' });
  } else if (platform() === 'win32') {
    // Windows searches the executable's own directory for DLLs, so just copy
    // any sibling DLLs next to the .exe.
    bundleSiblings((f) => f.toLowerCase().endsWith('.dll'));
  }
}

function outputExists() {
  const dst = join(repoRoot, 'resources', 'potree_converter', platformTag(), binaryName());
  return existsSync(dst);
}

async function main() {
  if (outputExists() && !FORCE) {
    console.log(`PotreeConverter for ${platformTag()} already exists. Set FORCE=1 to rebuild.`);
    return;
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
