// Pins scripts/e2e-shard.mjs + e2e-shard-timings.mjs: every spec file runs in
// exactly one shard, the split is balanced by measured time and deterministic,
// the file filters cannot over-match, and the CI job actually uses the plan.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assignShards, fileFilter } from './e2e-shard.mjs';
import { parseShardLog } from './e2e-shard-timings.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const timings = JSON.parse(readFileSync(join(root, 'tests', 'e2e', 'shard-timings.json'), 'utf8'));
const files = Object.keys(timings);
const total = (shard) => shard.files.reduce((s, f) => s + (timings[f] ?? 0), 0);

describe('assignShards', () => {
  it('puts every file in exactly one shard', () => {
    const shards = assignShards([...files, 'brand-new.spec.ts'], timings, 4);
    const all = shards.flatMap((s) => s.files);
    expect(all).toHaveLength(files.length + 1);
    expect(new Set(all).size).toBe(all.length);
  });

  it('balances the measured table to within 5% of the ideal shard', () => {
    const shards = assignShards(files, timings, 4);
    const ideal = files.reduce((s, f) => s + timings[f], 0) / 4;
    for (const s of shards) expect(Math.abs(total(s) - ideal) / ideal).toBeLessThan(0.05);
  });

  it('deals the most expensive files out one per shard', () => {
    // The six-shard failure was the heavy specs landing TOGETHER (ci.yml).
    const top = [...files].sort((a, b) => timings[b] - timings[a]).slice(0, 4);
    const shards = assignShards(files, timings, 4);
    const homes = top.map((f) => shards.findIndex((s) => s.files.includes(f)));
    expect(new Set(homes).size).toBe(4);
  });

  it('is deterministic whatever order the files are listed in', () => {
    const a = assignShards(files, timings, 4).map((s) => s.files);
    const b = assignShards([...files].reverse(), timings, 4).map((s) => s.files);
    expect(b).toEqual(a);
  });

  it('weights an untimed file at the median rather than zero', () => {
    const t = { 'a.spec.ts': 10, 'b.spec.ts': 20, 'c.spec.ts': 30 };
    const shards = assignShards(['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'new.spec.ts'], t, 2);
    // Median 20: c | b+new, then a joins c -> 40/40. Weighted at zero it would
    // be 30/30 with the new file dumped wherever ties fell.
    expect(shards.map((s) => s.seconds)).toEqual([40, 40]);
  });
});

describe('fileFilter', () => {
  it('matches only its own file, never a longer name ending the same way', () => {
    const re = new RegExp(fileFilter('scan.spec.ts'));
    expect(re.test('/repo/tests/e2e/scan.spec.ts')).toBe(true);
    expect(re.test('/repo/tests/e2e/synthetic-scan.spec.ts')).toBe(false);
    expect(re.test('/repo/tests/e2e/scanXspec.ts')).toBe(false);
  });
});

describe('parseShardLog', () => {
  it('reads ms, s and m durations and sums per file', () => {
    const log = [
      'e2e (1)\tE2E tests (Playwright + Electron)\t2026-09-29T22:02:15.2Z   ✓   1 [main] › tests/e2e/a.spec.ts:10:1 › one (512ms)',
      'e2e (1)\tE2E tests (Playwright + Electron)\t2026-09-29T22:02:16.2Z   ✓   2 [main] › tests/e2e/a.spec.ts:20:1 › two (3.5s)',
      'e2e (3)\tE2E tests (Playwright + Electron)\t2026-09-29T22:02:17.2Z   ✓  40 [main] › tests/e2e/b.spec.ts:5:3 › group › long (1.5m)',
      'e2e-heavy\tE2E tests (Playwright + Electron)\t2026-09-29T22:02:18.2Z   ✓   1 [heavy] › tests/e2e/c.spec.ts:5:1 › heavy (9.0s)',
    ].join('\n');
    expect(parseShardLog(log)).toEqual({ 'a.spec.ts': 4, 'b.spec.ts': 90 });
  });
});

describe('CI wiring', () => {
  it('the sharded E2E job runs the measured plan, not Playwright --shard', () => {
    const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/node scripts\/e2e-shard\.mjs \$\{\{ matrix\.shard \}\} \$\{\{ strategy\.job-total \}\}/);
    expect(ci).not.toMatch(/--shard=/);
  });
});
