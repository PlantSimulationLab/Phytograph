// Shared helpers for the backend version-lock contract (see CLAUDE.md).
//
// Three declarations must move together — `BACKEND_VERSION` in
// backend-api/main.py, `EXPECTED_BACKEND_VERSION` in src/shared/constants.ts,
// and `version` in package.json — and the PyInstaller bundle in
// resources/phytograph_backend/ is a fourth, *build-time* copy of the first.
//
// That fourth one is the trap. It only changes when someone runs
// `npm run build:backend`, so editing main.py's version (or pulling a commit
// that did) silently leaves a stale bundle on disk. The app then refuses to talk
// to it: `useBackendReady` requires an exact version match, so the splash never
// clears and EVERY E2E spec fails ~30s in, at whatever locator it happened to be
// waiting on. Nothing in that failure names the real cause.
//
// So the build stamps the version it produced into the bundle directory, and
// callers compare that stamp against the source of truth BEFORE launching
// anything. Reading a file costs nothing and the diagnosis is exact.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep as pathSep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Written by scripts/build-backend.mjs into the bundle dir at build time.
export const BACKEND_STAMP_FILE = 'phytograph_backend_version.txt';

// Second stamp: a hash of the Python sources the bundle was built FROM.
//
// The version stamp alone has a blind spot, and it is the common case rather
// than an exotic one. `BACKEND_VERSION` only moves when a change requires a new
// packaged build, so the overwhelming majority of backend edits — bug fixes,
// new filtering, anything that doesn't break the renderer contract — leave it
// untouched. The stamp then still matches, `check:backend` reports OK, and E2E
// launches a bundle compiled from *older Python* while reporting green. That is
// worse than the stale-version hang it was written to catch: a hang is loud,
// this silently tests code that is not the code under review.
//
// Observed exactly that way: a bundle built 2026-08-22 sailed through
// `check:backend` against sources edited 2026-08-23, and would have run the
// whole E2E suite without exercising a single one of the day's backend changes.
export const BACKEND_SOURCE_HASH_FILE = 'phytograph_backend_sources.sha256';

// Directories whose .py files are compiled INTO the bundle. `research/`,
// `tools/`, `scripts/` and `tests/` are dev-only and deliberately excluded — a
// change there cannot affect the shipped binary, and hashing them would demand
// pointless 10-minute rebuilds.
const BUNDLED_SOURCE_DIRS = ['', 'qsm', 'qsm/validation', 'vendor/treeiso'];

// Bundled sources that do NOT live under backend-api/. The RIEGL reader sits in
// the Docker build context (it is also what `docker build` ships), but on a
// native runtime it is compiled into the bundle and executed as a child of the
// backend — so an edit to it changes the shipped binary exactly like an edit to
// main.py does.
//
// This has to be here or the hash has a hole in precisely the shape this check
// exists to catch: the stamp would still match after a reader change, E2E would
// print a tick, and the suite would pass having exercised a bundle built from
// older code. The .cpp/.def are included because they ship as data and define
// the miss-recovery DLL built on the user's machine.
//
// Paths are relative to the repo root, and hashed under that spelling.
const BUNDLED_EXTRA_SOURCES = [
  'docker/riegl/rxp_reader.py',
  'docker/riegl/rxp_shim.cpp',
  'docker/riegl/rxpshim.def',
];

export function backendBundleDir() {
  return join(root, 'resources', 'phytograph_backend');
}

/** `BACKEND_VERSION` as declared in backend-api/main.py — the source of truth. */
export function readBackendVersionFromSource() {
  const mainPy = join(root, 'backend-api', 'main.py');
  const m = readFileSync(mainPy, 'utf8').match(/^BACKEND_VERSION\s*=\s*["']([^"']+)["']/m);
  if (!m) throw new Error(`Could not find BACKEND_VERSION in ${mainPy}`);
  return m[1];
}

/** `EXPECTED_BACKEND_VERSION` as declared in src/shared/constants.ts. */
export function readExpectedBackendVersion() {
  const constants = join(root, 'src', 'shared', 'constants.ts');
  const m = readFileSync(constants, 'utf8')
    .match(/EXPECTED_BACKEND_VERSION\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error(`Could not find EXPECTED_BACKEND_VERSION in ${constants}`);
  return m[1];
}

/**
 * SHA-256 over every bundled Python source, plus the paths themselves.
 *
 * Path-sensitive on purpose: hashing contents alone would miss a file being
 * added, deleted, or renamed, which changes the bundle just as surely as an
 * edit. Sorted with a fixed separator so the digest is stable across platforms
 * and filesystem enumeration order.
 *
 * Reads ~2 MB of text and takes single-digit milliseconds — the whole point of
 * this check is that it costs nothing next to a 10-minute rebuild.
 */
export function hashBackendSources() {
  const backendDir = join(root, 'backend-api');
  // [label, absolutePath]. The label is what gets hashed alongside the bytes,
  // so it must be stable across platforms and independent of where the repo
  // lives. Files under backend-api/ keep their historical backend-relative
  // spelling, so this change does not invalidate every existing stamp.
  const files = [];
  for (const rel of BUNDLED_SOURCE_DIRS) {
    const dir = rel ? join(backendDir, ...rel.split('/')) : backendDir;
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.py')) continue;
      const full = join(dir, name);
      if (!statSync(full).isFile()) continue;
      files.push([relative(backendDir, full).split(pathSep).join('/'), full]);
    }
  }
  for (const rel of BUNDLED_EXTRA_SOURCES) {
    const full = join(root, ...rel.split('/'));
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    files.push([rel, full]);
  }
  // Normalise separators so a Windows build and a macOS build of identical
  // sources produce identical digests.
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = createHash('sha256');
  for (const [label, full] of files) {
    h.update(label);
    h.update('\0');
    h.update(readFileSync(full));
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * The source digest recorded at build time, or null when the bundle predates
 * source hashing. Null is "unknown", not "mismatch" — same treatment as an
 * unstamped version.
 */
export function readBundleSourceHash() {
  const f = join(backendBundleDir(), BACKEND_SOURCE_HASH_FILE);
  if (!existsSync(f)) return null;
  const v = readFileSync(f, 'utf8').trim();
  return v.length > 0 ? v : null;
}

/**
 * The version the bundle on disk was built from, or null when it carries no
 * stamp. A missing stamp means the bundle predates stamping (or was built by
 * another tool) — treat it as unknown, not as a mismatch, and let the caller
 * decide. Bundles built before this change are the only source of nulls, and
 * one `npm run build:backend` clears that for good.
 */
export function readBundleStamp() {
  const stamp = join(backendBundleDir(), BACKEND_STAMP_FILE);
  if (!existsSync(stamp)) return null;
  const v = readFileSync(stamp, 'utf8').trim();
  return v.length > 0 ? v : null;
}

/**
 * Check the built bundle against the source of truth without launching anything.
 *
 * Returns `{ ok, reason, message }`. `ok: false` always carries a `message`
 * naming the exact mismatch and the one command that fixes it. `reason` is
 * machine-readable: 'missing-bundle' | 'stale-bundle' | 'stale-sources' |
 * 'version-lock' | 'unstamped' | 'unhashed'.
 */
export function checkBackendBundle({ allowUnstamped = true } = {}) {
  const bundleDir = backendBundleDir();
  const binary = join(
    bundleDir,
    process.platform === 'win32' ? 'phytograph_backend.exe' : 'phytograph_backend',
  );

  if (!existsSync(binary)) {
    return {
      ok: false,
      reason: 'missing-bundle',
      message:
        `The PyInstaller backend bundle is missing (${binary}).\n` +
        `Run \`npm run build:backend\` before E2E.\n` +
        `Mocks are not allowed — see CLAUDE.md Testing rule #1.`,
    };
  }

  const source = readBackendVersionFromSource();
  const expected = readExpectedBackendVersion();

  // The version-lock trio itself is broken: main.py and constants.ts disagree,
  // so NO bundle could satisfy the renderer. Rebuilding won't help; say so
  // rather than sending someone on a 10-minute build.
  if (source !== expected) {
    return {
      ok: false,
      reason: 'version-lock',
      message:
        `Backend version-lock mismatch in the SOURCE (rebuilding will not fix this):\n` +
        `  backend-api/main.py       BACKEND_VERSION          = ${source}\n` +
        `  src/shared/constants.ts   EXPECTED_BACKEND_VERSION = ${expected}\n` +
        `These must be equal (and match package.json's version). See CLAUDE.md ` +
        `"Version-lock contract".`,
    };
  }

  const stamp = readBundleStamp();
  if (stamp === null) {
    if (allowUnstamped) return { ok: true, reason: 'unstamped', bundleVersion: null };
    return {
      ok: false,
      reason: 'unstamped',
      message:
        `The backend bundle carries no version stamp, so it can't be verified.\n` +
        `Run \`npm run build:backend\` to rebuild and stamp it.`,
    };
  }

  if (stamp !== source) {
    return {
      ok: false,
      reason: 'stale-bundle',
      bundleVersion: stamp,
      message:
        `Stale backend bundle — the app will refuse to talk to it and every E2E ` +
        `spec will hang at the backend splash.\n` +
        `  built bundle (resources/phytograph_backend) = ${stamp}\n` +
        `  source        (backend-api/main.py)         = ${source}\n` +
        `Fix: npm run build:backend`,
    };
  }

  // Versions agree — now the harder question: was this bundle built from the
  // Python that is on disk RIGHT NOW? Most backend edits don't move
  // BACKEND_VERSION, so the check above passes on a bundle that is days old.
  // Without this, E2E runs old code and reports green.
  const builtHash = readBundleSourceHash();
  if (builtHash === null) {
    if (allowUnstamped) {
      return { ok: true, reason: 'unhashed', bundleVersion: stamp, sourceHash: null };
    }
    return {
      ok: false,
      reason: 'unhashed',
      bundleVersion: stamp,
      message:
        `The backend bundle carries no source hash, so edits that don't move ` +
        `BACKEND_VERSION can't be detected.\n` +
        `Run \`npm run build:backend\` to rebuild and stamp it.`,
    };
  }

  const currentHash = hashBackendSources();
  if (builtHash !== currentHash) {
    return {
      ok: false,
      reason: 'stale-sources',
      bundleVersion: stamp,
      message:
        `Stale backend bundle — it was built from DIFFERENT Python sources than ` +
        `the ones on disk.\n` +
        `The version matches (${stamp}), so the app will start and E2E will look ` +
        `green — while testing the OLD backend code.\n` +
        `  bundle built from sources sha256 = ${builtHash.slice(0, 16)}…\n` +
        `  backend-api/*.py currently       = ${currentHash.slice(0, 16)}…\n` +
        `Fix: npm run build:backend`,
    };
  }

  return { ok: true, bundleVersion: stamp, sourceHash: currentHash };
}
