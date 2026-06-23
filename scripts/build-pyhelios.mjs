// Builds the PyHelios native library (libhelios) from the source submodule at
// ./pyhelios and installs the package editable into the backend venv so both
// dev (uvicorn) and packaging (PyInstaller) resolve the source build instead of
// the old pyhelios3d wheel.
//
// Usage:
//   node scripts/build-pyhelios.mjs                 # release, plantarchitecture+lidar
//   node scripts/build-pyhelios.mjs --debug         # debug build
//   node scripts/build-pyhelios.mjs --clean         # force a clean rebuild
//   node scripts/build-pyhelios.mjs --require-gpu   # fail if CUDA wasn't compiled in
//   PYTHON=/path/to/python node scripts/build-pyhelios.mjs   # bypass venv discovery
//
// Python interpreter resolution mirrors scripts/build-backend.mjs:
//   1. $PYTHON env var (explicit override)
//   2. backend-api/venv/bin/python (Unix) / Scripts/python.exe (Windows)
//   3. `python3` (Unix) / `python` (Windows) on PATH (CI fallback)
//
// Why only plantarchitecture + lidar: those are the only Helios plugins
// Phytograph's backend uses (procedural plants + LiDAR triangulation). Both are
// gpu_required=False, so --nogpu drops the radiation/OptiX (OptiX-CUDA)
// toolchain we don't use.
//
// GPU vs CPU: --nogpu does NOT disable the lidar/collisiondetection CUDA
// ray-tracing path. That path is gated purely by CMake's
// `find_package(CUDAToolkit)` — if a CUDA toolkit is on the machine, Helios
// compiles CollisionDetection.cu and defines HELIOS_CUDA_AVAILABLE; otherwise it
// builds CPU-only. cudart is linked statically (CUDA::cudart_static), so a
// GPU-enabled libhelios still runs on machines with no CUDA/driver (it falls
// back to CPU/OpenMP via cudaGetDeviceCount()). The release workflow installs
// the CUDA toolkit on the Windows + Linux runners to ship GPU-accelerated
// builds; macOS has no CUDA and is always CPU-only. Locally this build is
// GPU-enabled only if you have a CUDA toolkit installed.
//
// NOTE: the lidar plugin has a C++-level dependency on the visualizer that the
// Helios CMake auto-loads ("[LiDAR] Automatically loading visualizer
// dependency"), so the visualizer + its OpenGL deps (glfw/glew/freetype) DO get
// compiled regardless of this list. On macOS (Cocoa) and Windows (native GL)
// that needs no extra system packages; on Linux it needs OpenGL/X11 dev headers
// (libgl1-mesa-dev, xorg-dev) — the release workflow's "Install Linux build
// dependencies" step provides them. Phytograph's release matrix is macOS,
// Windows, and Linux.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const backendDir = join(root, 'backend-api');
const pyheliosDir = join(root, 'pyhelios');
const isWin = process.platform === 'win32';

// Plugins the backend actually uses. Keep in sync with the imports in
// backend-api/main.py (LiDARCloud, PlantArchitecture).
const PLUGINS = ['plantarchitecture', 'lidar'];

const args = process.argv.slice(2);
const buildMode = args.includes('--debug') ? 'debug' : 'release';
const clean = args.includes('--clean');
// Fail the build if libhelios didn't compile the CUDA path. The release
// workflow passes this on Windows/Linux so a broken GPU build never ships.
const requireGpu = args.includes('--require-gpu');

// The submodule must be initialized (and its nested helios-core sub-submodule).
if (!existsSync(join(pyheliosDir, 'build_scripts', 'build_helios.py'))) {
  console.error('[build-pyhelios] PyHelios submodule not initialized.');
  console.error('[build-pyhelios] Run: git submodule update --init --recursive');
  process.exit(1);
}
if (!existsSync(join(pyheliosDir, 'helios-core', 'core'))) {
  console.error('[build-pyhelios] helios-core sub-submodule not initialized.');
  console.error('[build-pyhelios] Run: git submodule update --init --recursive');
  process.exit(1);
}

function resolvePython() {
  if (process.env.PYTHON) {
    if (!existsSync(process.env.PYTHON)) {
      console.error(`[build-pyhelios] PYTHON=${process.env.PYTHON} does not exist`);
      process.exit(1);
    }
    return process.env.PYTHON;
  }
  const venvPython = isWin
    ? join(backendDir, 'venv', 'Scripts', 'python.exe')
    : join(backendDir, 'venv', 'bin', 'python');
  if (existsSync(venvPython)) return venvPython;
  // CI fallback: whatever python the runner activated.
  return isWin ? 'python' : 'python3';
}

const python = resolvePython();

function runStep(label, cmd, cmdArgs, opts = {}) {
  console.log(`[build-pyhelios] ${label}`);
  console.log(`[build-pyhelios]   ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', ...opts });
  if (r.error) {
    console.error(`[build-pyhelios] failed to spawn: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`[build-pyhelios] ${label} exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

console.log(`[build-pyhelios] python:   ${python}`);
console.log(`[build-pyhelios] source:   ${pyheliosDir}`);
console.log(`[build-pyhelios] mode:     ${buildMode}`);
console.log(`[build-pyhelios] plugins:  ${PLUGINS.join(', ')}`);

// 1. Compile the native library via PyHelios's own build script.
const buildArgs = [
  'build_scripts/build_helios.py',
  '--buildmode', buildMode,
  '--nogpu',
  '--plugins', ...PLUGINS,
  '--verbose',
];
if (clean) buildArgs.push('--clean');
runStep('Building native library...', python, buildArgs, { cwd: pyheliosDir });

// 2. Editable install so `import pyhelios` resolves to the source tree.
runStep('Installing PyHelios (editable)...', python, ['-m', 'pip', 'install', '-e', pyheliosDir]);

// 2b. Stage the runtime asset tree (textures, plant models, shaders, fonts) into
// pyhelios_build/build/assets_for_wheel/. PyHelios's setup.py runs this during a
// wheel build, but an editable install skips it — and at runtime the asset
// manager (pyhelios/assets/__init__.py) treats the editable layout as a "wheel
// install" (the dist-info is present) and demands assets at
// pyhelios/assets/build/lib/images. We reuse PyHelios's own prepare_wheel logic
// so the staged tree exactly matches what a real wheel ships, then
// build-backend.mjs bundles it into the PyInstaller output.
runStep('Staging runtime assets (assets_for_wheel)...', python, [
  '-c',
  [
    'import sys; sys.path.insert(0, "build_scripts")',
    'import prepare_wheel',
    'from pathlib import Path',
    'prepare_wheel.copy_assets_for_packaging(Path(".").resolve())',
  ].join('; '),
], { cwd: pyheliosDir });

// 3. Verify the native library landed where we expect.
const libName = isWin ? 'libhelios.dll' : process.platform === 'darwin' ? 'libhelios.dylib' : 'libhelios.so';
const libPath = join(pyheliosDir, 'pyhelios_build', 'build', 'lib', libName);
if (!existsSync(libPath)) {
  console.error(`[build-pyhelios] expected native library not found: ${libPath}`);
  console.error('[build-pyhelios] check the build output above for errors.');
  process.exit(1);
}

// Verify the staged asset tree the runtime requires (lib/images must be non-empty).
const stagedImages = join(pyheliosDir, 'pyhelios_build', 'build', 'assets_for_wheel', 'lib', 'images');
if (!existsSync(stagedImages)) {
  console.error(`[build-pyhelios] staged assets missing: ${stagedImages}`);
  console.error('[build-pyhelios] prepare_wheel asset staging did not produce lib/images.');
  process.exit(1);
}

// 4. Verify the build actually compiled the CUDA ray-tracing path when the
// caller demands it (--require-gpu, passed by the release workflow on
// Windows/Linux). The collisiondetection plugin defines HELIOS_CUDA_AVAILABLE
// iff CMake's find_package(CUDAToolkit) succeeded, so the configure-time
// decision IS the shipped capability — and we read it from the CMake cache
// (ground truth). This turns a silently CPU-only "GPU" build (e.g. the CUDA
// toolkit install step failed) into a hard, loud release failure instead of a
// broken installer. macOS has no CUDA and never passes --require-gpu.
function libheliosCompiledWithCuda() {
  const cache = join(pyheliosDir, 'pyhelios_build', 'build', 'CMakeCache.txt');
  if (!existsSync(cache)) return null;  // unknown — can't read the configure result
  try {
    const txt = readFileSync(cache, 'utf8');
    const cudaCompiler = /^CMAKE_CUDA_COMPILER:[^=]*=(.+)$/m.exec(txt);
    if (cudaCompiler && cudaCompiler[1].trim() && !/NOTFOUND/i.test(cudaCompiler[1])) return true;
    if (/^CUDAToolkit_FOUND:[^=]*=(TRUE|ON|1)\s*$/im.test(txt)) return true;
    return false;  // cache present & unambiguous: CUDA was not configured
  } catch {
    return null;  // unreadable
  }
}

if (requireGpu) {
  const compiled = libheliosCompiledWithCuda();
  if (compiled === true) {
    console.log('[build-pyhelios] GPU build verified: libhelios compiled with CUDA.');
  } else {
    console.error('[build-pyhelios] --require-gpu: libhelios did NOT compile the CUDA path.');
    console.error(`[build-pyhelios]   CMake cache says CUDA ${compiled === false ? 'was not found' : 'state is unknown'}.`);
    console.error('[build-pyhelios]   Is the CUDA toolkit installed and on PATH? (release CI installs it.)');
    process.exit(1);
  }
}

// The build tree is large and per-machine (the submodule's own .gitignore keeps
// it out of git). On macOS, keep Dropbox from syncing it — same convention as
// the venvs (see CLAUDE.md).
if (process.platform === 'darwin') {
  spawnSync('xattr', ['-w', 'com.dropbox.ignored', '1', join(pyheliosDir, 'pyhelios_build')], { stdio: 'ignore' });
}

console.log(`[build-pyhelios] done. native library: ${libPath}`);
