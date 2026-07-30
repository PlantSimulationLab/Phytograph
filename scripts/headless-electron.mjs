#!/usr/bin/env node
// Build (and cache) a Dock-less clone of the dev Electron bundle for E2E runs.
//
// The problem: `npm run test:e2e` launches one Electron app per spec file (91
// of them, 2 workers), and each launch briefly draws an icon in the macOS Dock
// before it disappears. The runtime suppression in src/main/main.ts —
// `app.setActivationPolicy('accessory')` — can only *demote* an app AppKit has
// already registered. Electron creates NSApp in PreBrowserMain(), long before
// PostEarlyInitialization() loads main.js, so the process is a regular
// foreground app for the whole of the V8/Node bootstrap. Long enough to flash.
//
// The only fix is LSUIElement=1 in the *running bundle's* Info.plist: AppKit
// reads it at [NSApplication sharedApplication] time, before any JS exists, so
// no Dock tile is ever created. It cannot be set at runtime.
// Ref: https://github.com/electron/electron/issues/422 (MarshallOfSound, member)
//
// We can't just patch node_modules/electron/dist/Electron.app the way
// patch-electron-info-plist.mjs does — that bundle also serves `npm run dev`
// and the docs screenshot scripts, which want a Dock icon. So we clone it once
// into ~/Library/Caches and patch only the clone, and the E2E launcher points
// `_electron.launch({ executablePath })` at it. Everything else keeps using the
// pristine bundle.
//
// The clone is nearly free: the repo volume is APFS, so `cp -c` is
// copy-on-write — the 233 MB bundle costs ~0 bytes and ~0 seconds. And the
// bundle is adhoc/linker-signed with `Info.plist=not bound` (verified via
// `codesign -dv --verbose=4`), so editing the plist neither invalidates the
// signature nor blocks launch on Apple Silicon.
//
// Cache lives OUTSIDE the repo on purpose. In-tree it would be 233 MB of real
// bytes for Dropbox to sync (APFS makes a clone free on disk, not on the wire)
// and one more directory for scripts/dropbox-ignore.mjs to keep marked — an
// xattr that decays every time the directory is deleted and recreated, which is
// exactly what a clone refresh does.
//
// Idempotent: re-running against an up-to-date clone is a stat + a small read.
// Self-healing: the clone is rebuilt when the Electron version or the source
// Info.plist changes, and `rm -rf`ing the cache dir is always a safe reset.
//
// Usage:
//   import { ensureHeadlessElectron } from './headless-electron.mjs'
//   node scripts/headless-electron.mjs     # build if needed, print the path

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm, rename, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const SRC_BUNDLE = join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
const SRC_PLIST = join(SRC_BUNDLE, 'Contents', 'Info.plist');
const ELECTRON_PKG = join(repoRoot, 'node_modules', 'electron', 'package.json');

const CACHE_ROOT = join(homedir(), 'Library', 'Caches', 'Phytograph');
// `.noindex` keeps Spotlight out. It does NOT keep Launch Services out — see
// unregisterFromLaunchServices() below.
const CACHE_DIR = join(CACHE_ROOT, 'e2e-electron.noindex');
const CLONE_BUNDLE = join(CACHE_DIR, 'Electron.app');
const STAMP = join(CACHE_DIR, 'stamp.json');
const LOCK = join(CACHE_ROOT, '.e2e-electron.lock');

// Deliberately NOT "Phytograph". If this clone ever does surface in Spotlight or
// the Apps launcher, it must be obvious that it isn't the real app.
const APP_NAME = 'Phytograph E2E';

// Bump when the patching logic changes, so existing clones are rebuilt.
const STAMP_SCHEMA = 1;

const PLIST_BUDDY = '/usr/libexec/PlistBuddy';
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';

const LOCK_WAIT_MS = 120_000;
const LOCK_STALE_MS = 5 * 60_000;

/**
 * Absolute path to the cloned bundle's executable. Deterministic, no side
 * effects — the file may not exist yet.
 * @returns {string}
 */
export function headlessElectronPath() {
  return join(CLONE_BUNDLE, 'Contents', 'MacOS', 'Electron');
}

/**
 * Build the Dock-less clone if it's missing or stale, and return the path to
 * its executable.
 *
 * Returns null when the clone isn't available — non-macOS, no installed
 * Electron, or any failure along the way. Callers should treat null as "use
 * Playwright's default bundle": that's the pre-existing behavior, and
 * main.ts's setActivationPolicy('accessory') still applies, so the suite works
 * exactly as it did before (just with the flash back).
 *
 * @returns {Promise<string|null>}
 */
export async function ensureHeadlessElectron() {
  if (process.platform !== 'darwin') return null;
  if (!existsSync(SRC_BUNDLE)) return null;

  try {
    const want = await currentStamp();
    if (await stampMatches(want)) return headlessElectronPath();

    await withBuildLock(async () => {
      // Re-check under the lock: a concurrent worker may have just built it.
      if (await stampMatches(want)) return;
      await rebuild(want);
    });

    return existsSync(headlessElectronPath()) ? headlessElectronPath() : null;
  } catch (err) {
    console.warn(
      `[headless-electron] using the default Electron bundle (Dock icon will flash): ${err.message}`,
    );
    return null;
  }
}

/** Identity of the source bundle the clone was made from. */
async function currentStamp() {
  const pkg = JSON.parse(await readFile(ELECTRON_PKG, 'utf8'));
  const { mtimeMs } = await stat(SRC_PLIST);
  return { schema: STAMP_SCHEMA, electronVersion: pkg.version, srcPlistMtimeMs: mtimeMs };
}

async function stampMatches(want) {
  if (!existsSync(headlessElectronPath())) return false;
  try {
    const have = JSON.parse(await readFile(STAMP, 'utf8'));
    return (
      have.schema === want.schema &&
      have.electronVersion === want.electronVersion &&
      have.srcPlistMtimeMs === want.srcPlistMtimeMs
    );
  } catch {
    return false;
  }
}

// mkdir() is atomic and fails with EEXIST if the directory is already there,
// which makes it a portable inter-process mutex. Both Playwright workers hit
// ensureHeadlessElectron() at once on a cold cache; without this they would
// race rm(CACHE_DIR) against each other's rename() and one could delete the
// bundle the other is about to launch.
async function withBuildLock(fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(CACHE_ROOT, { recursive: true });
      await mkdir(LOCK);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // A killed run can leave the lock behind forever. Break an old one.
      const age = await stat(LOCK)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => 0);
      if (age > LOCK_STALE_MS) {
        await rm(LOCK, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${LOCK}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(LOCK, { recursive: true, force: true }).catch(() => {});
  }
}

// Assemble the whole cache dir in a temp sibling, then swap it in with a single
// rename, so a crash mid-build can never leave a half-patched bundle behind
// that a later run would mistake for a good one.
async function rebuild(stamp) {
  const tmp = join(CACHE_ROOT, `.e2e-electron-tmp-${process.pid}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  try {
    cloneBundle(SRC_BUNDLE, join(tmp, 'Electron.app'));
    patchPlist(join(tmp, 'Electron.app', 'Contents', 'Info.plist'));
    await writeFile(join(tmp, 'stamp.json'), `${JSON.stringify(stamp, null, 2)}\n`);

    await rm(CACHE_DIR, { recursive: true, force: true });
    await rename(tmp, CACHE_DIR);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  unregisterFromLaunchServices();
  console.log(`[headless-electron] built Dock-less Electron clone at ${CLONE_BUNDLE}`);
}

function cloneBundle(src, dest) {
  // -c is an APFS copy-on-write clone: instant, and it shares blocks with the
  // original instead of duplicating 233 MB. It also copies xattrs, ACLs and the
  // embedded code signature verbatim.
  let r = spawnSync('/bin/cp', ['-c', '-R', src, dest], { stdio: 'pipe' });
  if (r.status !== 0) {
    // Non-APFS volume (or a partial copy). Start clean and do a real copy.
    spawnSync('/bin/rm', ['-rf', dest], { stdio: 'ignore' });
    r = spawnSync('/bin/cp', ['-R', src, dest], { stdio: 'pipe' });
  }
  if (r.status !== 0) {
    throw new Error(`cp failed: ${r.stderr?.toString().trim() || `exit ${r.status}`}`);
  }
}

// PlistBuddy rather than the targeted regex used by
// patch-electron-info-plist.mjs: that script only retargets existing <string>
// values, whereas we have to *insert* a key (LSUIElement) that isn't in the
// Electron-shipped plist at all.
function patchPlist(plistPath) {
  // LSUIElement=true is the whole point: registers the process as an accessory
  // app at NSApp creation, so no Dock tile is ever drawn.
  plistBuddy(plistPath, 'Add :LSUIElement bool true', 'Set :LSUIElement true');
  plistBuddy(plistPath, `Set :CFBundleName ${APP_NAME}`, `Add :CFBundleName string ${APP_NAME}`);
  plistBuddy(
    plistPath,
    `Set :CFBundleDisplayName ${APP_NAME}`,
    `Add :CFBundleDisplayName string ${APP_NAME}`,
  );
}

/** Run `primary`; if it fails (key already present / still missing), run `fallback`. */
function plistBuddy(plistPath, primary, fallback) {
  let r = spawnSync(PLIST_BUDDY, ['-c', primary, plistPath], { stdio: 'pipe' });
  if (r.status === 0) return;
  r = spawnSync(PLIST_BUDDY, ['-c', fallback, plistPath], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error(
      `PlistBuddy "${primary}" and "${fallback}" both failed: ` +
        `${r.stderr?.toString().trim() || `exit ${r.status}`}`,
    );
  }
}

// Launch Services registers every .app bundle it notices, regardless of the
// `.noindex` suffix (which only suppresses Spotlight content indexing) — the
// same finding that made scripts/run-electron-builder.mjs de-register unpacked
// build output. Left registered, this clone would show up alongside the real
// Phytograph in the Apps launcher. De-registering is safe here because
// Playwright spawns the executable directly and never goes through Launch
// Services. Best-effort: never let this fail a test run.
function unregisterFromLaunchServices() {
  if (!existsSync(LSREGISTER)) return;
  spawnSync(LSREGISTER, ['-u', CLONE_BUNDLE], { stdio: 'ignore' });
}

// `node scripts/headless-electron.mjs` builds if needed and prints the path,
// so the clone can be inspected without going through Playwright.
if (process.argv[1] && process.argv[1].endsWith('headless-electron.mjs')) {
  const p = await ensureHeadlessElectron();
  if (!p) {
    console.error('No headless Electron clone available on this platform.');
    process.exit(1);
  }
  process.stdout.write(`${p}\n`);
}
