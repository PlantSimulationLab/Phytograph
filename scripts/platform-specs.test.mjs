// Pins tests/e2e/platform-specs.json — the list of E2E specs that run on real
// Windows and macOS runners (see .github/workflows/platform.yml).
//
// Why this guard exists: the list selects specs by PATH, and a path list has one
// failure mode that a per-test tag does not — rename or move a spec and it drops
// out of cross-platform coverage silently. Nothing goes red. The subset just
// quietly gets smaller, which is the worst way to lose test coverage because it
// looks exactly like everything passing.
//
// Playwright cannot catch it either: an unmatched testMatch glob is not an
// error, it simply selects nothing. So the existence check has to live here.
//
// Runs under Vitest via the `scripts/**/*.test.mjs` include in vitest.config.ts,
// i.e. in the ~1 minute `quick` CI job — a broken list fails there rather than
// 20 minutes into a macOS runner.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = join(repoRoot, 'tests', 'e2e', 'platform-specs.json');

const contract = JSON.parse(readFileSync(contractPath, 'utf-8'));
const specs = contract.groups.flatMap((g) => g.specs);

describe('platform-specs.json', () => {
  it('lists at least one spec in every group, each with a rationale', () => {
    expect(contract.groups.length).toBeGreaterThan(0);
    for (const group of contract.groups) {
      // The `why` is not decoration: this list should stay small, and the bar
      // for adding to it is being able to say what Linux cannot check.
      expect(group.why, `group missing "why": ${JSON.stringify(group.specs)}`).toBeTruthy();
      expect(group.specs.length).toBeGreaterThan(0);
    }
  });

  it('every listed spec exists on disk', () => {
    const missing = specs.filter((s) => !existsSync(join(repoRoot, 'tests', 'e2e', s)));
    expect(
      missing,
      `platform-specs.json references spec files that do not exist: ${missing.join(', ')}. ` +
        'A rename drops the spec out of Windows/macOS coverage without failing anything, ' +
        'so fix the list rather than deleting the entry.',
    ).toEqual([]);
  });

  it('lists no spec twice', () => {
    const dupes = specs.filter((s, i) => specs.indexOf(s) !== i);
    expect(dupes, `duplicated entries: ${dupes.join(', ')}`).toEqual([]);
  });

  it('names only .spec.ts files, without directory components', () => {
    // The config turns each entry into `**/<entry>`, so a path prefix here would
    // silently match nothing.
    const malformed = specs.filter((s) => !s.endsWith('.spec.ts') || s.includes('/'));
    expect(malformed, `entries must be bare *.spec.ts basenames: ${malformed.join(', ')}`).toEqual([]);
  });

  it('excludes the heavy-project specs, which run only on Linux', () => {
    // playwright.config.ts's `heavy` project asserts absolute heap ceilings and
    // needs a runner to itself. The platform project has no such isolation, and
    // the macOS runner has 7 GB, so these must not leak into the subset.
    const heavy = ['crop-octree-100m.spec.ts', 'import-cancel.spec.ts', 'zoom-large-cloud.spec.ts'];
    const leaked = specs.filter((s) => heavy.includes(s));
    expect(leaked, `heavy specs must not be in the platform subset: ${leaked.join(', ')}`).toEqual([]);
  });
});
