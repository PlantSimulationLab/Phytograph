#!/usr/bin/env node
// Patch node_modules/electron/dist/Electron.app/Contents/Info.plist so the
// dev binary shows "Phytograph" in the macOS menu bar instead of "Electron".
//
// Why this is necessary: macOS reads the menu-bar app label directly from
// the running bundle's CFBundleName (and the About menu item from
// CFBundleDisplayName). No Electron API can override this at runtime — see
// https://github.com/electron/electron/issues/19892 (MarshallOfSound, member).
// Packaged builds get the right name from electron-builder's productName;
// only `npm run dev` is affected, so we patch the bundle that npm installed.
//
// Idempotent: re-running on an already-patched plist is a no-op.
// Scope: only this repo's node_modules/electron — does not touch any global
// install or other projects.
// Hooked via package.json#scripts.postinstall so it survives `npm install`.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP_NAME = 'Phytograph';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const bundlePath = join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app');
const plistPath = join(bundlePath, 'Contents', 'Info.plist');
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';

// macOS-only and dev-only. Other platforms don't read CFBundleName for the
// menu bar; CI envs that skip electron's postinstall won't have the file.
if (process.platform !== 'darwin' || !existsSync(plistPath)) {
  process.exit(0);
}

const original = await readFile(plistPath, 'utf8');

// Replace the <string>Electron</string> that immediately follows each of the
// two keys. The Electron-shipped plist always pairs them on consecutive lines,
// so this targeted regex avoids touching CFBundleExecutable (which needs to
// stay "Electron" — it's the binary filename inside MacOS/).
function setKey(plist, key, value) {
  const re = new RegExp(
    `(<key>${key}</key>\\s*<string>)[^<]*(</string>)`,
    'g'
  );
  return plist.replace(re, `$1${value}$2`);
}

let patched = setKey(original, 'CFBundleName', APP_NAME);
patched = setKey(patched, 'CFBundleDisplayName', APP_NAME);

if (patched !== original) {
  await writeFile(plistPath, patched, 'utf8');
  console.log(`Patched ${plistPath} → CFBundleName/CFBundleDisplayName = "${APP_NAME}"`);
}

// Force Launch Services to re-read the bundle. Without this, the Dock tooltip
// (which reads from the LS cache, not the plist directly) keeps showing the
// stale "Electron" name even after the plist is updated. Safe to run on every
// invocation — lsregister is idempotent.
if (existsSync(LSREGISTER)) {
  spawnSync(LSREGISTER, ['-f', bundlePath], { stdio: 'ignore' });
}
