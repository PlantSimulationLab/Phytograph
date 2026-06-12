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
    return promptForPath(filename);
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

  return promptForPath(filename);
}

// Default prompt: the referenced file wasn't found at any expected location.
// Explain that to the user FIRST with a dismissible message box that names the
// missing file — otherwise a bare native file picker appears out of nowhere and
// reads as a bug. Only if the user chooses "Locate…" do we open the picker.
async function defaultPromptForPath(referencedPath: string): Promise<string | null> {
  const name = basename(referencedPath);
  const { response } = await window.electronAPI.dialog.messageBox({
    type: 'warning',
    title: 'Scan file not found',
    message: `Couldn't find the scan data file "${name}".`,
    detail:
      `The XML references "${referencedPath}", but it isn't next to the XML ` +
      `or in the app's working folder. It may have been moved or renamed.\n\n` +
      `Choose "Locate…" to browse for it, or "Skip" to cancel this import.`,
    buttons: ['Locate…', 'Skip'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return null; // user chose Skip / dismissed

  const picked = await window.electronAPI.dialog.open({
    title: `Locate scan file: ${name}`,
    defaultPath: name,
    filters: [{ name: 'Point cloud', extensions: POINT_CLOUD_EXTENSIONS }],
  });
  if (!picked) return null;
  return Array.isArray(picked) ? picked[0] ?? null : picked;
}
