// The Linux build's glibc floor is a property nobody chooses and nobody checks
// by hand, so it drifted and shipped: release.yml builds on ubuntu-24.04, GCC 13
// emits GLIBC_2.38-versioned C23 symbols, and the AppImage stopped running on
// Ubuntu 22.04 (glibc 2.35) while the docs still advertised "most distros".
//
// The failure was silent in the worst way — the app launched, the window opened,
// and only the backend died — and every check we already had passed, because
// release.yml's smoke test launches the bundle on the BUILD runner, where a
// 24.04-built binary works perfectly. A floor only breaks on somebody else's
// machine.
//
// These tests pin the two things that make the guard trustworthy: that it orders
// versions numerically (the trap below), and that it refuses to report a
// confident pass when it hasn't actually measured anything.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkGlibcFloor,
  compareVersions,
  GLIBC_FLOOR,
  isElf,
  maxGlibcVersion,
  parseGlibcVersions,
  scanForGlibc,
  SHIPPED_DIRS,
} from './glibc-floor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Real `objdump -T` output, trimmed. Note GLIBC_2.9 sitting next to GLIBC_2.38
// and the three-component GLIBC_2.2.5 — the shape that breaks string ordering.
const OBJDUMP_T = [
  'libpython3.11.so.1.0:     file format elf64-x86-64',
  '',
  'DYNAMIC SYMBOL TABLE:',
  '0000000000000000      DF *UND*\t0000000000000000  GLIBC_2.2.5 memcpy',
  '0000000000000000      DF *UND*\t0000000000000000  GLIBC_2.38 __isoc23_strtol',
  '0000000000000000      DF *UND*\t0000000000000000  GLIBC_2.9   dup3',
  '0000000000000000      DF *UND*\t0000000000000000  GLIBC_2.34  pthread_create',
  '0000000000000000  w   DF *UND*\t0000000000000000  GLIBC_2.2.5 __cxa_finalize',
  '0000000000001150 g    DF .text\t0000000000000015  Base        PyInit_x',
].join('\n');

describe('compareVersions', () => {
  it('orders glibc versions numerically, not as strings', () => {
    // THE trap this guard exists to survive. Lexically '2.9' > '2.38', so a
    // naive .sort().pop() over a real symbol table picks 2.9 as the maximum and
    // waves a GLIBC_2.38 binary straight through onto an Ubuntu 22.04 machine.
    expect(compareVersions('2.9', '2.38')).toBeLessThan(0);
    expect(compareVersions('2.38', '2.9')).toBeGreaterThan(0);
    expect(compareVersions('2.35', '2.38')).toBeLessThan(0);
    expect(compareVersions('2.38', '2.38')).toBe(0);
  });

  it('compares versions with differing component counts', () => {
    // '2.2.5' is common in the same table as '2.34'; both must order correctly.
    expect(compareVersions('2.2.5', '2.34')).toBeLessThan(0);
    expect(compareVersions('2.2.5', '2.2')).toBeGreaterThan(0);
    expect(compareVersions('2.2', '2.2.0')).toBe(0);
  });
});

describe('parseGlibcVersions', () => {
  it('extracts every distinct GLIBC version from objdump -T output', () => {
    expect(parseGlibcVersions(OBJDUMP_T).sort(compareVersions)).toEqual([
      '2.2.5',
      '2.9',
      '2.34',
      '2.38',
    ]);
  });

  it('ignores non-glibc symbol versions', () => {
    expect(parseGlibcVersions('GLIBCXX_3.4.30 Base GCC_4.2.0')).toEqual([]);
  });

  it('ignores GLIBC tags that carry no dotted version', () => {
    // e.g. GLIBC_ABI_DT_RELR — matching it would parse as NaN and poison the max.
    expect(parseGlibcVersions('GLIBC_ABI_DT_RELR')).toEqual([]);
  });

  it('returns nothing for a binary that references no glibc', () => {
    expect(parseGlibcVersions('DYNAMIC SYMBOL TABLE:\n... PyModule_Create2')).toEqual([]);
  });
});

describe('maxGlibcVersion', () => {
  it('picks the highest version numerically', () => {
    expect(maxGlibcVersion(parseGlibcVersions(OBJDUMP_T))).toBe('2.38');
  });

  it('returns null for an empty list', () => {
    expect(maxGlibcVersion([])).toBeNull();
  });
});

describe('isElf', () => {
  it('accepts a real ELF file and rejects a Mach-O with the same extension', () => {
    // Both are `.so`. Only the magic bytes tell them apart, which is why the
    // check reads the header instead of trusting the filename — the shipped
    // payload is mostly extensionless or versioned (libpython3.11.so.1.0).
    const linuxSo = join(
      __dirname,
      '..',
      'pyhelios',
      'pyhelios',
      '_stub.cpython-312-x86_64-linux-gnu.so',
    );
    const machO = join(__dirname, '..', 'pyhelios', 'pyhelios', '_stub.cpython-312-darwin.so');
    // Guard: these fixtures live in a submodule that may not be initialised.
    try {
      readFileSync(linuxSo);
      readFileSync(machO);
    } catch {
      return; // submodule not checked out
    }
    expect(isElf(linuxSo)).toBe(true);
    expect(isElf(machO)).toBe(false);
  });

  it('rejects text files and missing files without throwing', () => {
    expect(isElf(join(__dirname, '..', 'package.json'))).toBe(false);
    expect(isElf(join(__dirname, 'definitely-not-here.xyz'))).toBe(false);
  });
});

describe('scanForGlibc', () => {
  const tree = {
    '/bundle': ['/bundle/backend', '/bundle/readme.txt', '/bundle/lib.so'],
  };
  const elfFiles = new Set(['/bundle/backend', '/bundle/lib.so']);

  function fakes(versionsByPath) {
    return {
      exists: () => true,
      walk: (d) => tree[d] ?? [],
      elf: (p) => elfFiles.has(p),
      versions: (p) => ({ ok: true, tool: 'objdump', versions: versionsByPath[p] ?? [] }),
    };
  }

  it('skips non-ELF files entirely', () => {
    const r = scanForGlibc(
      ['/bundle'],
      fakes({ '/bundle/backend': ['2.35'], '/bundle/lib.so': ['2.17'] }),
    );
    expect(r.files.map((f) => f.path)).toEqual(['/bundle/backend', '/bundle/lib.so']);
    expect(r.files.map((f) => f.path)).not.toContain('/bundle/readme.txt');
  });

  it('records the highest version each file needs', () => {
    const r = scanForGlibc(
      ['/bundle'],
      fakes({ '/bundle/backend': ['2.2.5', '2.38', '2.9'], '/bundle/lib.so': ['2.17'] }),
    );
    expect(r.files).toContainEqual({ path: '/bundle/backend', version: '2.38' });
  });

  it('reports a missing directory rather than silently scanning nothing', () => {
    const r = scanForGlibc(['/nope'], { ...fakes({}), exists: () => false });
    expect(r.missingDirs).toEqual(['/nope']);
  });
});

describe('checkGlibcFloor', () => {
  const scanOf = (files, extra = {}) => () => ({
    files,
    missingDirs: [],
    toolFound: true,
    ...extra,
  });

  it('skips off Linux without measuring anything', () => {
    const r = checkGlibcFloor({
      platform: 'darwin',
      scan: () => expect.unreachable('must not scan off Linux'),
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('skipped');
  });

  it('passes when everything is at or below the floor', () => {
    const r = checkGlibcFloor({
      platform: 'linux',
      floor: '2.38',
      scan: scanOf([
        { path: '/b/libpython.so', version: '2.38' },
        { path: '/b/lib.so', version: '2.2.5' },
      ]),
    });
    expect(r.ok).toBe(true);
    expect(r.maxVersion).toBe('2.38');
  });

  it('fails and names every file above the floor, with its version', () => {
    const r = checkGlibcFloor({
      platform: 'linux',
      floor: '2.35',
      scan: scanOf([
        { path: '/b/libpython.so', version: '2.38' },
        { path: '/b/ok.so', version: '2.9' },
        { path: '/b/PotreeConverter', version: '2.38' },
      ]),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('over-floor');
    expect(r.maxVersion).toBe('2.38');
    // 2.9 is BELOW 2.35 numerically and must not be reported as an offender.
    expect(r.offenders.map((o) => o.path)).toEqual(['/b/libpython.so', '/b/PotreeConverter']);
    expect(r.message).toContain('GLIBC_2.38');
    expect(r.message).toContain('libpython.so');
  });

  it('says rebuilding will not help, because the build host sets the floor', () => {
    const r = checkGlibcFloor({
      platform: 'linux',
      floor: '2.35',
      scan: scanOf([{ path: '/b/x.so', version: '2.38' }]),
    });
    expect(r.message).toMatch(/will NOT fix this/i);
    expect(r.message).toMatch(/DROPS USERS/i);
  });

  it('refuses to pass when it measured nothing at all', () => {
    // A green tick here would be the exact silent pass this guard exists to
    // prevent: the bundle links libc, so zero glibc references means the
    // measurement broke, not that the binaries are portable.
    const r = checkGlibcFloor({ platform: 'linux', scan: scanOf([]) });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-symbols');
  });

  it('reports missing artifacts rather than passing on an empty tree', () => {
    const r = checkGlibcFloor({
      platform: 'linux',
      scan: () => ({ files: [], missingDirs: ['resources/phytograph_backend'], toolFound: false }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing-dir');
  });

  it('reports a missing binutils rather than passing', () => {
    const r = checkGlibcFloor({
      platform: 'linux',
      scan: () => ({ files: [], missingDirs: [], toolFound: false }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-tool');
  });
});

describe('the declared floor matches what we tell users', () => {
  // GLIBC_FLOOR is not a private build detail — it is the number the install
  // docs quote. If they disagree, one of them is lying to a user deciding
  // whether the app will run on their machine.
  const readDoc = (p) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('README and the install guide state the same floor as the guard', () => {
    expect(GLIBC_FLOOR).toBe('2.38');
    for (const p of ['README.md', 'docs/docs/guide/install.md']) {
      expect(readDoc(p), `${p} must state glibc ${GLIBC_FLOOR}`).toContain(
        `glibc ${GLIBC_FLOOR}`,
      );
    }
  });
});

describe('the release actually runs the check', () => {
  // Source-level chokepoint, same idiom as toolchain-check.test.mjs: a guard
  // that is written but not wired is worse than none, because it reads as
  // covered. Pins both that release.yml invokes it and that it scans the
  // directories that actually ship.
  const release = readFileSync(join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

  it('release.yml invokes the glibc floor check', () => {
    expect(release).toContain('check-glibc-floor.mjs');
  });

  it('the check is not gated on a cache hit', () => {
    // A restored-from-cache artifact built on a different image is precisely
    // what this has to catch, so it must run even when nothing was rebuilt.
    const step = release.slice(release.indexOf('check-glibc-floor.mjs') - 600, release.indexOf('check-glibc-floor.mjs'));
    expect(step).not.toContain("cache-hit != 'true'");
  });

  it('scans both shipped directories', () => {
    expect(SHIPPED_DIRS).toEqual([
      'resources/phytograph_backend',
      'resources/potree_converter',
    ]);
  });
});
