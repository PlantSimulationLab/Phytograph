// The Azure Artifact Signing (formerly "Azure Trusted Signing") account that
// signs every Windows binary we ship. ONE definition, read by both signers:
//
//   - scripts/run-electron-builder.mjs — injects it into electron-builder, which
//     signs the installer and every .exe it packages.
//   - scripts/sign-win-natives.ps1 — signs every other native library
//     (electron-builder signs .exe only). Run by release.yml over the sidecar
//     bundles and by scripts/after-pack-win-sign.cjs over the unpacked app.
//
// It is shared rather than copied because two signers pointing at two
// certificate profiles would produce an installer whose files disagree about
// who published them, and nothing would fail until a user's policy did.
//
// Run directly (`node scripts/azure-sign-config.mjs`) it prints the config as
// JSON, which is how the workflow's PowerShell reads it.

import { pathToFileURL } from 'node:url';

export const AZURE_SIGN = {
  endpoint: 'https://wus2.codesigning.azure.net/',
  codeSigningAccountName: 'GitHubPackageSigning',
  certificateProfileName: 'phytograph-package-signing',
  // Must match the CN on the issued certificate EXACTLY. electron-updater
  // compares this against the downloaded installer's signature; if it is unset
  // it silently SKIPS verification, and if it is wrong it rejects every update.
  publisherName: 'Brian Bailey',
  // Azure's certificates are valid for only 72 HOURS, so a signature without a
  // timestamp stops validating within days of release. Neither signer sends
  // these unless told to.
  timestampRfc3161: 'http://timestamp.acs.microsoft.com',
  timestampDigest: 'SHA256',
};

/**
 * Should this build sign for Windows? ONE answer for both signers, so the
 * installer and the libraries inside it are never signed on different terms.
 * Missing credentials mean an unsigned build, not a failed one — that is what a
 * local `npm run package:win` is.
 */
export function azureSigningDecision(env) {
  if (env.SKIP_WIN_SIGNING === '1' || env.SKIP_WIN_SIGNING === 'true') {
    return { enabled: false, reason: 'SKIP_WIN_SIGNING is set.' };
  }
  const haveCreds =
    env.AZURE_TENANT_ID &&
    env.AZURE_CLIENT_ID &&
    (env.AZURE_CLIENT_SECRET || env.AZURE_CLIENT_CERTIFICATE_PATH);
  if (!haveCreds) {
    return {
      enabled: false,
      reason: 'no AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET.',
    };
  }
  return { enabled: true, reason: 'Azure credentials present.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(AZURE_SIGN));
}
