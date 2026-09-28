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
//
// The whole suite runs as TWO pytest processes: every `tests/test_ml_*.py`
// (the files that load torch) in one, everything else in the other. On macOS,
// torch and libhelios bring two LLVM OpenMP runtimes that cannot share a
// process in either load order, and the rest of the suite imports `main`
// (which loads libhelios) long before the torch tests run. One process hung
// forever at the first torch test. Details and the guard tests are in
// backend-api/tests/test_ml_worker_isolation.py. Naming specific test paths
// skips the split and runs exactly what you asked for.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
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

function pytest(runArgs) {
  console.log(`[run-pytest] ${python} -m pytest ${runArgs.join(' ')}`.trimEnd());
  const r = spawnSync(python, ['-m', 'pytest', ...runArgs], {
    cwd: backendDir,
    stdio: 'inherit',
  });
  if (r.error) {
    console.error(`[run-pytest] failed to launch: ${r.error.message}`);
    process.exit(1);
  }
  return r.status ?? 1;
}

// A bare word after an option (`-k lad`) is not a path; only something that
// looks like a test file or node id counts as naming tests.
const namesTests = args.some((a) => !a.startsWith('-') && (a.endsWith('.py') || a.includes('::') || a.startsWith('tests')));
const mlTests = readdirSync(join(backendDir, 'tests'))
  .filter((f) => /^test_ml_.*\.py$/.test(f))
  .map((f) => `tests/${f}`);

if (namesTests || mlTests.length === 0) process.exit(pytest(args));

// Everything else first, then the torch files appending to the same coverage
// data, so the report printed last covers both runs.
const NO_TESTS_COLLECTED = 5;   // e.g. a -k that matches nothing in one half
const rest = pytest([...args, ...mlTests.map((f) => `--ignore=${f}`)]);
if (rest !== 0 && rest !== NO_TESTS_COLLECTED && args.some((a) => a === '-x' || a.startsWith('--maxfail'))) {
  process.exit(rest);
}
const ml = pytest([...args, '--cov-append', ...mlTests]);
const statuses = [rest, ml];
const failed = statuses.find((s) => s !== 0 && s !== NO_TESTS_COLLECTED);
if (failed !== undefined) process.exit(failed);
process.exit(statuses.every((s) => s === NO_TESTS_COLLECTED) ? NO_TESTS_COLLECTED : 0);
