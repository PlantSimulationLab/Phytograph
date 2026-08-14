// Reads a RIEGL raw project (.riproject) by running RIEGL's closed-source
// RiVLib inside a linux/amd64 container. This is Phase 1 of the RIEGL import
// work: it proves the read path end-to-end with no Phytograph involvement, and
// doubles as the tool for checking whether a given project is readable.
//
// WHY A CONTAINER: RiVLib ships for Windows and Linux only. There is no macOS
// build and the .rxp format has no public spec, so on a Mac this is the only
// way to read raw scanner data at all. Verified: 13,083,685 points in 5.7 s
// under Rosetta, so emulation is not a practical cost.
//
// RIVLIB IS USER-SUPPLIED. Its licence forbids redistribution ("You may NOT
// distribute or modify the software..."), so it is never baked into the image
// and never committed here. Download it yourself from RIEGL's members area and
// point this script at it. Part 1, built for x86_64-linux-gcc9.5.0, is what the
// bullseye base image expects.
//
// Usage:
//   node scripts/riegl-probe.mjs <project.riproject>
//   node scripts/riegl-probe.mjs <project.riproject> --count-points   # exact totals (slower)
//   node scripts/riegl-probe.mjs <project.riproject> --json           # raw JSON
//
//   # extract to LAS (Phase 2) — all positions, or a chosen subset:
//   node scripts/riegl-probe.mjs <project.riproject> --out ./extracted
//   node scripts/riegl-probe.mjs <project.riproject> --out ./extracted \
//        --scans ScanPos001 ScanPos003
//
// Configuration:
//   RIVLIB_PATH   directory holding lib/libscanifc.so (required unless --rivlib)
//   FORCE=1       rebuild the image even when it already exists

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const IMAGE = 'phytograph-riegl:latest';
const DOCKER_CONTEXT = join(repoRoot, 'docker', 'riegl');
const PLATFORM = 'linux/amd64';

function fail(message, hint) {
  console.error(`\nriegl-probe: ${message}`);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    project: null,
    countPoints: false,
    json: false,
    rivlib: null,
    out: null,
    scans: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--count-points') args.countPoints = true;
    else if (a === '--json') args.json = true;
    else if (a === '--rivlib') args.rivlib = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--scans') {
      // Consume every following non-flag token, so both
      //   --scans ScanPos001 ScanPos003
      // and a single name work.
      args.scans = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args.scans.push(argv[++i]);
      }
      if (args.scans.length === 0) fail('--scans needs at least one scan name.');
    } else if (a.startsWith('--')) fail(`unknown flag ${a}`);
    else if (args.project === null) args.project = a;
    else fail(`unexpected argument ${a}`);
  }
  if (args.scans && !args.out) {
    fail('--scans only applies to extraction; pass --out <dir> as well.');
  }
  return args;
}

function checkDocker() {
  const version = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (version.error || version.status !== 0) {
    fail(
      'the Docker daemon is not reachable.',
      'Start Docker Desktop and try again. On macOS the container is the only\n' +
        'way to run RiVLib, since RIEGL ships no macOS build.',
    );
  }
  return version.stdout.trim();
}

function resolveRivlib(explicit) {
  const candidate = explicit ?? process.env.RIVLIB_PATH;
  if (!candidate) {
    fail(
      'RiVLib location not set.',
      'RiVLib is proprietary and user-supplied — its licence forbids us from\n' +
        'shipping it. Download "RiVLib Part 1" for x86_64-linux-gcc9.5.0 from\n' +
        'RIEGL\'s members area, then:\n\n' +
        '  export RIVLIB_PATH=/path/to/rivlib-2.15.5-x86_64-linux-gcc9.5.0\n\n' +
        'or pass --rivlib <path>.',
    );
  }
  const dir = resolve(candidate);
  const so = join(dir, 'lib', 'libscanifc.so');
  if (!existsSync(so)) {
    fail(
      `no libscanifc.so under ${dir}`,
      'Expected <RIVLIB_PATH>/lib/libscanifc.so. Point RIVLIB_PATH at the\n' +
        'top level of the extracted RiVLib download (the directory holding\n' +
        'bin/, include/, lib/), not at lib/ itself.',
    );
  }
  return dir;
}

function imageExists() {
  const res = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
  return res.status === 0;
}

function buildImage() {
  console.error(`Building ${IMAGE} (${PLATFORM})...`);
  const res = spawnSync(
    'docker',
    ['build', '--platform', PLATFORM, '-t', IMAGE, DOCKER_CONTEXT],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) fail('docker build failed.');
}

function runInspect(projectDir, rivlibDir, countPoints) {
  const args = [
    'run',
    '--rm',
    '--platform',
    PLATFORM,
    '-v',
    `${rivlibDir}:/rivlib:ro`,
    // The project is mounted read-only: this tool only ever reads scanner data,
    // and a bug here must not be able to touch irreplaceable field captures.
    '-v',
    `${projectDir}:/project:ro`,
    IMAGE,
    'inspect',
    '/project',
  ];
  if (countPoints) args.push('--count-points');

  // Buffer stdout (it is JSON) but let stderr through so container errors and
  // progress are visible live. 1 GB cap: --count-points on a large project
  // still only emits a few KB of JSON, so hitting this means something is wrong.
  const res = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // Parse BEFORE checking the exit status: the reader reports its own failures
  // as {"error": ...} on stdout and then exits non-zero, so surfacing the
  // status alone would throw away the only useful part of the message.
  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    /* fall through to the status check below */
  }

  if (parsed?.error) fail(parsed.error);
  if (res.status !== 0) {
    fail(
      `container exited with status ${res.status}.`,
      res.stdout.trim() ? res.stdout.slice(0, 2000) : undefined,
    );
  }
  if (parsed === null) {
    fail('could not parse container output as JSON.', res.stdout.slice(0, 2000));
  }
  return parsed;
}

function runExtract(projectDir, rivlibDir, outDir, scans) {
  const args = [
    'run',
    '--rm',
    '--platform',
    PLATFORM,
    '-v',
    `${rivlibDir}:/rivlib:ro`,
    '-v',
    `${projectDir}:/project:ro`,
    // The only writable mount. Everything else is :ro so a bug here can never
    // touch irreplaceable field data.
    '-v',
    `${outDir}:/out`,
    IMAGE,
    'extract',
    '/project',
    '--out',
    '/out',
  ];
  if (scans?.length) args.push('--scans', ...scans);

  // Progress arrives on stderr as JSON lines while the result document comes
  // back on stdout, so the two never interleave. spawnSync can't stream, so
  // stderr is inherited: the reader's own progress lines land on the terminal
  // live and stdout is captured for parsing.
  const res = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  let parsed = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    /* fall through */
  }
  if (parsed?.error) fail(parsed.error);
  if (res.status !== 0) {
    fail(
      `container exited with status ${res.status}.`,
      res.stdout.trim() ? res.stdout.slice(0, 2000) : undefined,
    );
  }
  if (parsed === null) {
    fail('could not parse container output as JSON.', res.stdout.slice(0, 2000));
  }
  return parsed;
}

function reportExtract(data, hostOutDir) {
  const scans = data.scans ?? [];
  console.log(`\nProject:  ${data.project}`);
  console.log(`Output:   ${hostOutDir}`);
  console.log(`Scans:    ${scans.length}`);

  const anchor = data.gnss_anchor;
  if (anchor) {
    console.log(
      `Anchor:   ${anchor.latitude.toFixed(7)}, ${anchor.longitude.toFixed(7)}`,
    );
  }

  console.log(
    `\n${'scan'.padEnd(12)}${'points'.padStart(14)}${'max ret'.padStart(9)}` +
      `${'E (m)'.padStart(9)}${'N (m)'.padStart(9)}${'U (m)'.padStart(8)}  file`,
  );
  console.log('-'.repeat(96));
  let failures = 0;
  const warned = [];
  for (const s of scans) {
    if (s.error) {
      console.log(`${s.name.padEnd(12)}  ERROR: ${s.error}`);
      failures++;
      continue;
    }
    const o = s.origin_prior;
    const e = o ? o[0].toFixed(2).padStart(9) : '—'.padStart(9);
    const n = o ? o[1].toFixed(2).padStart(9) : '—'.padStart(9);
    const u = o ? o[2].toFixed(2).padStart(8) : '—'.padStart(8);
    const ret = String(s.max_returns_per_pulse ?? '—').padStart(9);
    console.log(
      `${s.name.padEnd(12)}${fmtInt(s.point_count).padStart(14)}${ret}${e}${n}${u}  ` +
        `${s.name}.las`,
    );
    if (s.warning) warned.push(s);
  }

  // A pulse-grouping disagreement means multi-return columns are untrustworthy
  // for that scan. Never let this scroll past silently.
  for (const s of warned) console.log(`\n! ${s.name}: ${s.warning}`);

  console.log(
    '\nScans are UNREGISTERED (raw scanner frames). The E/N/U above is a ' +
      'GNSS\nprior for seeding ICP, not a registration.',
  );
  console.log(
    'Sky/miss points are recovered from the scanner per-shot record and placed ' +
      'on the\nfar-field shell, so LAD is supported.',
  );
  if (failures) process.exitCode = 1;
}

function fmtInt(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
}

function fmtFov(params) {
  if (!params) return '—';
  const t = `${params.theta_min}–${params.theta_max}@${params.theta_increment}`;
  const p = `${params.phi_min}–${params.phi_max}@${params.phi_increment}`;
  return `theta ${t}  phi ${p}`;
}

function report(data, countPoints) {
  const scans = data.scans ?? [];
  console.log(`\nProject:  ${data.project}`);
  console.log(`RiVLib:   ${data.rivlib_version}`);
  console.log(`Scans:    ${data.scan_count}`);

  const anchor = data.gnss_anchor;
  if (anchor) {
    console.log(
      `Anchor:   ${anchor.latitude.toFixed(7)}, ${anchor.longitude.toFixed(7)}  ` +
        `(${anchor.height_m.toFixed(2)} m ${anchor.height_datum})`,
    );
  } else {
    console.log('Anchor:   — (no GNSS fix in any scan)');
  }

  const countLabel = countPoints ? 'points' : 'points(probed)';
  console.log(
    `\n${'scan'.padEnd(12)}${countLabel.padStart(15)}` +
      `${'E (m)'.padStart(10)}${'N (m)'.padStart(10)}${'U (m)'.padStart(9)}  instrument`,
  );
  console.log('-'.repeat(96));

  for (const s of scans) {
    if (s.error) {
      console.log(`${s.name.padEnd(12)}  ERROR: ${s.error}`);
      continue;
    }
    const count = countPoints ? s.point_count : s.point_count_probed;
    const enu = s.enu;
    const e = enu ? enu.east_m.toFixed(2).padStart(10) : '—'.padStart(10);
    const n = enu ? enu.north_m.toFixed(2).padStart(10) : '—'.padStart(10);
    const u = enu ? enu.up_m.toFixed(2).padStart(9) : '—'.padStart(9);
    const inst = s.instrument?.model ?? '—';
    console.log(
      `${s.name.padEnd(12)}${fmtInt(count).padStart(15)}${e}${n}${u}  ${inst}`,
    );
  }

  console.log('');
  for (const s of scans) {
    if (s.scan_params) console.log(`${s.name}: ${fmtFov(s.scan_params)}`);
  }

  const missing = scans.filter((s) => !s.gnss && !s.error);
  if (missing.length) {
    console.log(
      `\nNote: ${missing.length} scan(s) had no GNSS fix — ` +
        'those positions cannot be laid out automatically.',
    );
  }
  if (!countPoints) {
    console.log(
      '\nPoint counts above are from a bounded probe read, not file totals.\n' +
        'Re-run with --count-points for exact counts.',
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) {
    fail(
      'no project given.',
      'Usage: node scripts/riegl-probe.mjs <project.riproject> [--count-points] [--json]',
    );
  }

  const projectDir = resolve(args.project);
  if (!existsSync(projectDir)) fail(`no such directory: ${projectDir}`);

  checkDocker();
  const rivlibDir = resolveRivlib(args.rivlib);

  if (process.env.FORCE === '1' || !imageExists()) buildImage();

  if (args.out) {
    const outDir = resolve(args.out);
    mkdirSync(outDir, { recursive: true });
    const data = runExtract(projectDir, rivlibDir, outDir, args.scans);
    if (args.json) console.log(JSON.stringify(data, null, 2));
    else reportExtract(data, outDir);
    return;
  }

  const data = runInspect(projectDir, rivlibDir, args.countPoints);
  if (args.json) console.log(JSON.stringify(data, null, 2));
  else report(data, args.countPoints);
}

main();
