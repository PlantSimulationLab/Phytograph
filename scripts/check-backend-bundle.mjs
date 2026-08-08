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
} else {
  console.log(`[check-backend] ✓ backend bundle ${result.bundleVersion} matches source`);
}
