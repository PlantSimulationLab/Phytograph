// Filtering + authorization for paths the OS hands us to open.
//
// Three delivery routes funnel through here: macOS 'open-file' (Finder
// "Open With" / double-click on an association), a Windows/Linux cold launch's
// argv, and a second launch's argv relayed to the first instance via
// 'second-instance'. All of them mean the same thing — the user picked this file
// in the shell rather than in our own dialog — so the paths must be registered
// with the fs allowlist, exactly as a dialog result is.
//
// Splitting this out of main.ts keeps it unit-testable: main.ts runs app
// lifecycle, logging and crash-reporter side effects at module load, so it can't
// be imported from a test.

import { existsSync } from 'node:fs';
import { IMPORTABLE_EXTENSIONS } from '../shared/constants.js';
import { allowPath } from './fsAllowlist.js';

export function isImportablePath(p: string): boolean {
  const ext = p.toLowerCase().split('.').pop() ?? '';
  return (IMPORTABLE_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Extract importable file paths from a process argv array. The executable and
 * any leading `electron .`/flag tokens are not files; in dev, argv also includes
 * the entry script path. Filtering to known importable extensions + existence on
 * disk is a robust, platform-agnostic way to pick out genuine file arguments.
 */
export function extractFilePathsFromArgv(argv: string[]): string[] {
  return argv.filter((a) => !a.startsWith('-') && isImportablePath(a) && existsSync(a));
}

/**
 * Keep the importable paths and register each with the fs allowlist.
 *
 * The allowlist otherwise only learns about dialog / drag-drop / <input
 * type=file> paths, so without this the renderer's `fs:readBinary` on an
 * OS-opened file is denied with "... is not a user-selected path" and the import
 * fails — even though File → Import of the very same file works. Registered as
 * kind 'file' (same as a dialog pick) so companion files sitting next to the
 * selection (scene.xml → scene.xyz) resolve identically on this route.
 */
export function authorizeOpenPaths(paths: string[]): string[] {
  const importable = paths.filter(isImportablePath);
  for (const p of importable) allowPath(p, 'file');
  return importable;
}
