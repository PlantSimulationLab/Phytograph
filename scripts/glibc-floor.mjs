// What glibc version does the Linux build actually require?
//
// The answer is a property of the BUILD HOST, and nobody chooses it: PyInstaller
// bundles the host's libpython/libstdc++, and anything compiled there
// (libhelios, PotreeConverter) links against the host's glibc. An ELF binary
// cannot run against an older glibc than it was linked to, so the highest
// GLIBC_x.y any bundled file references IS the minimum OS we support.
//
// It shipped wrong, and silently. release.yml builds Linux on ubuntu-24.04,
// where GCC 13 emits C23 symbols (__isoc23_strtol and friends) versioned
// GLIBC_2.38. On a UCD HPC node running Ubuntu 22.04.5 (glibc 2.35) the
// AppImage mounted, the Electron window opened, and the backend then died on
// every restart attempt with:
//
//   Failed to load Python shared library '.../libpython3.11.so.1.0':
//   /lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found
//
// Meanwhile the docs advertised "Linux (most distros)".
//
// Why the checks we already had could not catch it: release.yml's
// "Smoke-test backend (Unix)" LAUNCHES the bundle, but it launches it on the
// build runner, where a 24.04-built binary works perfectly. A floor only breaks
// on somebody else's machine, so the only way to see it at build time is to read
// the symbol versions statically. That is what this file does.
//
// This is a truth-keeping check, not a gate. GLIBC_FLOOR below is the number the
// docs quote; if a toolchain bump pushes the real requirement above it, the
// build fails and BOTH have to move together — deliberately, because raising it
// drops real users off the supported list.

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

/**
 * The highest glibc version the shipped Linux binaries are allowed to require.
 *
 * MEASURED, not chosen: it records what ubuntu-24.04 + GCC 13 currently emits.
 * Changing it is a user-facing decision, not a build detail — the same number
 * appears in README.md and docs/docs/guide/install.md, and raising it makes the
 * app stop working on distributions that worked before. If the guard fails,
 * find out what moved before you touch this line.
 */
export const GLIBC_FLOOR = '2.38';

/** Directories whose ELF files ship inside the AppImage. */
export const SHIPPED_DIRS = ['resources/phytograph_backend', 'resources/potree_converter'];

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // "\x7fELF"

/**
 * Is this file an ELF binary?
 *
 * Reads four bytes and compares the magic number, deliberately rather than
 * trusting the name: the payload here is mostly extensionless (the
 * `phytograph_backend` launcher, a bare `PotreeConverter`) or carries
 * versioned suffixes (`libpython3.11.so.1.0`), and PyInstaller's `_internal/`
 * mixes .so files in with data. An extension allowlist would skip exactly the
 * binaries that matter.
 */
export function isElf(path, { open = openSync, read = readSync, close = closeSync } = {}) {
  let fd;
  try {
    fd = open(path, 'r');
  } catch {
    return false; // unreadable or vanished between walk and open
  }
  try {
    const buf = Buffer.alloc(4);
    const n = read(fd, buf, 0, 4, 0);
    return n === 4 && buf.equals(ELF_MAGIC);
  } catch {
    return false;
  } finally {
    close(fd);
  }
}

/**
 * Compare two dotted numeric versions componentwise.
 *
 * Componentwise and NUMERIC, which is the whole point. glibc symbol versions
 * are not orderable as strings: '2.9' > '2.38' lexically, so a naive
 * `.sort().pop()` picks 2.9 as the maximum of a real symbol table and waves a
 * GLIBC_2.38 binary straight through the guard. Three-component versions
 * ('2.2.5') are common in the same table and must compare correctly too.
 */
export function compareVersions(a, b) {
  const A = a.split('.').map(Number);
  const B = b.split('.').map(Number);
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Extract every GLIBC_x.y version named in `objdump -T` / `readelf -V` output.
 *
 * Pure string work so the parsing is testable without binaries. Matches only
 * versions with at least one dot, so the GLIBC_ABI_DT_RELR-style tags that
 * carry no version number are ignored rather than parsed as NaN.
 */
export function parseGlibcVersions(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)) out.add(m[1]);
  return [...out];
}

/** The highest version in a list, or null when the list is empty. */
export function maxGlibcVersion(versions) {
  if (!versions.length) return null;
  return [...versions].sort(compareVersions).pop();
}

/**
 * Read the glibc versions one ELF file requires.
 *
 * objdump and readelf are both binutils and both present on the GitHub runner;
 * we try objdump first and fall back, so this works on a stripped-down image
 * with only one of them. A non-zero exit is not fatal — some files in the
 * bundle are ELF but have no dynamic symbol table, and those legitimately
 * report nothing.
 */
export function readElfGlibcVersions(path, { spawn = spawnSync, tool = null } = {}) {
  const attempts = tool
    ? [tool]
    : [
        { cmd: 'objdump', args: ['-T', path] },
        { cmd: 'readelf', args: ['-V', path] },
      ];

  for (const { cmd, args } of attempts) {
    const r = spawn(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) continue; // tool not installed; try the next one
    return { ok: true, tool: cmd, versions: parseGlibcVersions(r.stdout || '') };
  }
  return { ok: false, tool: null, versions: [] };
}

/** Every file under `dir`, recursively. Symlinks are not followed. */
export function walkFiles(dir, { readdir = readdirSync, stat = statSync } = {}) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      } else {
        // Dirent kinds are unreliable on some filesystems; fall back to stat.
        try {
          const s = stat(full);
          if (s.isDirectory()) stack.push(full);
          else if (s.isFile()) out.push(full);
        } catch {
          /* vanished */
        }
      }
    }
  }
  return out;
}

/**
 * Scan directories for ELF files and report what glibc each one needs.
 *
 * Side effects are injected so the whole scan is unit-testable against a fake
 * tree and fake tool output.
 */
export function scanForGlibc(
  dirs,
  { walk = walkFiles, elf = isElf, versions = readElfGlibcVersions, exists = null } = {},
) {
  const files = [];
  const missingDirs = [];
  let toolFound = false;

  for (const dir of dirs) {
    const present = exists ? exists(dir) : walk(dir).length > 0;
    if (!present) {
      missingDirs.push(dir);
      continue;
    }
    for (const path of walk(dir)) {
      if (!elf(path)) continue;
      const r = versions(path);
      if (r.ok) toolFound = true;
      const max = maxGlibcVersion(r.versions);
      if (max) files.push({ path, version: max });
    }
  }

  return { files, missingDirs, toolFound };
}

/**
 * Check the shipped Linux binaries against the declared floor.
 *
 * Never throws. Returns { ok, reason, message, maxVersion, offenders } where
 * reason is machine-readable:
 *   'skipped'     — not Linux; nothing to measure
 *   'ok'          — every ELF is at or below the floor
 *   'over-floor'  — something needs a newer glibc than we document
 *   'missing-dir' — the artifacts aren't built yet
 *   'no-tool'     — neither objdump nor readelf is installed
 *   'no-symbols'  — nothing referenced glibc, so the measurement itself failed
 */
export function checkGlibcFloor({
  platform = process.platform,
  dirs = SHIPPED_DIRS.map((d) => join(root, d)),
  floor = GLIBC_FLOOR,
  scan = scanForGlibc,
} = {}) {
  if (platform !== 'linux') {
    return {
      ok: true,
      reason: 'skipped',
      message: `not Linux (${platform}); the glibc floor only constrains the Linux build`,
      maxVersion: null,
      offenders: [],
    };
  }

  const { files, missingDirs, toolFound } = scan(dirs);

  if (missingDirs.length) {
    return {
      ok: false,
      reason: 'missing-dir',
      message:
        `Nothing to scan — these shipped directories are missing:\n` +
        missingDirs.map((d) => `  ${rel(d)}`).join('\n') +
        `\nBuild them first (\`npm run build:backend\`, \`npm run build:potree-converter\`).`,
      maxVersion: null,
      offenders: [],
    };
  }

  if (!toolFound) {
    return {
      ok: false,
      reason: 'no-tool',
      message:
        'Neither `objdump` nor `readelf` is available, so the glibc floor could not be\n' +
        'measured. Install binutils (`sudo apt-get install -y binutils`).',
      maxVersion: null,
      offenders: [],
    };
  }

  const maxVersion = maxGlibcVersion(files.map((f) => f.version));

  // Zero glibc-referencing ELF files is not a pass, it is a broken measurement.
  // The bundle genuinely cannot run without libc, so an empty result means the
  // scan looked in the wrong place, the tool produced nothing parseable, or the
  // directory holds no binaries at all. Reporting "ok" here would be the exact
  // silent green tick this guard exists to prevent.
  if (!maxVersion) {
    return {
      ok: false,
      reason: 'no-symbols',
      maxVersion: null,
      offenders: [],
      message:
        'Scanned the shipped directories and found no ELF file referencing glibc at all.\n' +
        'That cannot be right — the backend links libc — so the measurement, not the\n' +
        'bundle, is what failed. Check that the directories hold the real binaries and\n' +
        'that `objdump -T` prints a dynamic symbol table for them.',
    };
  }

  const offenders = files
    .filter((f) => compareVersions(f.version, floor) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));

  if (offenders.length) {
    return {
      ok: false,
      reason: 'over-floor',
      maxVersion,
      offenders,
      message:
        `The Linux build now requires glibc ${maxVersion}, above the documented floor of ${floor}.\n` +
        `\n` +
        `${offenders.length} file(s) need more than GLIBC_${floor}:\n` +
        offenders
          .slice(0, 20)
          .map((f) => `  GLIBC_${f.version}  ${rel(f.path)}`)
          .join('\n') +
        (offenders.length > 20 ? `\n  … and ${offenders.length - 20} more` : '') +
        `\n\n` +
        `Rebuilding will NOT fix this — the floor is set by the build host's glibc\n` +
        `(release.yml builds Linux on ubuntu-24.04), not by anything in the bundle.\n` +
        `\n` +
        `Raising the floor DROPS USERS: every distribution between ${floor} and\n` +
        `${maxVersion} stops working, with no error the user can act on. If that is\n` +
        `genuinely intended, update GLIBC_FLOOR in scripts/glibc-floor.mjs *and* the\n` +
        `stated requirement in README.md and docs/docs/guide/install.md together.`,
    };
  }

  return {
    ok: true,
    reason: 'ok',
    maxVersion,
    offenders: [],
    message: `${files.length} ELF file(s) scanned; highest requirement GLIBC_${maxVersion} (floor ${floor})`,
  };
}

function rel(p) {
  const r = relative(root, p);
  return r.startsWith('..') ? p : r;
}
