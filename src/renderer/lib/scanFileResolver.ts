// Resolves a <filename> from a Helios scan XML to an absolute path on disk.
//
// Strategy: try the XML's own directory first, then the app's CWD, then
// prompt the user. Helios projects conventionally store XML and data files
// side-by-side, so the XML-dir hit is the common case; CWD is a fallback
// for projects that have been moved. The dialog prompt seeds with the
// filename's basename so the user can locate a renamed/moved file quickly.

import { POINT_CLOUD_FORMATS } from './pointCloudParsers';
import { basename, isAbsolute, joinPath } from './pathUtils';

// Strips the leading `.` from each `POINT_CLOUD_FORMATS` ext so the dialog
// filter receives `['las', 'laz', ...]`, which is what Electron expects.
const POINT_CLOUD_EXTENSIONS = POINT_CLOUD_FORMATS.map(f => f.ext.replace(/^\./, ''));

export interface ResolveOptions {
  // Defaults to `window.electronAPI.fs.exists` / `dialog.open` / `app.getCwd`.
  // Tests inject mocks here.
  fsExists?: (path: string) => Promise<boolean>;
  getCwd?: () => Promise<string>;
  promptForPath?: (defaultName: string) => Promise<string | null>;
}

export async function resolveAttachedScanFile(
  filename: string,
  xmlDir: string,
  opts: ResolveOptions = {},
): Promise<string | null> {
  const fsExists = opts.fsExists ?? ((p: string) => window.electronAPI.fs.exists(p));
  const getCwd = opts.getCwd ?? (() => window.electronAPI.app.getCwd());
  const promptForPath = opts.promptForPath ?? defaultPromptForPath;

  // Absolute paths short-circuit the candidate search.
  if (isAbsolute(filename)) {
    if (await fsExists(filename)) return filename;
    return promptForPath(basename(filename));
  }

  const candidates: string[] = [];
  if (xmlDir) candidates.push(joinPath(xmlDir, filename));
  try {
    const cwd = await getCwd();
    if (cwd) candidates.push(joinPath(cwd, filename));
  } catch {
    // Best-effort — if CWD lookup fails we just skip that candidate.
  }

  for (const candidate of candidates) {
    if (await fsExists(candidate)) return candidate;
  }

  return promptForPath(basename(filename));
}

async function defaultPromptForPath(defaultName: string): Promise<string | null> {
  const picked = await window.electronAPI.dialog.open({
    title: `Locate scan file: ${defaultName}`,
    defaultPath: defaultName,
    filters: [{ name: 'Point cloud', extensions: POINT_CLOUD_EXTENSIONS }],
  });
  if (!picked) return null;
  return Array.isArray(picked) ? picked[0] ?? null : picked;
}
