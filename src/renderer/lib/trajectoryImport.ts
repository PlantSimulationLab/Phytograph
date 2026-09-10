// Shared "pick a platform-trajectory file and parse it into a PoseStream" flow,
// reused by the Scan Parameters popup (synthetic moving scans) and the point-cloud
// Import Wizard (attaching a trajectory to imported mobile-platform data).
//
// Supports every trajectory format Phytograph reads: text CSV/TXT/TSV/.traj
// (parsed in the renderer) and binary SBET .sbet/.out (parsed server-side, which
// needs pyproj for the geographic→UTM projection). Both yield the same PoseStream.

import { parsePoseStreamCsv, poseStreamFromWire, type PoseStream } from './poseStream';
import { parseTrajectory } from '../utils/backendApi';

// Binary Applanix SBET, routed to the backend parser. `.out` is POSPac's own export
// extension; `.sbet` is the common rename.
export const SBET_EXTENSIONS = ['sbet', 'out'] as const;

// Text trajectories parsed in the renderer (see parsePoseStreamCsv).
export const TEXT_TRAJECTORY_EXTENSIONS = ['csv', 'txt', 'tsv', 'traj'] as const;

// Everything the picker accepts, as ONE list — see buildTrajectoryFilters.
export const TRAJECTORY_EXTENSIONS: readonly string[] = [
  ...TEXT_TRAJECTORY_EXTENSIONS,
  ...SBET_EXTENSIONS,
];

// The dialog filter list. Deliberately a SINGLE combined entry rather than one
// per format: on macOS `showOpenDialog` applies only the FIRST filter's
// allowedFileTypes, so splitting text and binary across two entries greys out
// every .out/.sbet file — the user cannot select the SBET they came to import,
// and the second filter is reachable only through a format popup that is easy to
// miss. That is exactly how this shipped, and why an Applanix .out looked
// unsupported when the parser behind it worked fine. Every other file dialog in
// the app already uses one combined filter (the point-cloud importer lists 11
// extensions in a single entry); this is that same convention.
export function buildTrajectoryFilters(): { name: string; extensions: string[] }[] {
  return [{ name: 'Trajectory (CSV / text / SBET)', extensions: [...TRAJECTORY_EXTENSIONS] }];
}

// True when `path`'s extension is a binary SBET, which parses on the backend.
export function isSbetPath(path: string): boolean {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return (SBET_EXTENSIONS as readonly string[]).includes(ext);
}

// Parse an on-disk trajectory file at `path` into a PoseStream, routing binary
// SBET through the backend and text formats through the renderer parser. Throws
// PoseStreamParseError / Error on a malformed file.
export async function parseTrajectoryFromPath(path: string): Promise<PoseStream> {
  const label = path.split(/[\\/]/).pop();
  if (isSbetPath(path)) {
    const wire = await parseTrajectory(path);
    return poseStreamFromWire(wire, label);
  }
  const text = await window.electronAPI.fs.readText(path);
  return parsePoseStreamCsv(text, { label });
}

// Open the native file picker for a trajectory file and parse the user's choice.
// Returns the parsed PoseStream, or null if the user cancelled the dialog. Throws
// PoseStreamParseError / Error on a malformed file (callers surface the message).
export async function pickAndParseTrajectory(): Promise<PoseStream | null> {
  const picked = await window.electronAPI.dialog.open({
    title: 'Import platform trajectory',
    filters: buildTrajectoryFilters(),
  });
  if (!picked) return null;
  const path = Array.isArray(picked) ? picked[0] : picked;
  return parseTrajectoryFromPath(path);
}
