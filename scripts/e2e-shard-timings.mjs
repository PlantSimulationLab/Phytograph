#!/usr/bin/env node
// Refresh tests/e2e/shard-timings.json from a GREEN CI run's E2E shard logs.
//
//   node scripts/e2e-shard-timings.mjs <ci-run-id>
//
// Sums each spec file's per-test durations as the Playwright list reporter
// printed them in the `e2e (N)` jobs. Use a green run: a failed test's duration
// is its timeout, not its cost. Re-run whenever the plan printed by
// scripts/e2e-shard.mjs drifts far from what the shards actually take, or after
// adding expensive specs (new files are weighted at the median until then).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TIMINGS_PATH } from './e2e-shard.mjs';

const UNIT_SECONDS = { ms: 0.001, s: 1, m: 60 };

/**
 * Parse `gh run view --log` output into { "<file>.spec.ts": seconds }.
 * Durations print as `(512ms)`, `(3.4s)` or — past a minute — `(1.2m)`; missing
 * the last form silently drops exactly the most expensive specs.
 */
export function parseShardLog(log) {
  const totals = {};
  const line = /^e2e \(\d+\)\t.*?[✓✘-] +\d+ \[main\] › (?:.*\/)?([^/\s:]+\.spec\.ts):\d+.*\(([\d.]+)(ms|s|m)\)\s*$/;
  for (const raw of log.split('\n')) {
    const m = line.exec(raw);
    if (!m) continue;
    totals[m[1]] = (totals[m[1]] ?? 0) + Number(m[2]) * UNIT_SECONDS[m[3]];
  }
  return Object.fromEntries(
    Object.keys(totals).sort().map((f) => [f, Math.round(totals[f] * 10) / 10]),
  );
}

function main() {
  const runId = process.argv[2];
  if (!runId) {
    console.error('usage: node scripts/e2e-shard-timings.mjs <ci-run-id>');
    process.exit(2);
  }
  const log = execFileSync('gh', ['run', 'view', runId, '--log'], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  const timings = parseShardLog(log);
  const n = Object.keys(timings).length;
  if (n === 0) {
    console.error(`[e2e-shard-timings] no E2E test lines found in run ${runId}`);
    process.exit(1);
  }
  writeFileSync(TIMINGS_PATH, JSON.stringify(timings, null, 2) + '\n');
  const minutes = Object.values(timings).reduce((a, b) => a + b, 0) / 60;
  console.log(`[e2e-shard-timings] ${n} spec files, ${minutes.toFixed(1)} summed test-minutes -> ${TIMINGS_PATH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
