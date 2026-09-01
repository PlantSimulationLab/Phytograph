// A dev or test Electron instance must NEVER share the desktop app's profile.
//
// `electron .` derives `app.getPath('userData')` from the app name, which is the
// same name the installed Phytograph.app uses. So `npm run dev`, every E2E
// launch, and the desktop app all resolved to ONE directory —
// ~/Library/Application Support/phytograph — and it holds two things that must
// not be shared:
//
//   1. `phytograph-store.json`, the user's REAL preferences (theme, point size,
//      class palettes, rivlib path, synthetic-scan defaults). Any spec or dev
//      session that changes a setting through the UI overwrote them for good.
//   2. Chromium's profile, including `<userData>/Cache` — which Chromium EMPTIES
//      when it initialises its disk cache. Every dev/E2E launch therefore wiped
//      whatever the running desktop app had in there. That is how a live desktop
//      session lost the octrees for a cloud it had edited: the octree cache used
//      to live at <userData>/cache/octrees, the same directory on a
//      case-insensitive volume.
//
// Both are fixed by passing Chromium's `--user-data-dir` at spawn — E2E with a
// fresh temp dir per launch (specs must not inherit each other's settings), dev
// with a stable one (settings should survive a restart).
//
// This is a SOURCE-level guard on purpose. Dropping either switch reopens the
// collision silently: E2E on the shared profile still passes every assertion,
// and the damage lands on whatever the developer happens to have open.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

// Comments describe the history above, so these assertions must read CODE.
const codeOnly = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const devSrc = codeOnly(readFileSync(join(repoRoot, 'scripts', 'dev.mjs'), 'utf8'));
const launchSrc = codeOnly(
  readFileSync(join(repoRoot, 'tests', 'e2e', 'helpers', 'launchApp.ts'), 'utf8'),
);

describe('scripts/dev.mjs', () => {
  it('spawns Electron with its own --user-data-dir', () => {
    expect(devSrc).toMatch(/--user-data-dir=\$\{devUserDataDir\}/);
  });

  it('derives that dir outside the packaged app profile, and stably', () => {
    // tmpdir() matches the sibling choice already made for the octree cache;
    // "stable" is what lets dev settings survive a restart.
    expect(devSrc).toMatch(/devUserDataDir\s*=[\s\S]*?tmpdir\(\)/);
    expect(devSrc).not.toMatch(/Application Support/);
  });
});

describe('tests/e2e/helpers/launchApp.ts', () => {
  it('launches Electron with a per-run --user-data-dir', () => {
    expect(launchSrc).toMatch(/--user-data-dir=\$\{userDataDir\}/);
  });

  it('makes that dir fresh per launch, not shared', () => {
    // mkdtemp, not a fixed join() — two specs running in parallel (the suite
    // uses 2 workers) must not write each other's settings.
    expect(launchSrc).toMatch(/const userDataDir\s*=\s*await mkdtemp\(/);
  });

  it('removes it on close so runs do not leak profiles into the temp dir', () => {
    expect(launchSrc).toMatch(/rm\(userDataDir,\s*\{\s*recursive:\s*true/);
  });
});
