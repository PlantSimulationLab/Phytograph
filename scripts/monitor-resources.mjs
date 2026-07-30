#!/usr/bin/env node
/**
 * Sample system + per-process resource usage while a command runs.
 *
 * Built for "does the E2E suite bog down this machine, and which spec does it":
 *
 *   node scripts/monitor-resources.mjs -- npm run test:e2e
 *   npm run test:e2e:profile          # same thing, plus per-spec attribution
 *
 * With no `--` command it samples until Ctrl-C, which is handy for profiling a
 * manual `npm run dev` session.
 *
 * Everything here is sudo-free and macOS-native:
 *   - `ps`     → per-process cumulative CPU time + RSS. Instantaneous CPU% is
 *                computed from the CPU-time DELTA between ticks; `ps -o %cpu`
 *                is a lifetime average and would badly understate spikes.
 *   - `vm_stat`→ wired / active / compressed pages, swapin/pageout counters.
 *   - `sysctl` → swap usage and load average.
 *   - `ioreg`  → GPU "Device Utilization %" (Apple Silicon; no sudo needed).
 * Linux gets CPU/RSS/load via the same `ps` path and skips the macOS-only
 * samplers rather than failing.
 *
 * CPU numbers are per-core percentages, the way `top` reports them: 1000% on
 * this 10-core machine means every core is pinned.
 *
 * If PHYTOGRAPH_E2E_TIMELINE points at a JSONL written by the Playwright
 * timeline reporter (tests/e2e/helpers/timeline-reporter.ts), the summary also
 * reports, per spec file, the resources in flight while it ran — that is what
 * turns "the machine bogged down" into "wood-segment.spec.ts held 12 GB".
 */

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const IS_MAC = process.platform === 'darwin';

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
const flags = dashdash === -1 ? argv : argv.slice(0, dashdash);
const command = dashdash === -1 ? [] : argv.slice(dashdash + 1);

function flagValue(name, fallback) {
  const i = flags.indexOf(name);
  return i === -1 ? fallback : flags[i + 1];
}

const intervalMs = Number(flagValue('--interval', '1000'));
const reportEverySec = Number(flagValue('--report-every', '15'));
const noGpu = flags.includes('--no-gpu');
const quiet = flags.includes('--quiet');
const outPath =
  flagValue('--out', null) ??
  join(repoRoot, 'perf', `resources-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
// Where the Playwright timeline reporter should write its spans. Set as an env
// var for the child rather than in the npm script so the same command works on
// Windows, where `FOO=bar cmd` isn't a thing.
const timelinePath = flagValue('--timeline', null);
if (timelinePath) process.env.PHYTOGRAPH_E2E_TIMELINE = timelinePath;

mkdirSync(dirname(outPath), { recursive: true });

// ---------------------------------------------------------------- samplers

const TOTAL_BYTES = IS_MAC
  ? Number(sh('sysctl', ['-n', 'hw.memsize']))
  : (() => {
      const m = /MemTotal:\s+(\d+) kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
      return m ? Number(m[1]) * 1024 : 0;
    })();
const NCPU = Number(IS_MAC ? sh('sysctl', ['-n', 'hw.ncpu']) : sh('nproc', []));

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

/** Which bucket a process belongs to, matched against its executable path. */
function classify(comm) {
  if (/phytograph_backend/.test(comm)) return 'backend';
  if (/backend-api\/venv\/bin\/python|uvicorn/.test(comm)) return 'backend';
  if (/PotreeConverter|potree_converter/.test(comm)) return 'backend';
  if (/Electron|Phytograph\.app/.test(comm)) return 'electron';
  if (/(^|\/)node(\.exe)?$/.test(comm)) return 'node';
  return 'other';
}

/** macOS `ps` TIME is MM:SS.ss, or HH:MM:SS.ss once a process passes an hour. */
function cpuSeconds(t) {
  const parts = t.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(t) || 0;
}

/** pid → { rssKb, cpuSec, comm } for every process on the machine. */
function sampleProcesses() {
  const out = sh('ps', ['-Ao', 'pid=,rss=,cputime=,comm=']);
  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    procs.set(Number(m[1]), {
      rssKb: Number(m[2]),
      cpuSec: cpuSeconds(m[3]),
      comm: m[4],
    });
  }
  return procs;
}

function sampleMemory() {
  if (!IS_MAC) {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => Number(/(?:^|\n)\s*MemAvailable:\s+(\d+) kB/.exec(info)?.[1] ?? 0);
    return { freeGb: kb() / 1024 / 1024, wiredGb: 0, compressedGb: 0, activeGb: 0 };
  }
  const vm = sh('vm_stat');
  const pageSize = Number(/page size of (\d+) bytes/.exec(vm)?.[1] ?? 16384);
  const stat = (label) => {
    const m = new RegExp(`${label}:\\s+(\\d+)\\.`).exec(vm);
    return m ? Number(m[1]) : 0;
  };
  const gb = (pages) => (pages * pageSize) / 1024 ** 3;
  return {
    freeGb: gb(stat('Pages free') + stat('Pages speculative')),
    wiredGb: gb(stat('Pages wired down')),
    compressedGb: gb(stat('Pages occupied by compressor')),
    activeGb: gb(stat('Pages active')),
    // Counters, not gauges — the summary reports these as per-second rates.
    swapins: stat('Swapins'),
    swapouts: stat('Swapouts'),
    pageouts: stat('Pageouts'),
  };
}

function sampleSwapGb() {
  if (!IS_MAC) return 0;
  const m = /used = ([\d.]+)([MG])/.exec(sh('sysctl', ['-n', 'vm.swapusage']));
  if (!m) return 0;
  return m[2] === 'G' ? Number(m[1]) : Number(m[1]) / 1024;
}

function sampleLoad1() {
  if (IS_MAC) return Number(/\{ ([\d.]+)/.exec(sh('sysctl', ['-n', 'vm.loadavg']))?.[1] ?? 0);
  return Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
}

/**
 * GPU busy %. On Apple Silicon the accelerator publishes "Device Utilization %"
 * in its IORegistry PerformanceStatistics dict — no sudo, unlike powermetrics.
 * Returns null when unavailable so the summary can say so instead of lying.
 */
let gpuAvailable = !noGpu && IS_MAC;
function sampleGpu() {
  if (!gpuAvailable) return null;
  const out = sh('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
  const vals = [...out.matchAll(/"Device Utilization %"=(\d+)/g)].map((m) => Number(m[1]));
  if (!vals.length) {
    gpuAvailable = false;
    return null;
  }
  return Math.max(...vals);
}

// ---------------------------------------------------------------- sampling loop

const samples = [];
let prevProcs = sampleProcesses();
let prevMem = sampleMemory();
let prevT = Date.now();
const startedAt = prevT;
let lastReportAt = prevT;

writeFileSync(outPath, '');

function tick() {
  const now = Date.now();
  const dt = (now - prevT) / 1000;
  if (dt <= 0) return;

  const procs = sampleProcesses();
  const mem = sampleMemory();

  const cpu = { backend: 0, electron: 0, node: 0, other: 0, total: 0 };
  const rss = { backend: 0, electron: 0, node: 0, other: 0, total: 0 };
  const perProc = [];

  for (const [pid, p] of procs) {
    const before = prevProcs.get(pid);
    // A pid that appeared this tick has no delta to measure; it shows up next
    // tick. Its RSS still counts.
    const pct = before ? ((p.cpuSec - before.cpuSec) / dt) * 100 : 0;
    const group = classify(p.comm);
    const rssMb = p.rssKb / 1024;
    if (pct > 0) {
      cpu[group] += pct;
      cpu.total += pct;
    }
    rss[group] += rssMb;
    rss.total += rssMb;
    if (pct > 20 || rssMb > 300) perProc.push({ pid, comm: p.comm, cpu: pct, rssMb });
  }

  perProc.sort((a, b) => b.cpu + b.rssMb / 50 - (a.cpu + a.rssMb / 50));

  const sample = {
    t: now,
    elapsed: (now - startedAt) / 1000,
    cpu: round(cpu),
    // Summed RSS double-counts shared pages (Electron helpers especially), so
    // treat it as an attribution signal; the vm_stat figures are the truth for
    // how much memory the machine actually has left.
    rssMb: round(rss),
    mem: {
      freeGb: r2(mem.freeGb),
      wiredGb: r2(mem.wiredGb),
      compressedGb: r2(mem.compressedGb),
      activeGb: r2(mem.activeGb),
      swapUsedGb: r2(sampleSwapGb()),
      swapinRate: IS_MAC ? Math.round((mem.swapins - prevMem.swapins) / dt) : 0,
      pageoutRate: IS_MAC ? Math.round((mem.pageouts - prevMem.pageouts) / dt) : 0,
    },
    gpu: sampleGpu(),
    load1: sampleLoad1(),
    top: perProc.slice(0, 6).map((p) => ({ ...p, cpu: r2(p.cpu), rssMb: Math.round(p.rssMb) })),
  };

  samples.push(sample);
  appendFileSync(outPath, JSON.stringify(sample) + '\n');

  if (!quiet && (now - lastReportAt) / 1000 >= reportEverySec) {
    lastReportAt = now;
    const pressure = ((mem.wiredGb + mem.compressedGb) / (TOTAL_BYTES / 1024 ** 3)) * 100;
    console.log(
      `[mon] ${fmtDur(sample.elapsed)}  cpu ${Math.round(sample.cpu.total)}%/${NCPU * 100}%` +
        ` (be ${Math.round(sample.cpu.backend)} el ${Math.round(sample.cpu.electron)})` +
        `  free ${sample.mem.freeGb.toFixed(1)}G  comp ${sample.mem.compressedGb.toFixed(1)}G` +
        `  swap ${sample.mem.swapUsedGb.toFixed(1)}G  pressure ${Math.round(pressure)}%` +
        (sample.gpu === null ? '' : `  gpu ${sample.gpu}%`),
    );
  }

  prevProcs = procs;
  prevMem = mem;
  prevT = now;
}

function round(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = r2(v);
  return out;
}
const r2 = (n) => Math.round(n * 100) / 100;

const timer = setInterval(tick, intervalMs);
timer.unref?.();

// ---------------------------------------------------------------- summary

function pct(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const fmtDur = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function row(label, values, unit, digits = 0) {
  const f = (n) => n.toFixed(digits).padStart(9);
  return `  ${label.padEnd(22)}${f(mean(values))}${f(pct(values, 50))}${f(pct(values, 95))}${f(Math.max(0, ...values))}  ${unit}`;
}

function summarize() {
  if (samples.length < 2) {
    console.log('\n[mon] too few samples to summarize.');
    return;
  }
  const totalGb = TOTAL_BYTES / 1024 ** 3;
  const get = (f) => samples.map(f);
  const pressures = samples.map((s) => ((s.mem.wiredGb + s.mem.compressedGb) / totalGb) * 100);

  console.log(
    `\n${'='.repeat(78)}\n` +
      `RESOURCE SUMMARY — ${samples.length} samples over ${fmtDur(samples.at(-1).elapsed)} ` +
      `(${NCPU} cores, ${totalGb.toFixed(0)} GB)\n${'='.repeat(78)}\n` +
      `  ${'metric'.padEnd(22)}${'mean'.padStart(9)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'max'.padStart(9)}`,
  );
  const phyto = get((s) => s.cpu.backend + s.cpu.electron + s.cpu.node);
  console.log(row('cpu total', get((s) => s.cpu.total), `% of ${NCPU * 100}%`));
  console.log(row('  phytograph (all 3)', phyto, '%'));
  console.log(row('    backend (python)', get((s) => s.cpu.backend), '%'));
  console.log(row('    electron', get((s) => s.cpu.electron), '%'));
  console.log(row('    node/playwright', get((s) => s.cpu.node), '%'));
  console.log(row('  everything else', get((s) => s.cpu.other), '%'));
  // The share is the number that answers "is it us?". Compare it against an
  // idle baseline (`node scripts/monitor-resources.mjs` with no command) —
  // background sync/backup/AV agents can dominate a dev machine on their own,
  // and they also react to the file churn a build or test run creates.
  console.log(
    `  ${'phytograph share'.padEnd(22)}${((100 * mean(phyto)) / (mean(get((s) => s.cpu.total)) || 1)).toFixed(0).padStart(9)}` +
      `${' '.repeat(27)}  % of all CPU used`,
  );
  console.log(row('load avg (1m)', get((s) => s.load1), `(${NCPU} = saturated)`, 1));
  if (samples.some((s) => s.gpu !== null)) {
    console.log(row('gpu utilization', get((s) => s.gpu ?? 0), '%'));
  } else {
    console.log('  gpu utilization         (unavailable on this host)');
  }
  console.log('');
  console.log(row('memory free', get((s) => s.mem.freeGb), 'GB', 2));
  console.log(row('memory compressed', get((s) => s.mem.compressedGb), 'GB', 2));
  console.log(row('memory wired', get((s) => s.mem.wiredGb), 'GB', 2));
  console.log(row('swap used', get((s) => s.mem.swapUsedGb), 'GB', 2));
  console.log(row('memory pressure', pressures, '% (wired+compressed)', 1));
  console.log(row('swapins/sec', get((s) => s.mem.swapinRate), 'pages'));
  console.log(row('pageouts/sec', get((s) => s.mem.pageoutRate), 'pages'));
  console.log('');
  console.log(row('rss backend', get((s) => s.rssMb.backend / 1024), 'GB (sums shared pages)', 2));
  console.log(row('rss electron', get((s) => s.rssMb.electron / 1024), 'GB (sums shared pages)', 2));

  // The single worst moment, with whatever was running at the time.
  const worstMem = samples.reduce((a, b) => (b.mem.freeGb < a.mem.freeGb ? b : a));
  const worstCpu = samples.reduce((a, b) => (b.cpu.total > a.cpu.total ? b : a));
  for (const [label, s] of [
    ['lowest free memory', worstMem],
    ['highest CPU', worstCpu],
  ]) {
    console.log(`\n  ${label} at ${fmtDur(s.elapsed)}:`);
    for (const p of s.top.slice(0, 4)) {
      console.log(
        `    ${String(Math.round(p.cpu)).padStart(5)}% cpu  ${String(p.rssMb).padStart(6)} MB  ${short(p.comm)}`,
      );
    }
  }

  summarizePerSpec();
  console.log(`\n  raw samples: ${relative(process.cwd(), outPath)}\n`);
}

function short(comm) {
  return comm.replace(/^.*\/(?=[^/]*(?:\.app\/|$))/, '').slice(-70);
}

/** Join samples against the Playwright timeline, if the reporter wrote one. */
function summarizePerSpec() {
  const tl = process.env.PHYTOGRAPH_E2E_TIMELINE;
  if (!tl || !existsSync(tl)) return;
  const events = readFileSync(tl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!events.length) return;

  // Per spec FILE, not per test: two workers overlap, so a sample is credited
  // to every spec in flight at that instant. Concurrency is reported alongside
  // so a spec that only ever ran next to a heavy neighbour is obvious.
  const spans = events.filter((e) => e.type === 'test' && e.start && e.end);
  const byFile = new Map();
  for (const s of spans) {
    const cur = byFile.get(s.file) ?? { file: s.file, tests: 0, ms: 0, samples: [] };
    cur.tests += 1;
    cur.ms += s.end - s.start;
    byFile.set(s.file, cur);
  }
  for (const s of samples) {
    for (const span of spans) {
      if (s.t >= span.start && s.t <= span.end) byFile.get(span.file).samples.push(s);
    }
  }

  const rows = [...byFile.values()]
    .filter((r) => r.samples.length)
    .map((r) => ({
      file: r.file.replace(/^tests\/e2e\//, ''),
      wall: r.ms / 1000,
      // Phytograph-attributed, NOT machine total: on a dev box with sync and
      // backup agents running, spec-to-spec differences in TOTAL cpu (or in
      // free memory, which sits pinned near zero all run) are dominated by
      // background noise and rank the specs meaninglessly.
      peakPhyto: Math.max(...r.samples.map((s) => s.cpu.backend + s.cpu.electron + s.cpu.node)),
      peakBackendCpu: Math.max(...r.samples.map((s) => s.cpu.backend)),
      peakBackendRss: Math.max(...r.samples.map((s) => s.rssMb.backend)) / 1024,
      peakElectronRss: Math.max(...r.samples.map((s) => s.rssMb.electron)) / 1024,
    }));

  const table = (label, key) => {
    console.log(
      `\n  PER-SPEC — top 12 by ${label} (specs overlap across 2 workers; a sample is\n` +
        `  credited to every spec in flight, so a light spec beside a heavy one inherits its peak)\n` +
        `  ${'spec'.padEnd(42)}${'wall s'.padStart(8)}${'phy cpu'.padStart(9)}${'be cpu'.padStart(8)}${'be rss'.padStart(8)}${'el rss'.padStart(8)}`,
    );
    for (const r of [...rows].sort((a, b) => b[key] - a[key]).slice(0, 12)) {
      console.log(
        `  ${r.file.padEnd(42)}${r.wall.toFixed(0).padStart(8)}` +
          `${Math.round(r.peakPhyto).toString().padStart(9)}` +
          `${Math.round(r.peakBackendCpu).toString().padStart(8)}` +
          `${r.peakBackendRss.toFixed(2).padStart(8)}` +
          `${r.peakElectronRss.toFixed(2).padStart(8)}`,
      );
    }
  };
  table('peak phytograph CPU %', 'peakPhyto');
  table('peak backend RSS (GB)', 'peakBackendRss');
  console.log(`\n  (${rows.length} spec files total — see the JSONL for the rest)`);
}

// ---------------------------------------------------------------- run

let exitCode = 0;
if (command.length) {
  console.log(`[mon] sampling every ${intervalMs}ms → ${relative(process.cwd(), outPath)}`);
  console.log(`[mon] running: ${command.join(' ')}\n`);
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    // npx/npm are .cmd shims on Windows and won't spawn without a shell.
    shell: process.platform === 'win32',
    env: process.env,
  });
  child.on('error', (err) => {
    console.error(`[mon] failed to run command: ${err.message}`);
    exitCode = 1;
    finish();
  });
  child.on('exit', (code, signal) => {
    exitCode = code ?? (signal ? 1 : 0);
    finish();
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
} else {
  console.log(`[mon] sampling every ${intervalMs}ms → ${relative(process.cwd(), outPath)}`);
  console.log('[mon] no command given; Ctrl-C to stop and print the summary.\n');
  process.on('SIGINT', () => {
    exitCode = 0;
    finish();
  });
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  tick();
  summarize();
  process.exit(exitCode);
}
