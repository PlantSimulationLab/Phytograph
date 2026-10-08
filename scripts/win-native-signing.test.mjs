// Every native library in the Windows app must ship SIGNED, not just the
// executables.
//
// electron-builder signs .exe files and nothing else, so for a long time the
// installer and both sidecar .exe files were signed while every .pyd/.dll
// inside the PyInstaller bundle was not. Windows application control (Smart App
// Control, WDAC, AppLocker) judges each library as it loads: issue #6 was a
// signed phytograph_backend.exe that started and then died at `import pandas`
// with "An Application Control policy has blocked this file", on every launch.
//
// This is a SOURCE-level guard because nothing else can fail. The build runner
// enforces no such policy, so the backend and packaged-app smoke tests load
// unsigned libraries happily — dropping a signing step leaves the release
// green and breaks only on a user's machine.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { AZURE_SIGN, azureSigningDecision } from './azure-sign-config.mjs';

const repoRoot = process.cwd();
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');

const workflow = read('.github', 'workflows', 'release.yml');
const pkg = JSON.parse(read('package.json'));

/** The text of one workflow step, from its `- name:` line to the next step. */
function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  if (start < 0) return null;
  const next = workflow.indexOf('\n      - name: ', start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
}

// Comment lines explain the history, so assertions about behavior read CODE.
const codeOnly = (src) => src.replace(/^\s*#.*$/gm, '');

const script = codeOnly(read('scripts', 'sign-win-natives.ps1'));

describe('release.yml signs the sidecars’ native libraries', () => {
  const sign = step('Sign bundled native libraries (Windows)');

  it('has the signing step, on Windows whenever the Azure secrets exist', () => {
    expect(sign).toBeTruthy();
    // A condition that quietly stops matching skips signing and stays green.
    expect(sign).toContain("if: runner.os == 'Windows' && env.AZURE_CLIENT_ID != ''");
  });

  it('runs it BEFORE electron-builder packages the installer', () => {
    // After would be too late twice over: the files are already inside the
    // installer, and the installer's hash is already in latest.yml.
    const signAt = workflow.indexOf('- name: Sign bundled native libraries (Windows)');
    const buildAt = workflow.indexOf('- name: Build & publish app');
    expect(signAt).toBeGreaterThan(0);
    expect(buildAt).toBeGreaterThan(signAt);
  });

  it('signs both sidecars with the shared script and reports its exit code', () => {
    const code = codeOnly(sign);
    expect(code).toMatch(
      /sign-win-natives\.ps1 -Roots resources\/phytograph_backend, resources\/potree_converter\s+exit \$LASTEXITCODE/,
    );
    expect(code).not.toContain('-VerifyOnly');
  });

  it('launches the backend only after its libraries were signed, and before publishing', () => {
    // The signed bytes are the ones that ship; the packaged-app smoke test that
    // would otherwise be first to load them runs after `--publish always`.
    const signAt = workflow.indexOf('- name: Sign bundled native libraries (Windows)');
    const smokeAt = workflow.indexOf('- name: Smoke-test backend (Windows)');
    const buildAt = workflow.indexOf('- name: Build & publish app');
    expect(smokeAt).toBeGreaterThan(signAt);
    expect(buildAt).toBeGreaterThan(smokeAt);
    expect(workflow.split('- name: Smoke-test backend (Windows)').length).toBe(2);
  });
});

describe('sign-win-natives.ps1', () => {
  it('finds libraries by PE header, not by extension or directory', () => {
    // An extension list scoped to the sidecars is how Electron's own DLLs
    // shipped unsigned under a step that reported success.
    expect(script).toMatch(/Where-Object \{[^}]*Test-PeImage \$_\.FullName/);
    expect(script).not.toMatch(/'\.pyd'|'\.dll'/);
  });

  it('leaves executables to electron-builder unless asked to verify them', () => {
    expect(script).toMatch(/\$IncludeExe -or \$_\.Extension -ne '\.exe'/);
  });

  it('treats a missing root or one with no native libraries as a failure, per root', () => {
    const loop = script.slice(script.indexOf('foreach ($root in $Roots)'));
    expect(loop).toMatch(/-not \(Test-Path -LiteralPath \$root\)\) \{\s*Write-Host "FAIL[^\n]*\s*exit 1/);
    expect(loop).toMatch(/\$found\.Count -eq 0\) \{\s*Write-Host "FAIL[^\n]*\s*exit 1/);
  });

  it('asks signtool for an EMBEDDED, timestamped signature', () => {
    // /pa without /a ignores catalogs (which stay on the build machine); /tw
    // makes a missing timestamp a non-zero exit. Get-AuthenticodeSignature
    // answered for the catalog on the first real run.
    expect(script).toMatch(/verify \/pa \/tw \/q \$path/);
    expect(script).not.toMatch(/verify [^\n]*\/a\b/);
  });

  it('signs only files with no valid signature, so a vendor keeps its own', () => {
    expect(script).toMatch(/\$todo = @\(\$entries \| Where-Object \{ \$_\.State -eq 'none' \}\)/);
  });

  it('never accepts an untimestamped signature of OUR OWN', () => {
    // Azure certificates last 72 hours; an untimestamped signature dies with them.
    expect(script).toMatch(/\$entry\.Subject -notmatch \[regex\]::Escape\(\$ourCn\)/);
    expect(script).toMatch(/-TimestampRfc3161 \$cfg\.timestampRfc3161/);
    expect(script).toMatch(/-TimestampDigest \$cfg\.timestampDigest/);
  });

  it('re-reads what it signed instead of trusting the exit code, even when the signer throws', () => {
    expect(script).toMatch(/catch \{\s*\$signError = \$_/);
    expect(script).toMatch(/\$still = @\(\$remaining \| ForEach-Object \{ Get-Entry \$_\.File \}/);
    expect(script).toMatch(/if \(\$remaining\.Count -gt 0\) \{[\s\S]*?Write-Host "FAIL[^\n]*\s*exit 1/);
  });

  it('resumes after a failed pass, and gives up when passes stop making progress', () => {
    // signtool abandons the rest of the list at the first file Azure fails;
    // the first real run lost 354 of 372 files to one failed request.
    expect(script).toMatch(
      /while \(\$remaining\.Count -gt 0 -and \$pass -lt \$maxPasses -and \$stalled -lt 2\)/,
    );
    expect(script).toMatch(/if \(\$done -eq 0\) \{ \$stalled\+\+ \} else \{ \$stalled = 0 \}/);
    // A cut-short pass must be visible, not absorbed.
    expect(script).toMatch(/::warning title=Windows signing pass/);
  });

  it('verify-only fails on any unacceptable file and signs nothing', () => {
    const verifyAt = script.indexOf('if ($VerifyOnly)');
    const signAt = script.indexOf('Invoke-TrustedSigning');
    expect(verifyAt).toBeGreaterThan(0);
    expect(signAt).toBeGreaterThan(verifyAt);
    // The block ends in an unconditional exit, so nothing below it can run.
    const block = script.slice(verifyAt, script.indexOf('$todo = @(', verifyAt));
    expect(block).toMatch(/\$bad\.Count -gt 0\) \{[\s\S]*exit 1/);
    expect(block).toMatch(/exit 0\s*\}\s*$/);
  });

  it('reads the account from azure-sign-config.mjs', () => {
    expect(script).toContain("node (Join-Path $PSScriptRoot 'azure-sign-config.mjs')");
  });
});

describe('the afterPack hook signs what only exists inside electron-builder', () => {
  const require = createRequire(import.meta.url);
  const hook = require('./after-pack-win-sign.cjs');
  const realRun = hook._run;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const creds = { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' };

  /** Run the hook as if on `platform` with `env`; returns the commands it ran. */
  async function runHook({ platform = 'win32', target = 'win32', env = creds, status = 0 } = {}) {
    const calls = [];
    hook._run = (command, args) => {
      calls.push({ command, args });
      return { status };
    };
    const saved = { ...process.env };
    for (const k of [...Object.keys(creds), 'SKIP_WIN_SIGNING', 'AZURE_CLIENT_CERTIFICATE_PATH']) {
      delete process.env[k];
    }
    Object.assign(process.env, env);
    Object.defineProperty(process, 'platform', { value: platform });
    try {
      await hook.default({ electronPlatformName: target, appOutDir: 'C:\\out\\win-unpacked' });
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      hook._run = realRun;
    }
    return calls;
  }

  it('is registered in package.json', () => {
    expect(pkg.build.afterPack).toBe('scripts/after-pack-win-sign.cjs');
  });

  it('signs the WHOLE unpacked app, so Electron’s DLLs are covered', async () => {
    const calls = await runHook();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('pwsh');
    const args = calls[0].args;
    expect(args[args.indexOf('-File') + 1]).toMatch(/sign-win-natives\.ps1$/);
    expect(args[args.indexOf('-Roots') + 1]).toBe('C:\\out\\win-unpacked');
    expect(args).not.toContain('-VerifyOnly');
  });

  it('stops electron-builder when signing fails', async () => {
    // A resolved hook lets the build go on to package and publish.
    await expect(runHook({ status: 1 })).rejects.toThrow(/signing native libraries failed/);
  });

  it('does nothing for a macOS or Linux target', async () => {
    expect(await runHook({ target: 'darwin', platform: 'darwin' })).toHaveLength(0);
    expect(await runHook({ target: 'linux', platform: 'linux' })).toHaveLength(0);
  });

  it('does nothing without credentials, so a local build still packages', async () => {
    expect(await runHook({ env: {} })).toHaveLength(0);
    expect(await runHook({ env: { ...creds, SKIP_WIN_SIGNING: '1' } })).toHaveLength(0);
  });
});

describe('release.yml verifies the PACKAGED app', () => {
  const verify = codeOnly(step('Verify Windows signature') ?? '');

  it('checks every native library in the unpacked app, executables included', () => {
    expect(verify).toMatch(/sign-win-natives\.ps1 -Roots \$unpacked -VerifyOnly -IncludeExe/);
  });

  it('fails the step when that check fails', () => {
    expect(verify).toMatch(
      /-VerifyOnly -IncludeExe\s+if \(\$LASTEXITCODE -ne 0\) \{ \$ok = \$false \}/,
    );
    expect(verify).toMatch(/if \(-not \$ok\) \{ exit 1 \}/);
  });
});

describe('a release can be rehearsed without publishing', () => {
  it('dry_run builds with --publish never', () => {
    const build = step('Build & publish app');
    expect(workflow).toMatch(/\n      dry_run:\n/);
    expect(build).toContain("inputs.dry_run && 'package -- --publish never' || 'release --'");
    expect(pkg.scripts.package).not.toContain('--publish');
  });

  it('dry_run touches no existing release', () => {
    const job = (name) => workflow.slice(workflow.indexOf(`\n  ${name}:\n`));
    expect(job('merge-latest-mac')).toMatch(/\n    if: always\(\) && !inputs\.dry_run\n/);
    expect(job('prune-old-releases')).toMatch(/\n    if: [^\n]*!inputs\.dry_run/);
  });
});

describe('one signing account for both signers', () => {
  it('both signers decide WHETHER to sign with the same function', () => {
    expect(read('scripts', 'run-electron-builder.mjs')).toContain('azureSigningDecision(process.env)');
    expect(read('scripts', 'after-pack-win-sign.cjs')).toContain('azureSigningDecision(process.env)');
    expect(azureSigningDecision({}).enabled).toBe(false);
    expect(
      azureSigningDecision({ AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' })
        .enabled,
    ).toBe(true);
  });

  it('electron-builder reads the same module rather than its own copy', () => {
    const builder = read('scripts', 'run-electron-builder.mjs');
    expect(builder).toMatch(/import \{ AZURE_SIGN, azureSigningDecision \} from '\.\/azure-sign-config\.mjs'/);
    expect(builder).not.toMatch(/const AZURE_SIGN\s*=/);
  });

  it('the shared config carries everything both signers need', () => {
    for (const key of [
      'endpoint',
      'codeSigningAccountName',
      'certificateProfileName',
      'publisherName',
      'timestampRfc3161',
      'timestampDigest',
    ]) {
      expect(AZURE_SIGN[key], key).toBeTruthy();
    }
  });

  it('the verify step expects the publisher the config signs as', () => {
    expect(step('Verify Windows signature')).toContain(`'CN=${AZURE_SIGN.publisherName}'`);
  });
});

describe('package.json', () => {
  // The batch script is the signer. Turning these on as well would sign every
  // library a second time, one Azure round trip per file, inside a build step
  // with a 45-minute timeout.
  it('does not also ask electron-builder to sign libraries one at a time', () => {
    expect(pkg.build.win.signDlls).toBeUndefined();
    expect(pkg.build.win.signExts).toBeUndefined();
  });
});
