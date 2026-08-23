// Verifies the built PyInstaller backend matches the version the app expects,
// without launching anything. Wired in front of `npm run test:e2e` so a stale
// bundle fails in milliseconds with an exact diagnosis, instead of hanging every
// spec for ~30s at the backend splash.
//
// Run it directly any time:  npm run check:backend

import { checkBackendBundle } from './backend-version.mjs';

const result = checkBackendBundle();

if (!result.ok) {
  console.error('\n[check-backend] ✖ backend bundle check FAILED\n');
  console.error(result.message.split('\n').map((l) => `  ${l}`).join('\n'));
  console.error('');
  process.exit(1);
}

if (result.reason === 'unstamped') {
  // Built before stamping existed. Not worth failing over — the launchApp
  // post-launch check still catches a mismatch — but say so, because it means
  // the fast pre-launch check is inert until the next rebuild.
  console.log(
    '[check-backend] bundle has no version stamp (built before stamping was added); ' +
      'run `npm run build:backend` to enable the fast check.',
  );
} else if (result.reason === 'unhashed') {
  // The version matches, but this bundle predates source hashing, so an edit
  // that didn't move BACKEND_VERSION is still invisible. Warn loudly rather
  // than printing a ✓ — a bare tick here is exactly what let a day-old bundle
  // through before, and the whole point of this check is to stop trusting the
  // version alone.
  console.warn(
    `[check-backend] ⚠ backend bundle ${result.bundleVersion} matches by VERSION only.\n` +
      '  It carries no source hash, so backend edits that leave BACKEND_VERSION\n' +
      '  unchanged cannot be detected — E2E may run older Python and still pass.\n' +
      '  Run `npm run build:backend` once to enable the content check.',
  );
} else {
  console.log(
    `[check-backend] ✓ backend bundle ${result.bundleVersion} matches source ` +
      `(sources ${result.sourceHash.slice(0, 16)}…)`,
  );
}
