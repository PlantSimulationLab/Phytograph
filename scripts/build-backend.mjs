// Builds the Python/FastAPI backend into a PyInstaller --onedir bundle and
// drops it into ./resources/ so electron-builder picks it up as an extra
// resource at packaging time.
//
// Usage:
//   npm run build:backend                            # uses ./backend-api/venv
//   BACKEND_DIR=/path/to/backend-api npm run build:backend
//   PYTHON=/path/to/python npm run build:backend     # bypass venv discovery
//
// Python interpreter resolution (first match wins):
//   1. $PYTHON env var (explicit override)
//   2. $BACKEND_DIR/venv/bin/python (Unix) or $BACKEND_DIR/venv/Scripts/python.exe (Windows)
//   3. `pyinstaller` on PATH (CI uses this — runner has no anaconda)
//
// Why prefer the venv: a bare `pyinstaller` shebang on a dev machine often
// resolves to /opt/anaconda3/bin/pyinstaller, whose Python lacks the backend's
// deps (fastapi, pyhelios, etc.) and produces a broken binary that crashes
// with ModuleNotFoundError at startup. Invoking `python -m PyInstaller` via
// the venv's python sidesteps PATH precedence AND any broken shebangs in
// venv/bin/pyinstaller (which can happen if the venv was relocated).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const backendDir = resolve(process.env.BACKEND_DIR ?? join(root, 'backend-api'));
const distPath = join(root, 'resources');
const isWin = process.platform === 'win32';

if (!existsSync(join(backendDir, 'backend_wrapper.py'))) {
  console.error(`[build-backend] backend_wrapper.py not found in ${backendDir}`);
  console.error('[build-backend] set BACKEND_DIR to the backend-api directory, or create the venv as documented in README.md.');
  process.exit(1);
}

// PyHelios is vendored as a source submodule. `--collect-all pyhelios` pulls
// the Python package + assets from the (editable) install, but the native
// library lives OUTSIDE the package tree (pyhelios_build/build/lib/), so
// collect-all misses it. We compile it first (if missing) and then add it
// explicitly via --add-binary into pyhelios/plugins/ — the first location the
// runtime loader (pyhelios/plugins/loader.py) searches, matching the wheel
// layout. PyInstaller follows libhelios's own dylib deps (e.g. libomp) from
// there. The compiled plugin libs (liblidar.a, libplantarchitecture.a,
// libvisualizer.a) are STATIC and already linked into libhelios, so only the
// one .dylib/.dll/.so needs bundling.
const pyheliosSrc = join(root, 'pyhelios', 'pyhelios', '__init__.py');
const pyheliosExtraArgs = [];
if (existsSync(pyheliosSrc)) {
  const libName = isWin ? 'libhelios.dll' : process.platform === 'darwin' ? 'libhelios.dylib' : 'libhelios.so';
  const libPath = join(root, 'pyhelios', 'pyhelios_build', 'build', 'lib', libName);
  if (!existsSync(libPath)) {
    console.log('[build-backend] PyHelios native library missing — building from source first...');
    const r = spawnSync('node', [join(root, 'scripts', 'build-pyhelios.mjs')], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error('[build-backend] PyHelios build failed; aborting backend bundle.');
      process.exit(r.status ?? 1);
    }
  }
  if (!existsSync(libPath)) {
    console.error(`[build-backend] PyHelios native library still missing at ${libPath}; aborting.`);
    process.exit(1);
  }
  // PyInstaller --add-binary/--add-data SRC:DESTDIR (':' on Unix, ';' on Windows).
  const sep = isWin ? ';' : ':';
  pyheliosExtraArgs.push('--add-binary', `${libPath}${sep}pyhelios/plugins`);
  console.log(`[build-backend] bundling PyHelios native lib: ${libPath} -> pyhelios/plugins/`);

  // The runtime asset tree (textures, plant models, shaders) staged by
  // build-pyhelios.mjs. The asset manager (pyhelios/assets/__init__.py) treats
  // the bundled package as a wheel install and looks for these under
  // pyhelios/assets/build/, so map assets_for_wheel/ -> pyhelios/assets/build/.
  const assetsSrc = join(root, 'pyhelios', 'pyhelios_build', 'build', 'assets_for_wheel');
  if (!existsSync(join(assetsSrc, 'lib', 'images'))) {
    console.error(`[build-backend] PyHelios staged assets missing at ${assetsSrc}; re-run scripts/build-pyhelios.mjs.`);
    process.exit(1);
  }
  pyheliosExtraArgs.push('--add-data', `${assetsSrc}${sep}pyhelios/assets/build`);
  console.log(`[build-backend] bundling PyHelios assets: ${assetsSrc} -> pyhelios/assets/build/`);
}

mkdirSync(distPath, { recursive: true });

// Hidden imports + collect-all flags mirror the historical CI workflow.
const hiddenImports = [
  'uvicorn',
  'uvicorn.logging',
  'uvicorn.loops',
  'uvicorn.loops.auto',
  'uvicorn.protocols',
  'uvicorn.protocols.http',
  'uvicorn.protocols.http.auto',
  'uvicorn.protocols.websockets',
  'uvicorn.protocols.websockets.auto',
  'uvicorn.lifespan',
  'uvicorn.lifespan.on',
  'fastapi',
  'pandas',
  'numpy',
  'numpy.core._methods',
  'numpy.lib.format',
  'matplotlib',
  'matplotlib.backends.backend_agg',
  'scipy',
  'scipy.optimize',
  'scipy.spatial',
  'scipy.sparse',
  'scipy.sparse.csgraph',
  'open3d',
  'laspy',
  'lazrs',
  // plyfile: pure-Python PLY parser, imported lazily inside _ply_to_las.
  // Declared explicitly so PyInstaller bundles it even though the import is
  // function-local rather than module-top-level.
  'plyfile',
  'openpyxl',
  'pydantic',
  'pydantic.deprecated.decorator',
];

// --collect-all bundles a package's binaries + data files + submodules.
// pytexit reads __version__.txt at import time, so it must be collected as data.
// pyhelios is the importable module name; it is vendored as a git submodule at
// <repo>/pyhelios and installed editable (see scripts/build-pyhelios.mjs), not a
// pip wheel. collect-all gathers the package's Python code, textures, and xml
// asset trees — but NOT the native libhelios, which lives outside the package
// tree in the source layout; that's added separately via pyheliosExtraArgs.
// CSF (cloth-simulation-filter) is a SWIG C-extension; the import name is the
// capitalized "CSF" (PyPI distribution is "cloth-simulation-filter"). collect-all
// pulls its _CSF native module + SWIG wrapper.
// TreeIso tree segmentation: cut_pursuit_py is a pybind11 C-extension (its
// .so/.pyd must travel with the bundle); skimage/numpy_indexed pull in
// submodules PyInstaller doesn't always trace. The TreeIso algorithm itself is
// vendored under backend-api/vendor/treeiso/ and handled by treeisoExtraArgs.
// pye57 wraps libE57Format as a compiled extension — collect-all so its native
// .so/.pyd + any data travel with the bundle (used by _e57_to_las for E57 import
// and sky/miss recovery).
// pyproj ships the PROJ C library AND its proj.db datum/grid database; collect-all
// (NOT a bare hidden-import) is REQUIRED so that data dir travels with the bundle —
// otherwise the geographic->UTM transform in sbet.py crashes only in the packaged
// app ("proj.db not found"), never in dev.
// tifffile writes GeoTIFF DEM rasters (/api/dem/export-raster) — pure-Python (no
// GDAL), but collect-all pulls its submodules PyInstaller doesn't always trace.
const collectAll = ['scipy', 'open3d', 'laspy', 'lazrs', 'pytexit', 'pyhelios', 'CSF', 'cut_pursuit_py', 'skimage', 'numpy_indexed', 'pye57', 'pyproj', 'tifffile'];

// Vendored TreeIso (MIT) lives under backend-api/vendor/ and is imported lazily
// via a runtime sys.path tweak in main.py. Add vendor/ to the analysis path so
// PyInstaller resolves `treeiso.treeiso_core`, and ship the package as data so
// its files travel in the bundle.
const sep = isWin ? ';' : ':';
const treeisoExtraArgs = [
  '--paths', join(backendDir, 'vendor'),
  '--hidden-import', 'treeiso.treeiso_core',
  '--hidden-import', 'cut_pursuit_py',
  '--hidden-import', 'maxflow',
  '--hidden-import', 'skimage.draw',
  '--add-data', `${join(backendDir, 'vendor', 'treeiso')}${sep}treeiso`,
];

// --onedir vs --onefile:
//   --onefile produces a single self-extracting binary that unpacks ~300 MB
//   to a temp dir on EVERY launch. Adds 5-8s of cold start.
//   --onedir produces a directory tree (binary + _internal/) with no
//   extraction step. Inside the .app bundle the user sees no difference.
//   Faster, fewer disk writes per launch, easier to codesign per-file.
const pyinstallerArgs = [
  '-m', 'PyInstaller',
  '--onedir',
  '--noconfirm',
  '--name', 'phytograph_backend',
  '--distpath', distPath,
  '--workpath', join(distPath, 'build'),
  '--specpath', join(distPath, 'build'),
  ...hiddenImports.flatMap((m) => ['--hidden-import', m]),
  ...collectAll.flatMap((m) => ['--collect-all', m]),
  ...pyheliosExtraArgs,
  ...treeisoExtraArgs,
  'backend_wrapper.py',
];

function resolvePython() {
  if (process.env.PYTHON) {
    if (!existsSync(process.env.PYTHON)) {
      console.error(`[build-backend] PYTHON=${process.env.PYTHON} does not exist`);
      process.exit(1);
    }
    return { path: process.env.PYTHON, source: '$PYTHON' };
  }

  const venvPython = isWin
    ? join(backendDir, 'venv', 'Scripts', 'python.exe')
    : join(backendDir, 'venv', 'bin', 'python');
  if (existsSync(venvPython)) {
    return { path: venvPython, source: 'backend-api/venv' };
  }

  // CI fallback: rely on whatever python pyinstaller resolves to. CI installs
  // pip deps into the active Python env; runners have no anaconda interference.
  return null;
}

const python = resolvePython();

console.log(`[build-backend] backend: ${backendDir}`);
console.log(`[build-backend] output:  ${distPath}`);
if (python) {
  console.log(`[build-backend] python:  ${python.path} (from ${python.source})`);
} else {
  console.log(`[build-backend] python:  using bare \`pyinstaller\` from PATH (no venv found)`);
  console.log(`[build-backend] NOTE: if this is a local dev machine with anaconda installed, the bare`);
  console.log(`[build-backend]       pyinstaller will likely resolve to anaconda's, which lacks the backend's`);
  console.log(`[build-backend]       deps and will produce a broken binary. Create backend-api/venv per README.`);
}

const cmd = python ? python.path : 'pyinstaller';
const args = python ? pyinstallerArgs : pyinstallerArgs.slice(2); // drop `-m PyInstaller` when using the binary directly

const proc = spawn(cmd, args, { cwd: backendDir, stdio: 'inherit' });
proc.on('error', (err) => {
  console.error(`[build-backend] failed to spawn ${cmd}:`, err.message);
  process.exit(1);
});
proc.on('exit', (code) => {
  if (code !== 0) {
    console.error(`[build-backend] exited ${code}`);
    process.exit(code ?? 1);
  }
  // Clean up PyInstaller's build artifacts; keep only the bundle directory.
  rmSync(join(distPath, 'build'), { recursive: true, force: true });
  console.log('[build-backend] done.');
});
