// Cross-platform electron-builder launcher that injects the resolved output
// directory (see build-output-dir.mjs for why the path is not a literal).
//
// This exists instead of `$(npm run --silent build:output-dir)` inline in the
// npm script because the release workflow runs `npm run release` on the Windows
// runner without a bash shell — POSIX command substitution does not expand
// under cmd.exe and would hand electron-builder a literal "$(npm run ...)"
// string as its output path.
//
// Any extra CLI args are forwarded verbatim, so
//   npm run release -- --mac --arm64
// still reaches electron-builder intact.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBuildOutputDir } from './build-output-dir.mjs';

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

// electron-builder leaves a fully-formed Phytograph.app under <output>/mac*/
// next to the DMG/ZIP, and macOS Launch Services registers ANY app bundle it
// notices — which makes the throwaway build copy show up in the Apps launcher
// alongside the real /Applications install.
//
// The `.noindex` suffix on the output dir does NOT prevent this: `.noindex` is
// a Spotlight/mds convention that suppresses *content indexing* only. Launch
// Services is a separate subsystem and registers the bundle regardless
// (verified — a build into the .noindex dir still appeared in `lsregister
// -dump`). So the unpacked copy has to be explicitly de-registered after each
// local build, which is what this does.
//
// macOS-only and best-effort: failure here must never fail a build, and CI
// has no Launch Services to pollute.
function unregisterUnpackedApps(outputDir) {
  if (process.platform !== 'darwin' || process.env.CI) return;
  if (!existsSync(LSREGISTER) || !existsSync(outputDir)) return;

  let macDirs = [];
  try {
    macDirs = readdirSync(outputDir).filter((d) => d.startsWith('mac'));
  } catch {
    return;
  }

  for (const d of macDirs) {
    const app = join(outputDir, d, 'Phytograph.app');
    if (!existsSync(app)) continue;
    const r = spawnSync(LSREGISTER, ['-u', app], { stdio: 'ignore' });
    if (r.status === 0) {
      console.log(`unregistered from Launch Services: ${app}`);
    }
  }
}

// ---------------- Windows code signing (Azure Artifact Signing) ----------------
//
// The Windows installer is signed by Azure Artifact Signing (formerly "Azure
// Trusted Signing"). The config is injected here rather than living in
// package.json because it must be CONDITIONAL: electron-builder's Azure path
// throws InvalidConfigurationError when AZURE_TENANT_ID / AZURE_CLIENT_ID are
// absent, which would break every local `npm run package:win`. With the block
// omitted entirely, electron-builder logs "no signing info identified, signing
// is skipped" and packages an unsigned installer — the same graceful no-op
// contract as scripts/notarize.cjs on macOS.
//
// Why signing must stay INSIDE electron-builder (do not "simplify" this into a
// separate azure/artifact-signing-action step after the build): NsisTarget
// signs the installer, THEN computes the blockmap, THEN writes the sha512 into
// latest.yml. Authenticode rewrites the PE when it embeds a signature, so
// signing after electron-builder exits changes the file's hash and latest.yml
// would describe bytes that no longer exist — electron-updater then rejects
// every update as corrupt.
//
// TimestampRfc3161 / TimestampDigest are passed explicitly because
// electron-builder 25.1.8 does NOT send any timestamp parameters to
// Invoke-TrustedSigning (electron-builder#8626, fixed in v26). Azure's
// certificates are valid for only 72 hours, so an untimestamped signature goes
// invalid within days of release. These extra keys reach the PowerShell cmdlet
// verbatim via the `[k: string]: string` passthrough on azureSignOptions.
const AZURE_SIGN = {
  endpoint: 'https://wus2.codesigning.azure.net/',
  codeSigningAccountName: 'GitHubPackageSigning',
  certificateProfileName: 'phytograph-package-signing',
  // Must match the CN on the issued certificate EXACTLY. electron-updater
  // compares this against the downloaded installer's signature; if it is unset
  // it silently SKIPS verification, and if it is wrong it rejects every update.
  publisherName: 'Brian Bailey',
};

// electron-builder is spawned with `shell: true` on Windows (see the spawnSync
// call below), which means cmd.exe re-tokenizes the argument list and splits any
// value containing a space. Only the shell path needs the quotes; on macOS and
// Linux the args reach execvp untouched and literal quotes would become part of
// the value.
function quoteIfNeeded(arg) {
  if (process.platform !== 'win32' || !arg.includes(' ')) return arg;
  const eq = arg.indexOf('=');
  return `${arg.slice(0, eq + 1)}"${arg.slice(eq + 1)}"`;
}

function azureSigningArgs() {
  const haveCreds =
    process.env.AZURE_TENANT_ID &&
    process.env.AZURE_CLIENT_ID &&
    (process.env.AZURE_CLIENT_SECRET || process.env.AZURE_CLIENT_CERTIFICATE_PATH);

  if (process.env.SKIP_WIN_SIGNING === '1' || process.env.SKIP_WIN_SIGNING === 'true') {
    console.log('[win-sign] SKIP_WIN_SIGNING set — Windows signing disabled.');
    return [];
  }
  if (!haveCreds) {
    console.log(
      '[win-sign] no AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET — Windows signing skipped.',
    );
    return [];
  }

  console.log('[win-sign] Azure credentials present — Windows signing enabled.');
  return [
    // publisherName holds a space ("Brian Bailey"). electron-builder is spawned
    // with shell:true on Windows, so cmd.exe re-splits the argv and yargs sees
    // the surname as a stray positional ("Unknown argument: Bailey"). Quoting
    // keeps the value intact through the shell.
    quoteIfNeeded(`-c.win.publisherName=${AZURE_SIGN.publisherName}`),
    `-c.win.azureSignOptions.endpoint=${AZURE_SIGN.endpoint}`,
    `-c.win.azureSignOptions.codeSigningAccountName=${AZURE_SIGN.codeSigningAccountName}`,
    `-c.win.azureSignOptions.certificateProfileName=${AZURE_SIGN.certificateProfileName}`,
    '-c.win.azureSignOptions.TimestampRfc3161=http://timestamp.acs.microsoft.com',
    '-c.win.azureSignOptions.TimestampDigest=SHA256',
  ];
}

const outputDir = resolveBuildOutputDir();
const forwarded = process.argv.slice(2);

// Windows signing config is only relevant when a Windows target is being built.
// `--mac`/`--linux` runs skip it outright; a bare `npm run release` on the
// Windows runner has no platform flag, so fall back to the host platform.
const targetsWindows =
  forwarded.includes('--win') ||
  (process.platform === 'win32' && !forwarded.some((a) => a === '--mac' || a === '--linux'));

const args = [
  ...forwarded,
  `-c.directories.output=${outputDir}`,
  ...(targetsWindows ? azureSigningArgs() : []),
];

console.log(`electron-builder output dir: ${outputDir}`);

const result = spawnSync('electron-builder', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`failed to run electron-builder: ${result.error.message}`);
  process.exit(1);
}

// Runs even on a failed build — a partially-packaged .app registers too.
unregisterUnpackedApps(outputDir);
process.exit(result.status ?? 1);
