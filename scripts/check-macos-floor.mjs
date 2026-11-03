#!/usr/bin/env node
// Fails if any Mach-O in the bundled sidecars needs a newer macOS than
// MACOSX_DEPLOYMENT_TARGET. The macOS twin of check-glibc-floor.mjs, and for the
// same reason: compiled code targets the BUILD HOST's OS unless told otherwise,
// and launching it on that host cannot reveal a floor that only breaks on
// somebody else's Mac. Info.plist cannot either: LSMinimumSystemVersion says
// 11.0 whatever the bundle actually needs.
//
//   MACOSX_DEPLOYMENT_TARGET=14.0 node scripts/check-macos-floor.mjs [dir...]
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOTS = ['resources/phytograph_backend', 'resources/potree_converter'];
const MACHO_MAGIC = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca']);

// Numeric per component: as strings, '9.0' > '14.0' and '10.9' > '10.15'.
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Every minimum-OS value in `otool -l` output. A universal binary has one per
// slice. Older binaries say LC_VERSION_MIN_MACOSX/version, not LC_BUILD_VERSION/minos.
export function parseMinimumVersions(otoolOutput) {
  const found = [];
  let legacy = false;
  for (const line of otoolOutput.split('\n')) {
    const t = line.trim();
    if (t.startsWith('cmd ')) legacy = t === 'cmd LC_VERSION_MIN_MACOSX';
    const m = /^minos (\S+)/.exec(t) ?? (legacy ? /^version (\S+)/.exec(t) : null);
    if (m) found.push(m[1]);
  }
  return found;
}

/** Install names in `otool -L` output (the first line is the file itself). */
export function parseLinkedLibraries(otoolOutput) {
  return otoolOutput.split('\n').slice(1)
    .map((l) => /^\s+(\S.*?) \(compatibility version/.exec(l)?.[1])
    .filter(Boolean);
}

/**
 * For each violating library, the bundled binaries that link it directly —
 * i.e. what to fix. A floor violation in a bottle the bundle merely carries
 * (libusb, libX11) is unactionable without knowing who pulled it in, and
 * PyInstaller's log doesn't say. `links` maps path -> install names.
 */
export function findImporters(violations, links) {
  const out = new Map();
  for (const v of violations) {
    const base = v.path.split('/').pop();
    const importers = [...links.entries()]
      .filter(([p, libs]) => p !== v.path && libs.some((l) => l.split('/').pop() === base))
      .map(([p]) => p);
    out.set(v.path, importers);
  }
  return out;
}

export function findViolations(entries, target) {
  return entries.filter((e) => compareVersions(e.minimum, target) > 0);
}

function isMachO(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(4);
    return readSync(fd, buf, 0, 4, 0) === 4 && MACHO_MAGIC.has(buf.toString('hex'));
  } finally {
    closeSync(fd);
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile()) yield p;
  }
}

function main() {
  const target = process.env.MACOSX_DEPLOYMENT_TARGET;
  if (!target) {
    console.error('FAIL: MACOSX_DEPLOYMENT_TARGET is not set, so there is no floor to check against.');
    process.exit(1);
  }
  const roots = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_ROOTS;
  const entries = [];
  const links = new Map();
  for (const root of roots) {
    for (const path of walk(root)) {
      if (!isMachO(path)) continue;
      links.set(path, parseLinkedLibraries(
        execFileSync('otool', ['-L', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })));
      const out = execFileSync('otool', ['-l', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const versions = parseMinimumVersions(out);
      if (versions.length === 0) continue;
      entries.push({ path, minimum: versions.sort(compareVersions).at(-1) });
    }
  }
  // Zero is a broken measurement, not a pass: these trees are full of native code.
  if (entries.length === 0) {
    console.error(`FAIL: found no Mach-O files with a minimum OS under ${roots.join(', ')}.`);
    process.exit(1);
  }
  const violations = findViolations(entries, target);
  if (violations.length > 0) {
    console.error(`FAIL: ${violations.length} of ${entries.length} binaries need newer than macOS ${target}:`);
    for (const v of violations) console.error(`  ${v.minimum}  ${v.path}`);
    console.error('Linked by (fix these, not the library — a prebuilt bottle ignores MACOSX_DEPLOYMENT_TARGET):');
    for (const [lib, importers] of findImporters(violations, links)) {
      console.error(`  ${lib.split('/').pop()}  <-  ${importers.length ? importers.join(', ') : '(nothing in the bundle links it directly)'}`);
    }
    process.exit(1);
  }
  const highest = entries.map((e) => e.minimum).sort(compareVersions).at(-1);
  console.log(`PASS: ${entries.length} binaries checked; highest minimum is macOS ${highest} (target ${target}).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
