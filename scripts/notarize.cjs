// electron-builder afterSign hook: submits the .app to Apple notarization.
// Skipped on non-macOS platforms, when SKIP_NOTARIZATION is set, and when
// notary credentials (APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID) are missing
// — e.g. local dev builds, or CI before the Apple secrets are configured.

const { notarize } = require('@electron/notarize');

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

  console.log(`[notarize] submitting ${appPath} (this typically takes a few minutes)...`);
  await notarize({
    tool: 'notarytool',
    appBundleId: 'com.phytograph.app',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] complete.');
};
