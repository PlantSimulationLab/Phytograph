// The toolchain preflight must diagnose a broken xcode-select pointer, because
// every cheaper signal lies about it.
//
// Reproduced on macOS 26.6: `xcode-select -p` pointed at an Xcode whose xcrun
// shim failed to load (stale Xcode-16-era frameworks in
// /Library/Developer/PrivateFrameworks). /usr/bin/{cc,clang,c++} are shims
// through that dir, so all three failed; clang resolved no sysroot; libc++ lives
// only in the SDK; `#include <set>` failed while every C target compiled.
//
// What made it expensive was that the honest-looking signals all passed:
// `which clang` found the binary, `pkgutil` reported CLTools_Executables 26.6
// installed, and the CLT installer reported success three times. build_helios.py
// probes `gcc --version` / `clang --version` and concluded "No suitable compiler
// found (gcc or clang)" on a machine with three compilers and a healthy CLT.
// Reinstalling could never help — the pointer was wrong, not the payload — and
// each failed compile re-popped the installer, so the loop was self-sustaining.
//
// These tests inject the probe/exists functions so every branch is exercised
// without needing a broken machine to reproduce on.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLT_DIR, diagnoseToolchain, probeCxx } from './toolchain-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The exact stderr the broken shim produced.
const SHIM_STDERR = [
  'Error loading required libraries. If there is an ongoing installation please wait for it to complete.',
  'dlopen(@rpath/libxcodebuildLoader.dylib, 0x0001): Symbol not found: _XPCTypeBool',
  "xcode-select: Failed to locate 'clang++', requesting installation of command line developer tools.",
].join('\n');

const XCODE_DIR = '/Applications/Xcode.app/Contents/Developer';

/** probe that fails for the ambient env and succeeds only for `workingDir`. */
function probeWhereOnly(workingDir) {
  return (dir) =>
    dir === workingDir ? { ok: true, stderr: '' } : { ok: false, stderr: SHIM_STDERR };
}

describe('diagnoseToolchain', () => {
  it('skips on non-macOS, where xcode-select is not the mechanism', () => {
    const r = diagnoseToolchain({
      platform: 'linux',
      activeDir: '',
      probe: () => expect.unreachable('must not probe off macOS'),
      exists: () => expect.unreachable('must not touch fs off macOS'),
    });
    expect(r.status).toBe('skipped');
  });

  it('passes when the active toolchain compiles C++', () => {
    const r = diagnoseToolchain({
      platform: 'darwin',
      activeDir: CLT_DIR,
      probe: () => ({ ok: true, stderr: '' }),
      exists: () => true,
    });
    expect(r.status).toBe('ok');
  });

  it('recovers via the Command Line Tools when the active Xcode dir is broken', () => {
    const r = diagnoseToolchain({
      platform: 'darwin',
      activeDir: XCODE_DIR,
      probe: probeWhereOnly(CLT_DIR),
      exists: () => true,
    });

    expect(r.status).toBe('recovered');
    // The build must be told which dir to use, or the fallback does nothing.
    expect(r.developerDir).toBe(CLT_DIR);

    const text = r.lines.join('\n');
    // The permanent fix has to be spelled out; it needs sudo, so we can't run it.
    expect(text).toContain(`sudo xcode-select -s ${CLT_DIR}`);
    // The active dir must be named — "toolchain broken" alone sent a developer
    // reinstalling CLT three times.
    expect(text).toContain(XCODE_DIR);
  });

  it('tells the user NOT to reinstall CLT when the shim signature is present', () => {
    // The whole trap: the broken shim pops the CLT installer on every failed
    // compile, so reinstalling looks like the indicated fix and never works.
    const r = diagnoseToolchain({
      platform: 'darwin',
      activeDir: XCODE_DIR,
      probe: probeWhereOnly(CLT_DIR),
      exists: () => true,
    });
    expect(r.shimBroken).toBe(true);
    expect(r.lines.join('\n')).toMatch(/Do NOT reinstall/i);
  });

  it('tells the user to INSTALL the tools when no CLT exists at all', () => {
    const r = diagnoseToolchain({
      platform: 'darwin',
      activeDir: XCODE_DIR,
      probe: () => ({ ok: false, stderr: SHIM_STDERR }),
      exists: () => false, // nothing on disk
    });

    expect(r.status).toBe('broken');
    const text = r.lines.join('\n');
    expect(text).toContain('xcode-select --install');
    // Must not advise reinstalling something that was never there.
    expect(text).not.toMatch(/Do NOT reinstall/i);
  });

  it('diagnoses a DAMAGED CLT install when its libc++ headers are missing', () => {
    // The state the machine was left in by a partial install: clang present,
    // SDK present, but usr/include/c++/v1 gutted (11 entries, then 0).
    const sdkHeader = join(CLT_DIR, 'SDKs', 'MacOSX.sdk', 'usr', 'include', 'c++', 'v1', 'set');
    const r = diagnoseToolchain({
      platform: 'darwin',
      activeDir: XCODE_DIR,
      probe: () => ({ ok: false, stderr: "fatal error: 'set' file not found" }),
      exists: (p) => p !== sdkHeader, // clang exists, the header does not
    });

    expect(r.status).toBe('broken');
    expect(r.headersPresent).toBe(false);
    const text = r.lines.join('\n');
    expect(text).toContain(sdkHeader);
    expect(text).toContain(`sudo rm -rf ${CLT_DIR}`);
  });

  it('does not blame missing headers when the headers are in fact present', () => {
    const r = diagnoseToolchain({
      platform: 'darwin',
      activeDir: XCODE_DIR,
      probe: () => ({ ok: false, stderr: 'some other failure' }),
      exists: () => true, // clang AND headers present, still fails
    });

    expect(r.status).toBe('broken');
    expect(r.headersPresent).toBe(true);
    const text = r.lines.join('\n');
    expect(text).not.toContain('sudo rm -rf');
    expect(text).toMatch(/DEVELOPER_DIR|SDKROOT|CPATH/);
  });
});

describe('probeCxx', () => {
  it('compiles a C++-ONLY sentinel, not a C one', () => {
    // The failure compiled every C target (freetype, glfw, glew, libjpeg) and
    // died only on C++. A sentinel without a libc++ header would have passed
    // clean through the entire outage.
    let captured;
    probeCxx(null, {
      spawn: (_cmd, _args, opts) => {
        captured = opts;
        return { status: 0, stderr: '' };
      },
    });
    expect(captured.input).toContain('#include <set>');
  });

  it('sets DEVELOPER_DIR when given one, and clears it when probing the ambient env', () => {
    let env;
    const spawn = (_c, _a, o) => {
      env = o.env;
      return { status: 0, stderr: '' };
    };

    probeCxx(CLT_DIR, { spawn });
    expect(env.DEVELOPER_DIR).toBe(CLT_DIR);

    // Probing with null means "what the build gets today", and runStep inherits
    // process.env — so an exported DEVELOPER_DIR is part of the real build
    // environment and must be measured. Clearing it here would hide a developer
    // whose shell exports a stale/broken one.
    process.env.DEVELOPER_DIR = '/some/stale/dir';
    try {
      probeCxx(null, { spawn });
      expect(env.DEVELOPER_DIR).toBe('/some/stale/dir');
    } finally {
      delete process.env.DEVELOPER_DIR;
    }
  });

  it('reports failure rather than throwing when no compiler can be spawned', () => {
    const r = probeCxx(null, {
      spawn: () => ({ error: new Error('spawn c++ ENOENT') }),
    });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('ENOENT');
  });
});

describe('the build actually runs the check', () => {
  // Source-level chokepoint, same reasoning as user-data-isolation.test.mjs:
  // dropping the call reopens the bad error message silently — the build still
  // succeeds on every healthy machine, and the damage only lands on whoever
  // updates macOS next.
  const src = readFileSync(join(__dirname, 'build-pyhelios.mjs'), 'utf8');

  it('build-pyhelios.mjs calls the preflight', () => {
    expect(src).toContain('applyToolchainCheck');
  });

  it('build-pyhelios.mjs passes the recovered DEVELOPER_DIR to its child steps', () => {
    // Detecting the broken dir is useless if the compile children don't get it.
    expect(src).toMatch(/DEVELOPER_DIR:\s*toolchainDeveloperDir/);
  });
});
