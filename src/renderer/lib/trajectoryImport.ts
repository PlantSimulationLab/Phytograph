// Shared "pick a platform-trajectory file and parse it into a PoseStream" flow,
// reused by the Scan Parameters popup (synthetic moving scans) and the point-cloud
// Import Wizard (attaching a trajectory to imported mobile-platform data).
//
// Supports every trajectory format Phytograph reads: text CSV/TXT/TSV/.traj
// (parsed in the renderer) and binary SBET .sbet/.out (parsed server-side, which
// needs pyproj for the geographic→UTM projection). Both yield the same PoseStream.

import { parsePoseStreamCsv, poseStreamFromWire, type PoseStream } from './poseStream';
import { parseTrajectory } from '../utils/backendApi';

// Parse an on-disk trajectory file at `path` into a PoseStream, routing binary
// SBET through the backend and text formats through the renderer parser. Throws
// PoseStreamParseError / Error on a malformed file.
export async function parseTrajectoryFromPath(path: string): Promise<PoseStream> {
  const label = path.split(/[\\/]/).pop();
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (ext === 'sbet' || ext === 'out') {
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
    filters: [
      { name: 'Trajectory (CSV / text)', extensions: ['csv', 'txt', 'tsv', 'traj'] },
      { name: 'Binary trajectory (SBET)', extensions: ['sbet', 'out'] },
    ],
  });
  if (!picked) return null;
  const path = Array.isArray(picked) ? picked[0] : picked;
  return parseTrajectoryFromPath(path);
}
