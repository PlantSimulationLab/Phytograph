import { describe, expect, it } from 'vitest';
import { compareVersions, findViolations, parseMinimumVersions } from './check-macos-floor.mjs';

describe('compareVersions', () => {
  it('compares each component numerically, not as text', () => {
    expect(compareVersions('9.0', '14.0')).toBeLessThan(0);
    expect(compareVersions('10.9', '10.15')).toBeLessThan(0);
    expect(compareVersions('15.0', '14.0')).toBeGreaterThan(0);
  });

  it('treats a missing component as zero', () => {
    expect(compareVersions('14', '14.0')).toBe(0);
    expect(compareVersions('10.13.6', '10.13')).toBeGreaterThan(0);
  });
});

describe('parseMinimumVersions', () => {
  it('reads minos from LC_BUILD_VERSION, per slice', () => {
    const out = '      cmd LC_BUILD_VERSION\n platform 1\n    minos 14.0\n      sdk 15.5\n      cmd LC_BUILD_VERSION\n    minos 15.0\n';
    expect(parseMinimumVersions(out)).toEqual(['14.0', '15.0']);
  });

  it('reads version only from LC_VERSION_MIN_MACOSX', () => {
    const out = '      cmd LC_VERSION_MIN_MACOSX\n  version 10.13\n      sdk 11.0\n      cmd LC_SOURCE_VERSION\n  version 1.2.3\n';
    expect(parseMinimumVersions(out)).toEqual(['10.13']);
  });

  it('does not read the SDK version as the minimum', () => {
    expect(parseMinimumVersions('      cmd LC_BUILD_VERSION\n      sdk 26.0\n')).toEqual([]);
  });
});

describe('findViolations', () => {
  it('flags only binaries above the target', () => {
    const entries = [
      { path: 'libhelios.dylib', minimum: '15.0' },
      { path: 'numpy.so', minimum: '14.0' },
      { path: 'python', minimum: '9.0' },
    ];
    expect(findViolations(entries, '14.0').map((e) => e.path)).toEqual(['libhelios.dylib']);
  });
});
