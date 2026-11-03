// Builds the Python scripting client's wheel into resources/python/, where
// electron-builder's extraResources picks it up, so every installed app carries
// the `phytograph` package that matches its own backend version exactly.
//
// Run from `npm run build`, which every `npm run package*` (and so the release
// workflow) goes through. It FAILS the build when it can't produce the wheel:
// an extraResources glob that matches nothing packages nothing and says
// nothing, so a missing wheel would otherwise ship silently.
//
// The builder (python/build_wheel.py) uses the standard library only, so any
// Python 3.9+ works: the backend venv when it exists, else python3 / python.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'resources', 'python');
const isWin = process.platform === 'win32';

function candidates() {
  const venv = isWin
    ? join(root, 'backend-api', 'venv', 'Scripts', 'python.exe')
    : join(root, 'backend-api', 'venv', 'bin', 'python');
  return [process.env.PYTHON, existsSync(venv) ? venv : null, 'python3', 'python'].filter(Boolean);
}

// Probe before use: on Windows `python3` can be the Microsoft Store stub, which
// RUNS (so spawn reports no error) and exits non-zero instead of being absent.
function usable(py) {
  const r = spawnSync(py, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'],
    { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

if (process.env.PYTHON && !usable(process.env.PYTHON)) {
  console.error(`[build-python-wheel] PYTHON=${process.env.PYTHON} is not a usable Python 3.9+.`);
  process.exit(1);
}

let built = false;
for (const py of candidates()) {
  if (!usable(py)) continue;
  const r = spawnSync(py, [join(root, 'python', 'build_wheel.py'), '--out', outDir],
    { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`[build-python-wheel] ${py} failed:\n${r.stdout ?? ''}${r.stderr ?? ''}`);
    process.exit(1);
  }
  console.log(`[build-python-wheel] ${r.stdout.trim()}`);
  built = true;
  break;
}
if (!built) {
  console.error('[build-python-wheel] no Python 3.9+ interpreter found (tried $PYTHON, backend-api/venv, python3, python).');
  console.error('[build-python-wheel] Set PYTHON=/path/to/python. The app must not ship without its Python package.');
  process.exit(1);
}
const wheels = readdirSync(outDir).filter((f) => f.endsWith('.whl'));
if (wheels.length !== 1) {
  console.error(`[build-python-wheel] expected exactly one wheel in ${outDir}, found: ${wheels.join(', ') || 'none'}`);
  process.exit(1);
}
