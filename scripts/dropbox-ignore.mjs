#!/usr/bin/env node
/**
 * Mark generated directories with `com.dropbox.ignored` so a checkout that
 * lives inside a Dropbox folder doesn't hand ~4 GB of regenerable build output
 * to the sync client (and, transitively, to whatever backup and endpoint
 * -security agents watch the same tree).
 *
 * Why this is a script and not a one-time `xattr -w`: **the attribute lives on
 * the directory, and builds delete and recreate those directories.** Every
 * `npm run build:backend` replaces all ~1 GB of resources/phytograph_backend/,
 * every `vite build` rewrites the dist- dirs — each time the fresh one comes
 * back un-ignored and starts syncing again. So this runs idempotently as part
 * of postinstall and both build steps rather than being applied by hand once
 * and silently decaying.
 *
 * Deliberately NOT ignored:
 *   - example-datasets/ — gitignored only because it's too big for git. It's
 *     real, irreplaceable input data; Dropbox is exactly where it belongs.
 *   - .claude/ — the user's call, not a build artifact.
 *
 * No-ops off macOS and under CI. Best-effort: never fails a build.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Directories that are wholly generated — every one is reproducible from a
// clean checkout by the commands in CLAUDE.md.
const GENERATED = [
  'node_modules',
  'backend-api/venv',
  'docs/.venv',
  'docs/site',
  'pyhelios/pyhelios_build',
  'resources/phytograph_backend',
  'resources/potree_converter',
  'dist-main',
  'dist-preload',
  'dist-renderer',
  'test-results',
  'playwright-report',
  'perf',
  'tmp',
  '.pytest_cache',
  'backend-api/.pytest_cache',
  'backend-api/research/out',
  // Agent worktrees (Claude Code `isolation: worktree`). Each is a full
  // duplicate checkout that builds its own venv + node_modules — one stale
  // worktree measured 3.9 GB. Marking the PARENT matters: each run creates a
  // freshly-named agent-<hash>/ child that would otherwise start syncing.
  // `.claude/settings.local.json` is left alone — 4 KB, no churn.
  '.claude/worktrees',
];

// Python bytecode caches are recreated constantly by pytest and the dev
// backend. Walk our own source trees for them; the ones under node_modules and
// the venvs are already covered by their ignored parent.
function findPycache(root, out = []) {
  let entries;
  try {
    entries = readdirSync(join(repoRoot, root), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const rel = join(root, e.name);
    if (e.name === '__pycache__') out.push(rel);
    else if (e.name !== 'venv' && e.name !== 'node_modules' && !e.name.startsWith('.')) {
      findPycache(rel, out);
    }
  }
  return out;
}

export function applyDropboxIgnores({ verbose = false } = {}) {
  if (process.platform !== 'darwin' || process.env.CI) return 0;
  // Nothing to do outside a Dropbox tree.
  if (!repoRoot.includes('/Dropbox/')) return 0;

  const targets = [
    ...GENERATED,
    ...findPycache('backend-api'),
    ...findPycache('pyhelios'),
    ...findPycache('scripts'),
  ];

  let marked = 0;
  for (const rel of targets) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    try {
      // Skip the common case cheaply — re-writing an identical xattr would
      // otherwise touch every listed directory on every build.
      const current = execFileSync('xattr', ['-p', 'com.dropbox.ignored', abs], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (current === '1') continue;
    } catch {
      // No such attribute yet — fall through and set it.
    }
    try {
      execFileSync('xattr', ['-w', 'com.dropbox.ignored', '1', abs], { stdio: 'ignore' });
      marked++;
      if (verbose) console.log(`  ignored  ${relative(repoRoot, abs)}`);
    } catch {
      // A permissions oddity or a directory vanishing mid-build is not worth
      // failing a build over.
    }
  }
  return marked;
}

// Run the CLI path only when this file IS the entrypoint — build-backend.mjs
// imports applyDropboxIgnores() and must not trigger the console output.
// Compared by inode so a symlinked or differently-spelled path still matches.
let invokedDirectly = false;
try {
  invokedDirectly = statSync(process.argv[1]).ino === statSync(fileURLToPath(import.meta.url)).ino;
} catch {
  invokedDirectly = false;
}

if (invokedDirectly) {
  const n = applyDropboxIgnores({ verbose: true });
  console.log(
    n === 0
      ? '[dropbox-ignore] nothing to do (already marked, not a Dropbox tree, or non-macOS).'
      : `[dropbox-ignore] marked ${n} generated director${n === 1 ? 'y' : 'ies'} as Dropbox-ignored.`,
  );
}
