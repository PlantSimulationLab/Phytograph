// electron-builder afterSign hook: submits the .app to Apple notarization.
// Skipped on non-macOS platforms, when SKIP_NOTARIZATION is set, and when
// notary credentials (APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID) are missing
// — e.g. local dev builds, or CI before the Apple secrets are configured.

// Resolved lazily through this indirection so the unit test can substitute a
// fake submitter. electron-builder always gets the real one: the seam is a
// property on the module, not an env var or a bundled test double, so there is
// no way for a release build to pick up anything else.
exports._submit = (opts) => require('@electron/notarize').notarize(opts);

// How many times to submit before giving up, and how long to wait between
// attempts. Backoff is deliberately generous: when Apple's notary API is
// flaking, retrying two seconds later just burns an attempt on the same bad
// weather.
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60_000, 180_000];

/**
 * Should this failure be retried?
 *
 * The distinction that matters: a TRANSPORT failure (the notary API timed out,
 * the connection dropped) says nothing about the app and is worth another
 * submission, while a VERDICT of Invalid/Rejected is Apple telling us the
 * bundle itself is bad. Retrying a verdict wastes ~20 minutes per attempt and,
 * worse, could look like flakiness when the app is genuinely unsignable.
 *
 * @electron/notarize gives us a clean seam for that, because it throws from two
 * different places (node_modules/@electron/notarize/lib/notarytool.js):
 *
 *   - `Failed to notarize via notarytool.  Failed with unexpected result:` —
 *     note the DOUBLE space. Thrown when notarytool's output isn't even JSON,
 *     which is where a transport error surfaces. This is the one that killed
 *     the v0.70.0 Intel build:
 *         HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain
 *         Code=-1001 "The request timed out." ... appstoreconnect.apple.com/
 *         notary/v2/submissions/…)
 *     after only ~4.5 minutes of waiting.
 *
 *   - `Failed to notarize via notarytool\n\n<json>` — single space, thrown when
 *     notarytool parsed fine but `status !== 'Accepted'`. That's a real verdict.
 *
 * So: retry when the message shows a transport symptom, and treat anything
 * carrying a parsed status (or anything we don't recognise) as final. Erring
 * toward NOT retrying is the safe default — a spurious hard failure costs one
 * `gh run rerun --failed`, whereas silently retrying a genuine rejection hides
 * a real problem behind an hour of build time.
 */
function isRetryableNotaryError(err) {
  const message = String((err && err.message) || err || '');

  // A parsed verdict is final, however it reads.
  if (/"status"\s*:\s*"(Invalid|Rejected)"/i.test(message)) return false;

  return (
    // Apple's URL-loading errors: -1001 timed out, -1005 connection lost,
    // -1009 offline, plus the generic domains they arrive under.
    /NSURLErrorDomain|kCFErrorDomainCFNetwork/.test(message) ||
    /Code=-100[0-9]\b/.test(message) ||
    /The request timed out|The network connection was lost|not connected to the internet/i.test(message) ||
    // Node/undici-level transport faults, in case the failure is below notarytool.
    /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENETDOWN|ENETUNREACH|EPIPE|socket hang up)\b/.test(message) ||
    // Apple's gateway having a bad day.
    /HTTPError\(statusCode: nil/.test(message) ||
    /\b(429|500|502|503|504)\b.*\b(notary|appstoreconnect)\b/i.test(message) ||
    // Upload/submission plumbing that isn't a verdict.
    /Failed to upload|Unable to (?:upload|submit)/i.test(message)
  );
}

// Exported for scripts/notarize.test.mjs: this predicate is the whole safety
// argument for retrying at all, so it is pinned against the real error strings
// Apple and notarytool produce.
exports.isRetryableNotaryError = isRetryableNotaryError;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID, SKIP_NOTARIZATION } = process.env;
  if (SKIP_NOTARIZATION === '1' || SKIP_NOTARIZATION === 'true') {
    console.log('[notarize] SKIP_NOTARIZATION set — skipping.');
    return;
  }
  if (!APPLE_ID || !APPLE_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] missing APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID — skipping.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  // This wraps `notarytool submit --wait`, which uploads the app then POLLS
  // Apple's notary service until it returns a verdict. The wait is unbounded:
  // Apple's queue can be slow (a new account's first submission has sat "In
  // Progress" for over an hour), so if CI appears stuck here it's almost always
  // waiting on Apple, not hung locally. Check status out-of-band with:
  //   xcrun notarytool history --apple-id … --team-id … --password …
  //
  // Retried up to MAX_ATTEMPTS times on TRANSPORT failures only — see
  // isRetryableNotaryError. Rationale: this hook runs at the tail of an ~80
  // minute native build (libhelios + PyInstaller + packaging + signing), and
  // before this retry existed a single dropped HTTPS request to Apple threw all
  // of that away. It cost the v0.70.0 release two full rebuild cycles.
  //
  // Re-submitting is safe: each attempt uploads a fresh submission and waits on
  // its own id, so a retry cannot staple the result of an earlier one. The only
  // cost of a needless retry is upload time.
  for (let attempt = 1; ; attempt++) {
    const started = new Date().toISOString();
    const label = attempt === 1 ? '' : ` (attempt ${attempt}/${MAX_ATTEMPTS})`;
    console.log(`[notarize] ${started} submitting ${appPath}${label} — uploading, then waiting on Apple's notary service (can take minutes to hours)...`);

    try {
      await exports._submit({
        tool: 'notarytool',
        appBundleId: 'com.phytograph.app',
        appPath,
        appleId: APPLE_ID,
        appleIdPassword: APPLE_PASSWORD,
        teamId: APPLE_TEAM_ID,
      });
      console.log(`[notarize] complete (submitted at ${started}, finished ${new Date().toISOString()}).`);
      return;
    } catch (err) {
      const retryable = isRetryableNotaryError(err);
      const attemptsLeft = MAX_ATTEMPTS - attempt;

      if (!retryable || attemptsLeft <= 0) {
        // Say WHY we stopped, so a release failure doesn't require reading this
        // file to interpret the log.
        console.error(
          `[notarize] attempt ${attempt}/${MAX_ATTEMPTS} failed and will not be retried ` +
          `(${retryable ? 'no attempts left' : 'not a transport error — Apple returned a verdict, or an error we do not recognise'}).`,
        );
        throw err;
      }

      const waitMs = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
      console.warn(
        `[notarize] attempt ${attempt}/${MAX_ATTEMPTS} failed with what looks like a transport error; ` +
        `retrying in ${Math.round(waitMs / 1000)}s. Underlying error:\n${(err && err.message) || err}`,
      );
      await sleep(waitMs);
    }
  }
};
