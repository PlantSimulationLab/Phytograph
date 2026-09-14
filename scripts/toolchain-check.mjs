// macOS C++ toolchain preflight for the Helios native build.
//
// WHY THIS EXISTS
//
// A macOS update can leave `xcode-select -p` pointing at an Xcode whose
// `xcrun`/`xcodebuild` shim no longer loads. Observed on macOS 26.6 with Xcode
// 26.6 installed:
//
//   Symbol not found: _XPCTypeBool
//     Referenced from: /Library/Developer/PrivateFrameworks/CoreDevice.framework
//     Expected in:     /Library/Apple/System/Library/PrivateFrameworks/Mercury.framework
//
// `/Library/Developer/PrivateFrameworks/` held Xcode-16-era frameworks (Feb
// 2025) that macOS 26 no longer supports. Because /usr/bin/cc, /usr/bin/clang
// and /usr/bin/c++ are all SHIMS through the active developer dir, every one of
// them failed — and clang, unable to resolve a sysroot, then searched no SDK at
// all. libc++ headers live ONLY in the SDK, so `#include <set>` failed while C
// compiled fine. The Helios build got to 78% (all the C targets: freetype,
// glfw, glew, libjpeg) and died on the first C++ translation unit.
//
// WHY A PRESENCE CHECK IS NOT ENOUGH
//
// build_helios.py probes `gcc --version` then `clang --version`, and on failure
// reports "No suitable compiler found (gcc or clang)". That message is actively
// misleading: three compilers were installed and the Command Line Tools were
// healthy. Every presence-based signal agreed with it and every one was wrong —
// `which clang` found the binary, `pkgutil` reported CLTools_Executables 26.6
// installed, and the CLT installer reported success three times running.
//
// The only signal that told the truth was COMPILING. So this preflight compiles
// a sentinel translation unit that includes <set> — the exact header that
// failed — rather than asking whether a compiler exists. Same lesson as the
// backend bundle's source hash (see CLAUDE.md, Version-lock contract): verify
// the capability, not the artifact's existence.
//
// WHY IT AUTO-RECOVERS INSTEAD OF FAILING
//
// The fix is `sudo xcode-select -s /Library/Developer/CommandLineTools`, which
// needs a password and so cannot run unattended. But DEVELOPER_DIR overrides the
// active developer dir per-process, mutates nothing on the system, and needs no
// sudo. When the active dir is broken and a working CLT is present we build with
// the latter and warn loudly on every build until the machine is fixed
// permanently. A developer who updates macOS on a Friday is not blocked; they
// are told, repeatedly, exactly what to run.
//
// The loop this also breaks: when the broken shim can't resolve a tool it calls
// `xcode-select: Failed to locate 'clang++', requesting installation of command
// line developer tools`, which pops the CLT installer. Every failed compile
// re-triggers it, so reinstalling can never fix it — the pointer is wrong, not
// the payload.
//
// Scope is deliberately macOS-only: `xcode-select` is the mechanism at fault.
// Linux/Windows return { status: 'skipped' }.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const CLT_DIR = '/Library/Developer/CommandLineTools';

// <set> is the header that actually failed, and it is pure libc++ — it exists
// only under the SDK's usr/include/c++/v1, so it is a true test of whether a
// sysroot resolved. A C-only sentinel would have passed the whole outage.
const SENTINEL = '#include <set>\nint main() { return 0; }\n';

// Signature of the broken-shim failure, as distinct from a merely absent
// toolchain. Used only to sharpen the advice we print.
const SHIM_BROKEN_MARKERS = [
  'Error loading required libraries',
  'Symbol not found',
  'failed with exit code',
  'requesting installation of command line developer tools',
];

/**
 * Compile the sentinel and report whether C++ actually works.
 *
 * `developerDir` of null means "exactly what the build gets today" — the
 * ambient environment, honoring any DEVELOPER_DIR the caller already set.
 *
 * Probes `c++` from PATH rather than a hardcoded clang++ because that is what
 * CMake resolves (CMAKE_CXX_COMPILER was /usr/bin/c++ in the failing build), so
 * the preflight and the real build see the same compiler.
 *
 * -fsyntax-only keeps this to well under a second: it resolves headers, which
 * is the whole failure mode, without codegen or linking.
 */
export function probeCxx(developerDir, { spawn = spawnSync } = {}) {
  const env = { ...process.env };
  // Deliberately does NOT clear an ambient DEVELOPER_DIR when probing with
  // null: runStep inherits process.env, so an exported (possibly stale)
  // DEVELOPER_DIR is genuinely part of "what the build gets today" and must be
  // measured, not hidden.
  if (developerDir) env.DEVELOPER_DIR = developerDir;

  const r = spawn('c++', ['-x', 'c++', '-fsyntax-only', '-'], {
    input: SENTINEL,
    env,
    encoding: 'utf8',
  });

  if (r.error) return { ok: false, stderr: r.error.message };
  return { ok: r.status === 0, stderr: (r.stderr || '').trim() };
}

/**
 * Decide what the build should do, given injected probe/exists functions.
 *
 * Pure decision logic — no spawning, no fs — so every branch is unit-testable
 * without a broken machine to reproduce on.
 *
 * Returns { status, ...detail } where status is one of:
 *   'skipped'   — not macOS; nothing to check
 *   'ok'        — the active toolchain compiles C++
 *   'recovered' — active is broken, CLT works; build with developerDir set
 *   'broken'    — nothing compiles; caller should fail with `lines` as the reason
 */
export function diagnoseToolchain({
  platform,
  activeDir,
  probe,
  exists,
  cltDir = CLT_DIR,
}) {
  if (platform !== 'darwin') {
    return { status: 'skipped', reason: `not macOS (${platform})` };
  }

  const active = probe(null);
  if (active.ok) return { status: 'ok', activeDir };

  const shimBroken = SHIM_BROKEN_MARKERS.some((m) => active.stderr.includes(m));

  // Is there a Command Line Tools install at all?
  const cltPresent = exists(join(cltDir, 'usr', 'bin', 'clang'));
  if (!cltPresent) {
    return {
      status: 'broken',
      activeDir,
      activeStderr: active.stderr,
      lines: [
        'C++ toolchain is not usable, and no Command Line Tools install was found.',
        '',
        `  xcode-select -p -> ${activeDir || '(unset)'}`,
        `  compiling '#include <set>' failed:`,
        indent(active.stderr),
        '',
        '  Install the Command Line Tools:',
        '    xcode-select --install',
        '',
        '  Then point the toolchain at them:',
        `    sudo xcode-select -s ${cltDir}`,
      ],
    };
  }

  // CLT is installed. Does building against it work?
  const viaClt = probe(cltDir);
  if (viaClt.ok) {
    return {
      status: 'recovered',
      activeDir,
      developerDir: cltDir,
      activeStderr: active.stderr,
      shimBroken,
      lines: [
        'The active Xcode developer directory is BROKEN — building via the',
        'Command Line Tools instead.',
        '',
        `  xcode-select -p -> ${activeDir || '(unset)'}`,
        `  compiling '#include <set>' there failed:`,
        indent(firstLines(active.stderr, 3)),
        '',
        `  A working toolchain WAS found at ${cltDir},`,
        '  so this build will use it (via DEVELOPER_DIR, this process only).',
        '',
        '  Fix it permanently — one command, needs sudo:',
        `    sudo xcode-select -s ${cltDir}`,
        '',
        ...(shimBroken
          ? [
              '  Do NOT reinstall the Command Line Tools; they are healthy. The',
              '  broken shim re-triggers the CLT installer on every failed compile,',
              '  so reinstalling looks related but cannot fix it.',
              '',
            ]
          : []),
      ],
    };
  }

  // CLT is present but still cannot compile C++. Most likely a damaged install:
  // the libc++ headers ship in the SDK, so check whether they are actually there.
  const sdkHeader = join(cltDir, 'SDKs', 'MacOSX.sdk', 'usr', 'include', 'c++', 'v1', 'set');
  const headersPresent = exists(sdkHeader);

  return {
    status: 'broken',
    activeDir,
    activeStderr: active.stderr,
    cltStderr: viaClt.stderr,
    headersPresent,
    lines: [
      'C++ toolchain is not usable, and the Command Line Tools fallback also failed.',
      '',
      `  xcode-select -p -> ${activeDir || '(unset)'}`,
      indent(firstLines(active.stderr, 3)),
      '',
      `  ${cltDir} also failed:`,
      indent(firstLines(viaClt.stderr, 3)),
      '',
      ...(headersPresent
        ? [
            `  The libc++ headers ARE present (${sdkHeader}),`,
            '  so this is not a missing-headers problem. Check whether DEVELOPER_DIR',
            '  or CPATH/SDKROOT are set to something stale in your shell.',
          ]
        : [
            '  The libc++ headers are MISSING from the SDK:',
            `    ${sdkHeader}`,
            '  That means the Command Line Tools install is incomplete. Reinstall:',
            `    sudo rm -rf ${cltDir}`,
            '    sudo xcode-select --install',
          ]),
    ],
  };
}

function indent(text) {
  return String(text)
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

function firstLines(text, n) {
  return String(text).split('\n').slice(0, n).join('\n');
}

/** Run the real check against this machine. */
export function checkToolchain({ platform = process.platform } = {}) {
  const activeDir =
    platform === 'darwin'
      ? (spawnSync('xcode-select', ['-p'], { encoding: 'utf8' }).stdout || '').trim()
      : '';
  return diagnoseToolchain({
    platform,
    activeDir,
    probe: (dir) => probeCxx(dir),
    exists: existsSync,
  });
}

/**
 * Print the result and return the DEVELOPER_DIR the build should use (or null).
 * Exits 1 on 'broken'.
 */
export function applyToolchainCheck(tag = 'toolchain') {
  const result = checkToolchain();
  const bar = '='.repeat(74);
  const say = (l) => console.log(`[${tag}] ${l}`);

  if (result.status === 'skipped' || result.status === 'ok') return null;

  if (result.status === 'broken') {
    console.error(`\n${bar}`);
    console.error(`[${tag}] FATAL: C++ toolchain check failed`);
    console.error(bar);
    for (const l of result.lines) console.error(l);
    console.error(bar);
    process.exit(1);
  }

  console.log(`\n${bar}`);
  say('WARNING: active developer directory is BROKEN');
  console.log(bar);
  for (const l of result.lines) console.log(l);
  console.log(bar + '\n');
  return result.developerDir;
}

// `npm run check:toolchain` — run it directly any time; it is one -fsyntax-only
// compile, so it costs well under a second.
if (process.argv[1] && process.argv[1].endsWith('toolchain-check.mjs')) {
  const dir = applyToolchainCheck('check:toolchain');
  if (dir) {
    console.log(`[check:toolchain] usable via DEVELOPER_DIR=${dir} (machine still needs the fix above)`);
  } else {
    const r = checkToolchain();
    console.log(
      r.status === 'skipped'
        ? `[check:toolchain] skipped: ${r.reason}`
        : `[check:toolchain] OK — C++ compiles (xcode-select -p -> ${r.activeDir})`,
    );
  }
}
