// The bundle staleness check must catch sources that drift WITHOUT a version bump.
//
// `BACKEND_VERSION` only moves when a change breaks the renderer contract, so
// the majority of backend edits leave it untouched. A version-only stamp then
// reports a days-old bundle as current: `check:backend` prints a tick, E2E
// launches happily, and the whole suite exercises Python that is not the Python
// under review — passing green while proving nothing.
//
// That is strictly worse than the stale-VERSION hang the stamp was written to
// catch, because a hang is loud and this is silent. It was observed exactly
// that way: a bundle built 2026-08-22 sailed through the check against sources
// edited 2026-08-23.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { hashBackendSources } from './backend-version.mjs';

const MAIN_PY = join(process.cwd(), 'backend-api', 'main.py');

describe('hashBackendSources', () => {
  it('changes when a bundled source is edited without a version bump', () => {
    // The blind spot itself: BACKEND_VERSION is untouched by this edit.
    const before = hashBackendSources();
    const orig = readFileSync(MAIN_PY);
    try {
      writeFileSync(MAIN_PY, Buffer.concat([orig, Buffer.from('\n# probe\n')]));
      expect(hashBackendSources()).not.toBe(before);
    } finally {
      writeFileSync(MAIN_PY, orig);
    }
    expect(hashBackendSources()).toBe(before);
  });

  it('changes when a source file is ADDED', () => {
    const before = hashBackendSources();
    const probe = join(process.cwd(), 'backend-api', 'zz_hash_probe.py');
    expect(existsSync(probe)).toBe(false);
    try {
      writeFileSync(probe, '# probe\n');
      expect(hashBackendSources()).not.toBe(before);
    } finally {
      if (existsSync(probe)) unlinkSync(probe);
    }
    expect(hashBackendSources()).toBe(before);
  });

  it('changes when a source file is RENAMED but its content is identical', () => {
    // The property that hashing contents ALONE cannot provide: the bytes in the
    // bundle are unchanged, only the module name is, and PyInstaller would
    // produce a different bundle. A content-only digest passes this silently,
    // which is why the path goes into the hash too.
    const before = hashBackendSources();
    const a = join(process.cwd(), 'backend-api', 'zz_probe_a.py');
    const b = join(process.cwd(), 'backend-api', 'zz_probe_b.py');
    const body = '# identical body\n';
    try {
      writeFileSync(a, body);
      const withA = hashBackendSources();
      unlinkSync(a);
      writeFileSync(b, body);
      const withB = hashBackendSources();
      expect(withB).not.toBe(withA);
    } finally {
      for (const f of [a, b]) if (existsSync(f)) unlinkSync(f);
    }
    expect(hashBackendSources()).toBe(before);
  });

  it('changes when the RIEGL reader is edited', () => {
    // The reader lives OUTSIDE backend-api/, in the Docker build context, but a
    // native runtime compiles it into the bundle and runs it as a child of the
    // backend — so an edit changes the shipped binary exactly like an edit to
    // main.py does.
    //
    // It is called out separately because the directory walk above cannot see
    // it, and the hole would be the precise shape this whole check exists to
    // close: the stamp still matching after a reader change, `check:backend`
    // printing a tick, and E2E passing against a bundle built from older code.
    const reader = join(process.cwd(), 'docker', 'riegl', 'rxp_reader.py');
    const before = hashBackendSources();
    const orig = readFileSync(reader);
    try {
      writeFileSync(reader, Buffer.concat([orig, Buffer.from('\n# probe\n')]));
      expect(hashBackendSources()).not.toBe(before);
    } finally {
      writeFileSync(reader, orig);
    }
    expect(hashBackendSources()).toBe(before);
  });

  it('changes when the miss-recovery shim sources are edited', () => {
    // rxp_shim.cpp and rxpshim.def ship as bundle DATA and are compiled on the
    // user's machine on first use. A stale bundle would hand them an older
    // shim source than the reader expects, and the mismatch would surface as a
    // missing ctypes symbol rather than as a staleness message.
    for (const name of ['rxp_shim.cpp', 'rxpshim.def']) {
      const f = join(process.cwd(), 'docker', 'riegl', name);
      const before = hashBackendSources();
      const orig = readFileSync(f);
      try {
        writeFileSync(f, Buffer.concat([orig, Buffer.from('\n; probe\n')]));
        expect(hashBackendSources(), name).not.toBe(before);
      } finally {
        writeFileSync(f, orig);
      }
      expect(hashBackendSources(), name).toBe(before);
    }
  });

  it('ignores dev-only trees that never enter the bundle', () => {
    // research/ and tools/ are not compiled in, so hashing them would force
    // pointless 10-minute rebuilds for changes that cannot affect the binary.
    const before = hashBackendSources();
    const probe = join(process.cwd(), 'backend-api', 'research', 'zz_hash_probe.py');
    try {
      writeFileSync(probe, '# probe\n');
      expect(hashBackendSources()).toBe(before);
    } finally {
      if (existsSync(probe)) unlinkSync(probe);
    }
  });

  it('is stable across repeated calls', () => {
    expect(hashBackendSources()).toBe(hashBackendSources());
  });

  it('returns a full sha256 hex digest', () => {
    expect(hashBackendSources()).toMatch(/^[0-9a-f]{64}$/);
  });
});
