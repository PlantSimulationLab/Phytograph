// Runs the backend pytest suite through the backend venv's own interpreter.
//
// Replaces the `cd backend-api && ./venv/bin/pytest` this npm script used to
// be. That path only exists on Unix — a venv on Windows puts its interpreter
// at venv/Scripts/python.exe — so `npm run test:backend` (and the `npm test`
// that chains it) could not run on Windows at all.
//
// Resolution order mirrors scripts/build-backend.mjs, for the same reason it
// does: invoking `python -m pytest` via the venv's interpreter sidesteps both
// PATH precedence (an anaconda `pytest` earlier on PATH lacks this project's
// deps) and any stale shebang in venv/bin/pytest left by a relocated venv.
//
//   npm run test:backend                    # whole suite
//   npm run test:backend -- -k lad -x       # extra args pass through to pytest
//   PYTHON=/path/to/python npm run test:backend   # bypass venv discovery

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = process.env.BACKEND_DIR ?? join(repoRoot, 'backend-api');
const isWin = process.platform === 'win32';

function resolvePython() {
  if (process.env.PYTHON) {
    if (!existsSync(process.env.PYTHON)) {
      console.error(`[run-pytest] PYTHON=${process.env.PYTHON} does not exist`);
      process.exit(1);
    }
    return process.env.PYTHON;
  }
  const venvPython = isWin
    ? join(backendDir, 'venv', 'Scripts', 'python.exe')
    : join(backendDir, 'venv', 'bin', 'python');
  if (existsSync(venvPython)) return venvPython;

  // CI fallback: the workflow installs deps into the active Python env and
  // never creates backend-api/venv, so plain `python` is the right interpreter
  // there. Locally this is usually a misconfiguration, hence the warning.
  console.warn('[run-pytest] no backend-api/venv found — falling back to `python` from PATH');
  console.warn('[run-pytest] if that python lacks the backend deps, create the venv per README.md');
  return 'python';
}

const python = resolvePython();
const args = process.argv.slice(2);
console.log(`[run-pytest] ${python} -m pytest ${args.join(' ')}`.trimEnd());

const r = spawnSync(python, ['-m', 'pytest', ...args], {
  cwd: backendDir,
  stdio: 'inherit',
});
if (r.error) {
  console.error(`[run-pytest] failed to launch: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
