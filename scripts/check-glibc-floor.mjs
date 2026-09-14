// Measures the glibc version the shipped Linux binaries actually require and
// fails if it exceeds the floor we document (see scripts/glibc-floor.mjs for
// why this exists and why a runtime smoke test cannot replace it).
//
// No-ops off Linux. Run it directly any time:  npm run check:glibc

import { checkGlibcFloor, GLIBC_FLOOR } from './glibc-floor.mjs';

const result = checkGlibcFloor();

if (!result.ok) {
  console.error('\n[check-glibc] ✖ glibc floor check FAILED\n');
  console.error(
    result.message
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  );
  console.error('');
  process.exit(1);
}

if (result.reason === 'skipped') {
  console.log(`[check-glibc] skipped — ${result.message}`);
} else {
  console.log(
    `[check-glibc] ✓ highest requirement GLIBC_${result.maxVersion}, ` +
      `within the documented floor of ${GLIBC_FLOOR}`,
  );
}
