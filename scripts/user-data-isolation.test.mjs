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
const stateRootSrc = codeOnly(
  readFileSync(join(repoRoot, 'scripts', 'dev-state-root.mjs'), 'utf8'),
);
const shotSrc = codeOnly(
  readFileSync(join(repoRoot, 'docs', 'scripts', 'capture-screenshots.mjs'), 'utf8'),
);

describe('scripts/dev.mjs', () => {
  it('spawns Electron with its own --user-data-dir', () => {
    expect(devSrc).toMatch(/--user-data-dir=\$\{devUserDataDir\}/);
  });

  it('derives that dir outside the packaged app profile', () => {
    expect(devSrc).toMatch(/devUserDataDir\s*=[\s\S]*?devStateRoot\(/);
    expect(devSrc).not.toMatch(/Application Support/);
  });

  // "Stable" must mean the DIRECTORY survives, not just that the path string is
  // deterministic. This assertion used to accept tmpdir(), which satisfies the
  // string reading and fails the real one: temp is reaped (macOS empties /tmp on
  // boot and runs tmp_cleaner nightly; systemd-tmpfiles does the same), so the
  // dev profile vanished and every UI-set preference silently reverted — the
  // rivlib path most visibly, plus a "first time" splash on a machine that had
  // run dev for months. Nothing errored, which is why it survived so long.
  it('puts the dev profile somewhere durable, never under tmpdir()', () => {
    expect(devSrc).not.toMatch(/tmpdir/);
    expect(devSrc).toMatch(/devStateRoot/);
  });
});

// The capture script drives a real Electron window against the user's machine,
// so it needs the same isolation dev does — and for a while it had the same
// tmpdir() flaw, which is why it is pinned here rather than left to review.
describe('docs/scripts/capture-screenshots.mjs', () => {
  it('launches Electron with its own --user-data-dir', () => {
    expect(shotSrc).toMatch(/--user-data-dir=\$\{userDataDir\}/);
  });

  it('uses the shared durable root, never tmpdir()', () => {
    expect(shotSrc).not.toMatch(/tmpdir/);
    expect(shotSrc).toMatch(/devStateRoot\(/);
  });
});

// One definition, shared by dev.mjs and the capture script. A per-OS path
// computed twice and validated on only the OS where the two happen to agree is
// exactly what shipped the octree-cache divergence (see CLAUDE.md), so the
// resolver is asserted on its BEHAVIOUR here rather than by grepping each
// caller for platform strings.
describe('scripts/dev-state-root.mjs', () => {
  it('is the single definition — callers import it rather than re-deriving', () => {
    for (const src of [devSrc, shotSrc]) {
      expect(src).toMatch(/import \{ devStateRoot \}/);
      // No caller may carry its own copy of the platform branches.
      expect(src).not.toMatch(/XDG_CACHE_HOME/);
      expect(src).not.toMatch(/LOCALAPPDATA/);
    }
  });

  // Durable is necessary but not sufficient: <userData>/Cache is Chromium's own
  // HTTP cache and Chromium EMPTIES it on startup. On a case-insensitive volume
  // a segment spelled "cache" is that directory. This is the exact trap
  // src/main/octreeCacheRoot.ts documents, so dev state must sit beside the OS
  // cache dir rather than inside a Chromium-managed one.
  it('covers every platform, each under that OS cache dir', () => {
    expect(stateRootSrc).toMatch(/Library',\s*'Caches'/);
    expect(stateRootSrc).toMatch(/XDG_CACHE_HOME/);
    expect(stateRootSrc).toMatch(/LOCALAPPDATA/);
    expect(stateRootSrc).not.toMatch(/tmpdir/);
    expect(stateRootSrc).not.toMatch(/Application Support/);
  });

  it('resolves a real absolute path, and nests the subdir under one root', async () => {
    const { devStateRoot } = await import(
      join(repoRoot, 'scripts', 'dev-state-root.mjs')
    );
    const root = devStateRoot();
    expect(root).toMatch(/^[/\\]|^[A-Za-z]:/);
    // The two dev consumers and the capture share one parent, so a developer
    // can find (or delete) all of it in one place.
    for (const sub of ['userdata', 'octrees', 'screenshots']) {
      expect(devStateRoot(sub).startsWith(root)).toBe(true);
      expect(devStateRoot(sub)).not.toBe(root);
    }
    // Never inside a Chromium-managed profile directory.
    expect(root).not.toMatch(/Application Support/);
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
