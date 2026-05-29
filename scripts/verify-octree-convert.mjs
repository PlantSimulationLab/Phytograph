// Verifies the XYZ -> Potree 2.0 octree pipeline end-to-end at a realistic
// scale. Generates a synthetic point cloud (default 10M points with RGB +
// reflectance, matching the BPPtree Helios scan format), then calls the
// backend's convert helpers via a thin Python entry point. Times each
// phase separately so regressions are easy to attribute.
//
// Acceptance: 10M-point cloud converts in under 15s on M-series. Default
// pass threshold is liberal so CI on slower runners doesn't false-alarm.
//
// Usage:
//   node scripts/verify-octree-convert.mjs                 # 10M default
//   N=20000000 node scripts/verify-octree-convert.mjs      # 20M points
//   PASS_SECONDS=30 node scripts/verify-octree-convert.mjs # bump threshold
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const N = parseInt(process.env.N ?? '10000000', 10);
const PASS_SECONDS = parseFloat(process.env.PASS_SECONDS ?? '15');
const FIXTURE = join(repoRoot, 'tmp', `verify_octree_${N}.xyz`);
const VENV_PY = join(repoRoot, 'backend-api', 'venv', 'bin', 'python');
const CONVERTER = process.env.PHYTOGRAPH_POTREECONVERTER
  ?? join(repoRoot, 'tmp', 'potree-converter-src', 'build', 'PotreeConverter');

function checkExists(path, desc) {
  if (!existsSync(path)) {
    console.error(`MISSING: ${desc} at ${path}`);
    process.exit(1);
  }
}

checkExists(VENV_PY, 'backend venv python (run: cd backend-api && python3 -m venv venv && pip install -r requirements.txt)');
checkExists(CONVERTER, 'PotreeConverter binary (run: brew install tbb && cd tmp/potree-converter-src && cmake --build build)');

mkdirSync(join(repoRoot, 'tmp'), { recursive: true });

// Step 1: generate fixture if missing.
if (!existsSync(FIXTURE)) {
  console.log(`generating ${N.toLocaleString()}-point fixture at ${FIXTURE}...`);
  const t0 = Date.now();
  const result = spawnSync('node', [
    join(repoRoot, 'scripts', 'make-big-xyz.mjs'),
  ], {
    env: { ...process.env, N: String(N), OUT: `tmp/verify_octree_${N}.xyz`, RGB: '1' },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error('fixture generation failed');
    process.exit(1);
  }
  console.log(`  fixture generated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else {
  console.log(`reusing fixture at ${FIXTURE} (${(statSync(FIXTURE).size / 1e9).toFixed(2)} GB)`);
}

// Step 2: drive the conversion through the backend's helpers in-process. We
// don't need uvicorn for this -- the helpers are pure Python and we want
// per-phase timing the HTTP endpoint doesn't expose.
const pyDriver = `
import sys, time, json, shutil, os
sys.path.insert(0, "${join(repoRoot, 'backend-api').replace(/"/g, '\\"')}")
os.environ["PHYTOGRAPH_POTREECONVERTER"] = "${CONVERTER.replace(/"/g, '\\"')}"
os.environ["PHYTOGRAPH_OCTREE_CACHE_ROOT"] = "${join(repoRoot, 'tmp', 'verify_octree_cache').replace(/"/g, '\\"')}"

import main
from pathlib import Path

src = Path("${FIXTURE.replace(/"/g, '\\"')}")
ascii_fmt = "x y z r255 g255 b255 reflectance"

cache_dir = main._octree_cache_dir(str(src), ascii_fmt)
if cache_dir.exists():
    shutil.rmtree(cache_dir)
cache_dir.parent.mkdir(parents=True, exist_ok=True)

staging = cache_dir.parent / (cache_dir.name + ".staging")
if staging.exists():
    shutil.rmtree(staging)
staging.mkdir(parents=True)

t0 = time.perf_counter()
las_path = staging / (src.stem + ".las")
n_points = main._xyz_to_las(src, ascii_fmt, las_path)
t1 = time.perf_counter()

main._run_potree_converter(las_path, staging)
t2 = time.perf_counter()

las_path.unlink()
staging.rename(cache_dir)
meta = main._read_octree_metadata(cache_dir)
t3 = time.perf_counter()

result = {
    "point_count": n_points,
    "metadata_point_count": meta["point_count"],
    "attributes": [a["name"] for a in meta["attributes"]],
    "bounds": meta["bounds"],
    "phase_xyz_to_las_s": t1 - t0,
    "phase_las_to_octree_s": t2 - t1,
    "phase_metadata_read_s": t3 - t2,
    "total_s": t3 - t0,
    "octree_size_bytes": sum(f.stat().st_size for f in cache_dir.iterdir() if f.is_file()),
}
print("__RESULT__" + json.dumps(result))
`;

const t0 = Date.now();
const child = spawn(VENV_PY, ['-c', pyDriver], { stdio: ['ignore', 'pipe', 'inherit'] });
let stdout = '';
child.stdout.on('data', (b) => { stdout += b.toString(); process.stdout.write(b); });
const exitCode = await new Promise((res) => child.on('close', res));
const wall = (Date.now() - t0) / 1000;

if (exitCode !== 0) {
  console.error(`\nconversion failed with exit code ${exitCode}`);
  process.exit(1);
}

const marker = stdout.indexOf('__RESULT__');
if (marker < 0) {
  console.error('\nresult marker not found in driver output');
  process.exit(1);
}
const result = JSON.parse(stdout.slice(marker + '__RESULT__'.length).trim());

console.log('\n=== octree convert verification ===');
console.log(`points (input):           ${result.point_count.toLocaleString()}`);
console.log(`points (metadata):        ${result.metadata_point_count.toLocaleString()}`);
console.log(`attributes:               ${result.attributes.join(', ')}`);
console.log(`bounds (min):             [${result.bounds.min.map((v) => v.toFixed(3)).join(', ')}]`);
console.log(`bounds (max):             [${result.bounds.max.map((v) => v.toFixed(3)).join(', ')}]`);
console.log(`octree size:              ${(result.octree_size_bytes / 1e6).toFixed(1)} MB`);
console.log(`phase XYZ -> LAS:         ${result.phase_xyz_to_las_s.toFixed(2)} s  (${(result.point_count / result.phase_xyz_to_las_s / 1e6).toFixed(2)} M pts/s)`);
console.log(`phase LAS -> octree:      ${result.phase_las_to_octree_s.toFixed(2)} s  (${(result.point_count / result.phase_las_to_octree_s / 1e6).toFixed(2)} M pts/s)`);
console.log(`phase metadata read:      ${result.phase_metadata_read_s.toFixed(2)} s`);
console.log(`total conversion:         ${result.total_s.toFixed(2)} s`);
console.log(`wall clock (incl. setup): ${wall.toFixed(2)} s`);

let failed = false;
if (result.point_count !== result.metadata_point_count) {
  console.error(`FAIL: input point count ${result.point_count} != metadata point count ${result.metadata_point_count}`);
  failed = true;
}
const requiredAttrs = ['position', 'rgb', 'intensity'];
const missing = requiredAttrs.filter((a) => !result.attributes.includes(a));
if (missing.length) {
  console.error(`FAIL: missing required attributes: ${missing.join(', ')}`);
  failed = true;
}
if (result.total_s > PASS_SECONDS) {
  console.error(`FAIL: conversion took ${result.total_s.toFixed(2)} s > PASS_SECONDS=${PASS_SECONDS}`);
  failed = true;
}

if (failed) {
  process.exit(1);
}
console.log('\nPASS');
