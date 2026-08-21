// Pins the notarization retry policy in scripts/notarize.cjs.
//
// The retry exists because the hook runs at the tail of an ~80 minute native
// macOS build, and a single dropped HTTPS request to Apple used to throw all of
// it away (it cost the v0.70.0 release two full rebuild cycles). The whole
// safety argument for retrying at all is that we can tell a TRANSPORT failure
// from a VERDICT — so that distinction is what these tests hold still. A retry
// that swallowed a genuine "Invalid" would be strictly worse than no retry: it
// would spend an hour re-proving the app is unsignable.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// notarize.cjs is CommonJS and `require`s @electron/notarize internally, which
// Vitest's ESM module mocking does not intercept — an earlier version of this
// test mocked the package and still watched the hook shell out to the real
// `codesign`. So the hook exposes its submitter as `exports._submit` and we
// swap that instead: a seam that is a property on the module, which a release
// build has no way to reach.
// Loaded through createRequire, not `import()`: we need the live CJS `exports`
// object to assign the seam onto, and an ESM namespace object is frozen.
const require = createRequire(import.meta.url);
const notarizeModule = require('./notarize.cjs');
const { isRetryableNotaryError } = notarizeModule;
const notarizing = notarizeModule.default;

/** Stands in for @electron/notarize's `notarize()`. */
const notarize = vi.fn();
notarizeModule._submit = notarize;

// The verbatim failure from the v0.70.0 macos-15-intel build (CI log
// 2026-08-21T15:16:48). If the classifier ever stops matching this exact
// string, the retry silently stops covering the case it was written for.
const V070_NOTARY_TIMEOUT =
  'Failed to notarize via notarytool.  Failed with unexpected result: \n\n' +
  'Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1001 ' +
  '"The request timed out." UserInfo={_kCFStreamErrorCodeKey=60, NSUnderlyingError=0x600003f36280 ' +
  '{Error Domain=kCFErrorDomainCFNetwork Code=-1001 "(null)"}), ' +
  'NSLocalizedDescription=The request timed out., ' +
  'NSErrorFailingURLStringKey=https://appstoreconnect.apple.com/notary/v2/submissions/99cccbb2-13ba-4c15-8a25-4ee1c33d935e?';

// What @electron/notarize throws when notarytool DID parse and Apple said no.
const REJECTED_VERDICT =
  'Failed to notarize via notarytool\n\n' +
  '{"id":"abc-123","status":"Invalid","message":"Package Invalid"}\n\n' +
  'Diagnostics from notarytool log: The binary is not signed with a valid Developer ID certificate.';

describe('isRetryableNotaryError', () => {
  it('retries the real v0.70.0 notary timeout', () => {
    expect(isRetryableNotaryError(new Error(V070_NOTARY_TIMEOUT))).toBe(true);
  });

  it.each([
    ['connection lost', 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."'],
    ['offline', 'Error Domain=NSURLErrorDomain Code=-1009 "You are not connected to the internet."'],
    ['socket reset', 'Error: socket hang up ECONNRESET'],
    ['dns flake', 'Error: getaddrinfo EAI_AGAIN appstoreconnect.apple.com'],
    ['gateway 503', 'HTTP 503 from appstoreconnect notary gateway'],
    ['upload plumbing', 'Failed to upload the archive to the notary service'],
  ])('retries a transport failure: %s', (_name, message) => {
    expect(isRetryableNotaryError(new Error(message))).toBe(true);
  });

  it('does NOT retry a rejected verdict, even though it mentions notarytool', () => {
    expect(isRetryableNotaryError(new Error(REJECTED_VERDICT))).toBe(false);
  });

  it('does NOT retry a verdict that also carries transport-ish words', () => {
    // Defensive: a verdict wins over any network vocabulary in the diagnostics,
    // so Apple telling us the app is bad is never mistaken for bad weather.
    const mixed =
      'Failed to notarize via notarytool\n\n{"status":"Invalid"}\n\n' +
      'Diagnostics: NSURLErrorDomain Code=-1001 seen earlier in the log';
    expect(isRetryableNotaryError(new Error(mixed))).toBe(false);
  });

  it.each([
    ['bad credentials', 'Error: HTTP status code: 401. Invalid credentials.'],
    ['zip failure', 'Failed to zip application, exited with code: 1'],
    ['unrecognised', 'Error: something else entirely went wrong'],
  ])('does NOT retry a non-transport failure: %s', (_name, message) => {
    expect(isRetryableNotaryError(new Error(message))).toBe(false);
  });
});

describe('the notarizing hook', () => {
  const context = {
    electronPlatformName: 'darwin',
    appOutDir: '/tmp/out',
    packager: { appInfo: { productFilename: 'Phytograph' } },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    notarize.mockReset();
    vi.stubEnv('APPLE_ID', 'dev@example.com');
    vi.stubEnv('APPLE_PASSWORD', 'app-specific-password');
    vi.stubEnv('APPLE_TEAM_ID', 'TEAM123');
    vi.stubEnv('SKIP_NOTARIZATION', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Runs the hook to completion with the backoff timers auto-advanced. */
  async function run() {
    const promise = notarizing(context);
    // Settle each backoff without waiting the real 1-3 minutes.
    const settled = promise.then(
      (v) => ({ ok: true, v }),
      (e) => ({ ok: false, e }),
    );
    await vi.runAllTimersAsync();
    return settled;
  }

  it('submits once when Apple accepts', async () => {
    notarize.mockResolvedValueOnce(undefined);
    const result = await run();
    expect(result.ok).toBe(true);
    expect(notarize).toHaveBeenCalledTimes(1);
  });

  it('recovers from a transport failure on a later attempt', async () => {
    notarize
      .mockRejectedValueOnce(new Error(V070_NOTARY_TIMEOUT))
      .mockResolvedValueOnce(undefined);
    const result = await run();
    expect(result.ok).toBe(true);
    expect(notarize).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts and rethrows the last error', async () => {
    notarize.mockRejectedValue(new Error(V070_NOTARY_TIMEOUT));
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.e.message).toContain('The request timed out');
    expect(notarize).toHaveBeenCalledTimes(3);
  });

  it('fails IMMEDIATELY on a rejected verdict — no second submission', async () => {
    // The point of the whole exercise: never spend another ~20 minutes
    // re-uploading a bundle Apple has already refused.
    notarize.mockRejectedValue(new Error(REJECTED_VERDICT));
    const result = await run();
    expect(result.ok).toBe(false);
    expect(result.e.message).toContain('Invalid');
    expect(notarize).toHaveBeenCalledTimes(1);
  });

  it('skips entirely when SKIP_NOTARIZATION is set', async () => {
    vi.stubEnv('SKIP_NOTARIZATION', '1');
    const result = await run();
    expect(result.ok).toBe(true);
    expect(notarize).not.toHaveBeenCalled();
  });

  it('skips when credentials are missing, rather than retrying 3x', async () => {
    vi.stubEnv('APPLE_ID', '');
    const result = await run();
    expect(result.ok).toBe(true);
    expect(notarize).not.toHaveBeenCalled();
  });

  it('does nothing on a non-darwin build', async () => {
    const result = await notarizing({ ...context, electronPlatformName: 'win32' })
      .then(() => ({ ok: true }), (e) => ({ ok: false, e }));
    expect(result.ok).toBe(true);
    expect(notarize).not.toHaveBeenCalled();
  });
});
