// Editor model for the MANUAL trajectory editor — the pure logic behind letting a
// user build or edit a moving-platform trajectory by hand (a pose table + 3D
// scanner-model editing) rather than only importing one from a file.
//
// The canonical wire/render representation is `PoseStream` / `PoseSample` in
// ./poseStream (orientation = Hamilton quaternion body->world). Editing a
// quaternion directly is unfriendly, and re-deriving Euler angles from the
// quaternion on every keystroke round-trips destructively near gimbal lock — so
// the editor holds each pose's orientation as Euler DEGREES in a `PoseDraft`, and
// converts to the canonical quaternion only when the stream is committed. The
// draft is the single source of truth while editing; both the table and the 3D
// viewport are controlled views of it.

import * as THREE from 'three';
import {
  type PoseStream,
  type PoseSample,
  type FrameMeta,
  DEFAULT_FRAME_META,
  quatFromRpy,
  quatToRpy,
} from './poseStream';

// One editable pose: position (meters) + orientation as intrinsic Z-Y-X Euler
// DEGREES (roll, pitch, yaw). `id` is a stable client key so React rows and 3D
// instances survive insert/delete/reorder without remounting the wrong element.
export interface PoseDraft {
  id: string;
  t: number;
  x: number;
  y: number;
  z: number;
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
}

// The calibration/metadata carried alongside the poses, preserved across an edit
// so building from an imported stream keeps its lever arm / boresight / frame.
export interface TrajectoryTemplate {
  frame: FrameMeta;
  leverArm: [number, number, number];
  boresightRpy: [number, number, number];
  label?: string;
}

export const DEFAULT_TRAJECTORY_TEMPLATE: TrajectoryTemplate = {
  frame: DEFAULT_FRAME_META,
  leverArm: [0, 0, 0],
  boresightRpy: [0, 0, 0],
  label: 'Manual trajectory',
};

// Default time step between poses (seconds) when auto-assigning timestamps.
const DEFAULT_DT = 1;

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

let idCounter = 0;
// Client-side id generator. Math.random / Date.now are unavailable in some
// harness contexts and a monotonic counter is sufficient for React keys within a
// single editing session.
function nextId(): string {
  idCounter += 1;
  return `pose-${idCounter}`;
}

// Build an empty draft pose at the origin, level, at time `t`.
export function makePoseDraft(t: number): PoseDraft {
  return { id: nextId(), t, x: 0, y: 0, z: 0, rollDeg: 0, pitchDeg: 0, yawDeg: 0 };
}

// A sensible starter trajectory for "build from scratch": two poses a few meters
// apart on a level heading, so the user sees a line and two scanner models
// immediately (a single pose can't be a moving scan).
export function makeStarterDrafts(): PoseDraft[] {
  return [
    { id: nextId(), t: 0, x: 0, y: 0, z: 1.5, rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
    { id: nextId(), t: DEFAULT_DT, x: 5, y: 0, z: 1.5, rollDeg: 0, pitchDeg: 0, yawDeg: 0 },
  ];
}

// Convert a canonical PoseStream into editable drafts (quaternion -> Euler deg).
export function poseStreamToDrafts(stream: PoseStream): PoseDraft[] {
  return stream.poses.map((p) => {
    const [roll, pitch, yaw] = quatToRpy(p.qx, p.qy, p.qz, p.qw);
    return {
      id: nextId(),
      t: p.t,
      x: p.x,
      y: p.y,
      z: p.z,
      rollDeg: roll * RAD2DEG,
      pitchDeg: pitch * RAD2DEG,
      yawDeg: yaw * RAD2DEG,
    };
  });
}

// Convert a single draft to the canonical PoseSample (Euler deg -> quaternion).
export function draftToPoseSample(d: PoseDraft): PoseSample {
  const [qx, qy, qz, qw] = quatFromRpy(
    d.rollDeg * DEG2RAD,
    d.pitchDeg * DEG2RAD,
    d.yawDeg * DEG2RAD,
  );
  return { t: d.t, x: d.x, y: d.y, z: d.z, qx, qy, qz, qw };
}

// Build a canonical PoseStream from drafts + calibration template. Marks the
// stream `sourceFormat: 'simulated'` (a hand-built / non-imported trajectory).
export function draftsToPoseStream(
  drafts: PoseDraft[],
  template: TrajectoryTemplate = DEFAULT_TRAJECTORY_TEMPLATE,
): PoseStream {
  return {
    poses: drafts.map(draftToPoseSample),
    frame: template.frame,
    leverArm: template.leverArm,
    boresightRpy: template.boresightRpy,
    sourceFormat: 'simulated',
    label: template.label,
  };
}

// The (x,y,z,qx,qy,qz,qw) tuples the 3D marker renderer consumes.
export function draftsToPoseTuples(
  drafts: PoseDraft[],
): Array<[number, number, number, number, number, number, number]> {
  return drafts.map((d) => {
    const s = draftToPoseSample(d);
    return [s.x, s.y, s.z, s.qx, s.qy, s.qz, s.qw];
  });
}

// Sample the trajectory at time `t`, returning an interpolated pose tuple
// [x,y,z,qx,qy,qz,qw]: position linearly interpolated and orientation SLERPed
// between the two poses bracketing `t` (the same position-lerp + attitude-slerp
// join the backend uses to reconstruct a per-return beam origin). Assumes the
// drafts are time-sorted (the editor keeps them so). Clamps to the endpoints
// outside the time range. This drives the smooth "preview" animation glyph.
export function sampleTrajectoryAt(
  drafts: PoseDraft[],
  t: number,
): [number, number, number, number, number, number, number] | null {
  if (drafts.length === 0) return null;
  if (drafts.length === 1 || t <= drafts[0].t) {
    const s = draftToPoseSample(drafts[0]);
    return [s.x, s.y, s.z, s.qx, s.qy, s.qz, s.qw];
  }
  const last = drafts[drafts.length - 1];
  if (t >= last.t) {
    const s = draftToPoseSample(last);
    return [s.x, s.y, s.z, s.qx, s.qy, s.qz, s.qw];
  }
  // Find the segment [a, b] with a.t <= t < b.t.
  let i = 0;
  while (i < drafts.length - 1 && drafts[i + 1].t <= t) i += 1;
  const a = drafts[i], b = drafts[i + 1];
  const span = b.t - a.t;
  const u = span > 1e-12 ? (t - a.t) / span : 0;
  const x = a.x + (b.x - a.x) * u;
  const y = a.y + (b.y - a.y) * u;
  const z = a.z + (b.z - a.z) * u;
  const q = draftQuat(a).slerp(draftQuat(b), u);
  return [x, y, z, q.x, q.y, q.z, q.w];
}

// Quaternion for a single draft as a THREE.Quaternion (for SLERP interpolation).
function draftQuat(d: PoseDraft): THREE.Quaternion {
  const [qx, qy, qz, qw] = quatFromRpy(
    d.rollDeg * DEG2RAD,
    d.pitchDeg * DEG2RAD,
    d.yawDeg * DEG2RAD,
  );
  return new THREE.Quaternion(qx, qy, qz, qw);
}

// Build a draft from an explicit position + quaternion (used by interpolation).
function draftFromPosQuat(
  t: number,
  pos: THREE.Vector3,
  q: THREE.Quaternion,
): PoseDraft {
  const [roll, pitch, yaw] = quatToRpy(q.x, q.y, q.z, q.w);
  return {
    id: nextId(),
    t,
    x: pos.x,
    y: pos.y,
    z: pos.z,
    rollDeg: roll * RAD2DEG,
    pitchDeg: pitch * RAD2DEG,
    yawDeg: yaw * RAD2DEG,
  };
}

// Sort drafts ascending by time (stable — equal times keep input order). The
// editor keeps the pose list time-ordered at all times so the table always reads
// top-to-bottom along the flight and the path line connects poses in order.
export function sortDraftsByTime(drafts: PoseDraft[]): PoseDraft[] {
  return drafts
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (a.d.t - b.d.t) || (a.i - b.i))
    .map(({ d }) => d);
}

// Add a single pose to the trajectory: it appends at lastT + dt (so, being the
// latest time, it sorts to the end) continuing the last segment's direction. This
// is the one "Add pose" action; finer control comes from editing the row or the
// insert-'+' between poses in the viewport.
export function addPose(drafts: PoseDraft[]): PoseDraft[] {
  return sortDraftsByTime(appendPose(drafts));
}

// Append a pose after the last one: position offset by the last segment's
// direction (or +X for a single pose), orientation copied, t = lastT + dt.
export function appendPose(drafts: PoseDraft[]): PoseDraft[] {
  if (drafts.length === 0) return [makePoseDraft(0)];
  const last = drafts[drafts.length - 1];
  const t = last.t + DEFAULT_DT;
  let dx = DEFAULT_DT, dy = 0, dz = 0;
  if (drafts.length >= 2) {
    const prev = drafts[drafts.length - 2];
    dx = last.x - prev.x;
    dy = last.y - prev.y;
    dz = last.z - prev.z;
  }
  return [
    ...drafts,
    {
      ...last,
      id: nextId(),
      t,
      x: last.x + dx,
      y: last.y + dy,
      z: last.z + dz,
    },
  ];
}

// Insert an interpolated pose between drafts[index] and drafts[index+1]:
// position is the linear midpoint, orientation the SLERP midpoint, t the
// midpoint. `index` must be in [0, length-2]; out of range is a no-op.
export function insertPoseBetween(drafts: PoseDraft[], index: number): PoseDraft[] {
  if (index < 0 || index >= drafts.length - 1) return drafts;
  const a = drafts[index];
  const b = drafts[index + 1];
  const midPos = new THREE.Vector3(
    (a.x + b.x) / 2,
    (a.y + b.y) / 2,
    (a.z + b.z) / 2,
  );
  const midQuat = draftQuat(a).slerp(draftQuat(b), 0.5);
  const midT = (a.t + b.t) / 2;
  const inserted = draftFromPosQuat(midT, midPos, midQuat);
  // Its midpoint time already places it between a and b; sort keeps the invariant
  // even if the neighbours weren't strictly time-ordered.
  return sortDraftsByTime([...drafts.slice(0, index + 1), inserted, ...drafts.slice(index + 1)]);
}

// Remove the pose at `index`.
export function deletePose(drafts: PoseDraft[], index: number): PoseDraft[] {
  if (index < 0 || index >= drafts.length) return drafts;
  return drafts.filter((_, i) => i !== index);
}

// Update one field of the pose at `index`, returning a new array. The value is
// applied in place WITHOUT re-sorting — even for the time field — so a row never
// jumps out from under the cursor mid-edit. The caller re-sorts on a short idle
// delay after a time edit settles (see the editor's deferred-sort in the viewer),
// which is the fix for the recurring "field reorders before you finish typing"
// problem.
export function updatePoseField(
  drafts: PoseDraft[],
  index: number,
  field: keyof Omit<PoseDraft, 'id'>,
  value: number,
): PoseDraft[] {
  if (index < 0 || index >= drafts.length) return drafts;
  return drafts.map((d, i) => (i === index ? { ...d, [field]: value } : d));
}

// Reassign timestamps to an evenly spaced sequence starting at the first pose's
// current time, stepping by DEFAULT_DT. Fixes a non-monotonic set in one click.
export function renumberTimestampsEven(drafts: PoseDraft[]): PoseDraft[] {
  if (drafts.length === 0) return drafts;
  const t0 = drafts[0].t;
  return drafts.map((d, i) => ({ ...d, t: t0 + i * DEFAULT_DT }));
}

export interface TimestampValidation {
  ok: boolean;
  // 1-based index of the first pose whose time is not strictly greater than the
  // previous pose's, or null when ok.
  badRow: number | null;
  message: string | null;
}

// The backend join and parsePoseStreamCsv both require strictly increasing
// timestamps. A single-pose (or empty) set can't be a moving scan.
export function validateTimestamps(drafts: PoseDraft[]): TimestampValidation {
  if (drafts.length < 2) {
    return {
      ok: false,
      badRow: null,
      message: 'A trajectory needs at least two poses.',
    };
  }
  for (let i = 1; i < drafts.length; i += 1) {
    if (!(drafts[i].t > drafts[i - 1].t)) {
      return {
        ok: false,
        badRow: i + 1,
        message: `Pose ${i + 1} time (${drafts[i].t}) must be greater than pose ${i} time (${drafts[i - 1].t}). Times must strictly increase.`,
      };
    }
  }
  return { ok: true, badRow: null, message: null };
}
