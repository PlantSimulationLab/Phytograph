#!/usr/bin/env node
// Assign the `main` E2E project's spec files to CI shards by MEASURED duration.
//
//   node scripts/e2e-shard.mjs <index> <total>   → prints this shard's file filters
//
// Playwright's own --shard splits by file, balanced on test COUNT, in alphabetical
// order. Count is a poor proxy for cost here, and the alphabet clusters the
// expensive specs (lad-*, qsm-*, synthetic-scan*), so one shard inherited them
// all: 24 / 19 / 46 / 37 summed test-minutes across the four shards, with the
// slowest one the critical path of every CI run.
//
// This packs files longest-first into whichever shard is currently lightest
// (LPT). Besides evening the totals, that deals the most expensive files out one
// per shard before anything else — the opposite of the alphabetical clustering
// that made six shards fail (see the matrix comment in .github/workflows/ci.yml).
//
// Durations come from tests/e2e/shard-timings.json (seconds per spec file),
// refreshed from a green CI run with scripts/e2e-shard-timings.mjs. A file with
// no timing yet (a new spec) counts as the median, so it lands somewhere
// sensible until the next refresh; a stale table only costs balance, never
// coverage — every listed file is assigned to exactly one shard.
//
// The file list comes from Playwright itself (`--list --project=main`), so the
// `heavy` project's exclusions in playwright.config.ts are respected without a
// second copy of them here.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TIMINGS_PATH = join(root, 'tests', 'e2e', 'shard-timings.json');

function median(values) {
  if (values.length === 0) return 1;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Partition `files` into `total` shards, longest first into the lightest shard.
 * Deterministic for a given (files, timings, total): ties break on file name, so
 * every CI shard computes the same plan independently.
 */
export function assignShards(files, timings, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`bad shard total: ${total}`);
  const fallback = median(Object.values(timings));
  const weight = (f) => (Number.isFinite(timings[f]) ? timings[f] : fallback);
  const shards = Array.from({ length: total }, () => ({ seconds: 0, files: [] }));
  const ordered = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const f of ordered) {
    let target = shards[0];
    for (const s of shards) if (s.seconds < target.seconds) target = s;
    target.seconds += weight(f);
    target.files.push(f);
  }
  for (const s of shards) s.files.sort();
  return shards;
}

/**
 * Playwright treats each positional argument as a regular expression matched
 * against the file path, so a bare name over-matches (`scan.spec.ts` would also
 * select `synthetic-scan.spec.ts`). Anchor each one to its full file name.
 */
export function fileFilter(file) {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(^|/)${escaped}$`;
}

function listMainSpecFiles() {
  const out = execFileSync('npx', ['playwright', 'test', '--project=main', '--list', '--reporter=json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const report = JSON.parse(out);
  const files = new Set();
  const walk = (suite) => {
    if (suite.specs?.length) files.add(suite.file);
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return [...files];
}

function main() {
  const [indexArg, totalArg] = process.argv.slice(2);
  const index = Number(indexArg);
  const total = Number(totalArg);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || index > total) {
    console.error('usage: node scripts/e2e-shard.mjs <index 1..total> <total>');
    process.exit(2);
  }
  const timings = JSON.parse(readFileSync(TIMINGS_PATH, 'utf8'));
  const files = listMainSpecFiles();
  if (files.length === 0) {
    console.error('[e2e-shard] Playwright listed no spec files for --project=main');
    process.exit(1);
  }
  const shards = assignShards(files, timings, total);
  const mine = shards[index - 1];
  // An empty filter list would make `playwright test` run the WHOLE project.
  if (mine.files.length === 0) {
    console.error(`[e2e-shard] shard ${index}/${total} was assigned no files`);
    process.exit(1);
  }
  const plan = shards.map((s, i) => `${i + 1}:${(s.seconds / 60).toFixed(1)}m/${s.files.length}f`).join(' ');
  const untimed = files.filter((f) => !Number.isFinite(timings[f]));
  console.error(`[e2e-shard] ${files.length} files, plan (summed test time) ${plan}`);
  if (untimed.length) console.error(`[e2e-shard] untimed (weighted at the median): ${untimed.join(', ')}`);
  console.error(`[e2e-shard] shard ${index}: ${mine.files.join(' ')}`);
  process.stdout.write(mine.files.map(fileFilter).join(' ') + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
