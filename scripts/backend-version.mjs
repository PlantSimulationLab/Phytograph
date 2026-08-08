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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Written by scripts/build-backend.mjs into the bundle dir at build time.
export const BACKEND_STAMP_FILE = 'phytograph_backend_version.txt';

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
 * machine-readable: 'missing-bundle' | 'stale-bundle' | 'version-lock' |
 * 'unstamped'.
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

  return { ok: true, bundleVersion: stamp };
}
