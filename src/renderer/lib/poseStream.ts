// Canonical 6-DOF platform pose stream — the moving-platform LiDAR trajectory.
//
// A moving scan (drone / ground robot / tractor) is reconstructed from a dense
// timestamped trajectory joined to each return by time. This module holds the
// renderer-side representation + a parser for the trajectory file the user imports.
// It mirrors the backend `PoseStream` (backend-api/main.py / trajectory.py) field
// for field, so the parsed object serializes straight into the LAD request.
//
// CONVENTIONS (pinned to match helios-core's lidar plugin — see quat_from_rpy in
// plugins/lidar/src/LiDAR.cpp, and backend-api/trajectory.py):
//   - Quaternions are Hamilton, body->world, components (qx, qy, qz, qw) scalar-last.
//   - Euler angles are intrinsic Z-Y-X (yaw-pitch-roll) Tait-Bryan, radians:
//     q = qz(yaw) * qy(pitch) * qx(roll) — roll first, then pitch, then yaw.

export interface PoseSample {
  t: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface FrameMeta {
  crs: string | null;
  // Phytograph world is Z-up; recorded so a join is never silently wrong.
  upAxis: 'z';
  // Body-axis convention of the attitude quaternion (forward-left-up vs
  // forward-right-down), recorded for downstream interoperability.
  bodyConvention: 'FLU' | 'FRD';
  timeRef: string | null;
}

export interface PoseStream {
  poses: PoseSample[];
  frame: FrameMeta;
  // Scanner optical center in the platform body frame (meters): origin =
  // pos(t) + R(quat(t))·leverArm.
  leverArm: [number, number, number];
  // Fixed sensor rotational misalignment [roll, pitch, yaw] radians.
  boresightRpy: [number, number, number];
  sourceFormat: 'pose_csv' | 'sbet' | 'las_extrabytes' | 'reconstructed' | 'simulated';
  label?: string;
}

export const DEFAULT_FRAME_META: FrameMeta = {
  crs: null,
  upAxis: 'z',
  bodyConvention: 'FLU',
  timeRef: null,
};

export class PoseStreamParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoseStreamParseError';
  }
}

// Build a Hamilton (qx,qy,qz,qw) quaternion from intrinsic Z-Y-X roll/pitch/yaw
// (radians). Bit-for-bit the same formula as helios-core's quat_from_rpy, so the
// renderer, backend, and C++ all agree.
export function quatFromRpy(
  roll: number,
  pitch: number,
  yaw: number,
): [number, number, number, number] {
  const cr = Math.cos(roll * 0.5), sr = Math.sin(roll * 0.5);
  const cp = Math.cos(pitch * 0.5), sp = Math.sin(pitch * 0.5);
  const cy = Math.cos(yaw * 0.5), sy = Math.sin(yaw * 0.5);
  const qw = cr * cp * cy + sr * sp * sy;
  const qx = sr * cp * cy - cr * sp * sy;
  const qy = cr * sp * cy + sr * cp * sy;
  const qz = cr * cp * sy - sr * sp * cy;
  return [qx, qy, qz, qw];
}

// Inverse of quatFromRpy: recover intrinsic Z-Y-X roll/pitch/yaw (radians) from a
// Hamilton (qx,qy,qz,qw) quaternion. Exact inverse of the formula above, so
// quatToRpy(quatFromRpy(r,p,y)) round-trips to (r,p,y) away from gimbal lock.
// At the ±90° pitch singularity (|sinPitch| ≈ 1) roll and yaw are coupled; we
// clamp pitch and fold the coupled rotation into yaw (roll = 0), the standard
// convention — the resulting quaternion is still correct, only the r/p/y split
// is non-unique there. Needed so an imported quaternion trajectory can be shown
// and edited as roll/pitch/yaw in the manual editor.
export function quatToRpy(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): [number, number, number] {
  // roll (x-axis rotation)
  const sinrCosp = 2 * (qw * qx + qy * qz);
  const cosrCosp = 1 - 2 * (qx * qx + qy * qy);
  // pitch (y-axis rotation)
  const sinp = 2 * (qw * qy - qz * qx);
  // yaw (z-axis rotation)
  const sinyCosp = 2 * (qw * qz + qx * qy);
  const cosyCosp = 1 - 2 * (qy * qy + qz * qz);

  if (Math.abs(sinp) >= 1) {
    // Gimbal lock: pitch at ±90°. Fold roll into yaw (roll = 0).
    const pitch = Math.sign(sinp) * (Math.PI / 2);
    const yaw = Math.atan2(2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz));
    return [0, pitch, yaw];
  }

  const roll = Math.atan2(sinrCosp, cosrCosp);
  const pitch = Math.asin(sinp);
  const yaw = Math.atan2(sinyCosp, cosyCosp);
  return [roll, pitch, yaw];
}

// Column layouts the parser accepts. Either an 8-column quaternion row
// (t x y z qx qy qz qw) or a 7-column Euler row (t x y z roll pitch yaw, radians).
// A header line naming the columns is optional; without one, column count decides.
export interface ParsePoseStreamOptions {
  // When the file has no header and 7 columns, treat the last three as degrees
  // instead of radians. Quaternion (8-col) rows are unaffected.
  eulerInDegrees?: boolean;
  label?: string;
}

const QUAT_COLS = 8;
const EULER_COLS = 7;

// Map a header column name to a canonical pose field. Strips units/punctuation
// ('Time [s]' -> 'time', 'Easting [m]' -> 'easting') and accepts the spellings
// real exporters use — notably SYSSIFOSS/HELIOS++, whose trajectory header is
// `Easting Northing Height Time Roll Pitch Yaw` (POSITION-first, not time-first).
// Without this, that file's columns are read positionally and Easting is mistaken
// for time (which isn't monotonic → "times must be strictly increasing").
type PoseField = 't' | 'x' | 'y' | 'z'
  | 'roll' | 'pitch' | 'yaw' | 'qx' | 'qy' | 'qz' | 'qw';

function poseFieldFromHeader(name: string): PoseField | null {
  const base = name.replace(/\[.*?\]/g, '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
  switch (base) {
    case 't': case 'time': case 'gpstime': case 'timestamp': case 'times': return 't';
    case 'x': case 'easting': case 'east': case 'posx': return 'x';
    case 'y': case 'northing': case 'north': case 'posy': return 'y';
    case 'z': case 'height': case 'altitude': case 'alt': case 'elevation':
    case 'posz': return 'z';
    case 'roll': return 'roll';
    case 'pitch': return 'pitch';
    case 'yaw': case 'heading': return 'yaw';
    case 'qx': return 'qx';
    case 'qy': return 'qy';
    case 'qz': return 'qz';
    case 'qw': return 'qw';
    default: return null;
  }
}

// Given a header line's tokens, return a column-reorder map that pulls each raw
// row into canonical order — [t,x,y,z,roll,pitch,yaw] (Euler) or
// [t,x,y,z,qx,qy,qz,qw] (quaternion) — or null when the header doesn't resolve to
// a complete known layout (so the caller falls back to positional parsing).
function columnOrderFromHeader(tokens: string[]): number[] | null {
  const fieldAt = tokens.map(poseFieldFromHeader);
  const idxOf = (f: PoseField) => fieldAt.indexOf(f);
  const base: PoseField[] = ['t', 'x', 'y', 'z'];
  const quat: PoseField[] = [...base, 'qx', 'qy', 'qz', 'qw'];
  const euler: PoseField[] = [...base, 'roll', 'pitch', 'yaw'];
  if (tokens.length === QUAT_COLS && quat.every((f) => idxOf(f) >= 0)) {
    return quat.map(idxOf);
  }
  if (tokens.length === EULER_COLS && euler.every((f) => idxOf(f) >= 0)) {
    return euler.map(idxOf);
  }
  return null;
}

// Parse a CSV / whitespace-delimited trajectory file into a PoseStream.
//
// Accepts comma OR whitespace separators, '#'/'//' comment lines, and an optional
// header row. Rows are 8-col (quaternion) or 7-col (Euler rpy). Times must be
// strictly increasing (the backend join and SLERP require it); a single row is
// allowed (constant pose). Throws PoseStreamParseError with an actionable message.
export function parsePoseStreamCsv(
  text: string,
  options: ParsePoseStreamOptions = {},
): PoseStream {
  const rawLines = text.split(/\r?\n/);
  const rows: number[][] = [];
  let detectedCols: number | null = null;
  // When a recognized header names the columns, this reorders each raw row into
  // canonical [t,x,y,z,...] order — letting position-first exports (SYSSIFOSS/
  // HELIOS++) import without the user pre-reordering. null = parse positionally.
  let columnOrder: number[] | null = null;

  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const tokens = line.split(/[,\s]+/).filter((t) => t.length > 0);
    // A header row (non-numeric first token) is skipped once — but first try to
    // read a column-order map from it, so named columns in any order resolve.
    if (rows.length === 0 && detectedCols === null && Number.isNaN(Number(tokens[0]))) {
      // Strip bracketed unit groups BEFORE tokenizing the header, so a label like
      // 'Time [s]' (which the row split would break into 'Time' + '[s]', inflating
      // the column count) stays a single 'Time' token. Data rows never have these.
      const headerTokens = line
        .replace(/\[[^\]]*\]/g, '')
        .split(/[,\t]|\s{2,}|\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      columnOrder = columnOrderFromHeader(headerTokens);
      continue;
    }
    let nums = tokens.map(Number);
    if (nums.some((n) => Number.isNaN(n))) {
      throw new PoseStreamParseError(
        `Trajectory row has a non-numeric value: "${line}"`,
      );
    }
    // Reorder named columns into canonical order. Only when the row width matches
    // the header's (a malformed short row falls through to the width check below).
    if (columnOrder && nums.length === columnOrder.length) {
      nums = columnOrder.map((i) => nums[i]);
    }
    if (detectedCols === null) {
      if (nums.length !== QUAT_COLS && nums.length !== EULER_COLS) {
        throw new PoseStreamParseError(
          `Trajectory rows must have ${EULER_COLS} columns ` +
            `(t x y z roll pitch yaw) or ${QUAT_COLS} (t x y z qx qy qz qw); ` +
            `got ${nums.length}.`,
        );
      }
      detectedCols = nums.length;
    } else if (nums.length !== detectedCols) {
      throw new PoseStreamParseError(
        `Trajectory rows must all have the same width; expected ` +
          `${detectedCols} columns, got ${nums.length} in "${line}".`,
      );
    }
    rows.push(nums);
  }

  if (rows.length === 0) {
    throw new PoseStreamParseError('Trajectory file has no data rows.');
  }

  // Euler angle units: honor an explicit `eulerInDegrees`, else auto-detect. No sane
  // attitude in radians exceeds 2π (~6.28), so a roll/pitch/yaw magnitude above that
  // means the file is in DEGREES — which is what HELIOS++/SYSSIFOSS trajectories use.
  // This lets those files import correctly through the picker with no UI toggle.
  let useDegrees = options.eulerInDegrees ?? false;
  if (options.eulerInDegrees === undefined && detectedCols === EULER_COLS) {
    const maxAngle = rows.reduce(
      (mx, r) => Math.max(mx, Math.abs(r[4]), Math.abs(r[5]), Math.abs(r[6])),
      0,
    );
    if (maxAngle > 2 * Math.PI) useDegrees = true;
  }
  const toDeg = useDegrees ? Math.PI / 180 : 1;
  const poses: PoseSample[] = rows.map((r) => {
    const [t, x, y, z] = r;
    let qx: number, qy: number, qz: number, qw: number;
    if (detectedCols === QUAT_COLS) {
      [, , , , qx, qy, qz, qw] = r;
      // Normalize defensively so a slightly off-unit input still resolves cleanly.
      const n = Math.hypot(qx, qy, qz, qw) || 1;
      qx /= n; qy /= n; qz /= n; qw /= n;
    } else {
      [qx, qy, qz, qw] = quatFromRpy(r[4] * toDeg, r[5] * toDeg, r[6] * toDeg);
    }
    return { t, x, y, z, qx, qy, qz, qw };
  });

  for (let i = 1; i < poses.length; i++) {
    if (poses[i].t <= poses[i - 1].t) {
      throw new PoseStreamParseError(
        `Trajectory times must be strictly increasing; row ${i + 1} ` +
          `(t=${poses[i].t}) is not after row ${i} (t=${poses[i - 1].t}).`,
      );
    }
  }

  return {
    poses,
    frame: { ...DEFAULT_FRAME_META },
    leverArm: [0, 0, 0],
    boresightRpy: [0, 0, 0],
    sourceFormat: 'pose_csv',
    label: options.label,
  };
}

// Serialize to the backend wire shape (snake_case keys matching the Pydantic
// PoseStream). The renderer stores camelCase; the LAD request mapper calls this.
export function poseStreamToWire(stream: PoseStream): unknown {
  return {
    poses: stream.poses,
    frame: {
      crs: stream.frame.crs,
      up_axis: stream.frame.upAxis,
      body_convention: stream.frame.bodyConvention,
      time_ref: stream.frame.timeRef,
    },
    lever_arm: stream.leverArm,
    boresight_rpy: stream.boresightRpy,
    source_format: stream.sourceFormat,
  };
}

// Translate every pose position by SUBTRACTING `shift` ([x, y, z]), returning a
// new PoseStream (attitude, lever-arm, frame metadata unchanged). Used to move an
// imported trajectory into a cloud's stored frame: the import wizard's global
// shift is subtracted from the point cloud (stored = world − worldShift), so a
// trajectory attached at import — whose poses are in raw world/UTM coordinates —
// must have the SAME offset subtracted, or it would render millions of metres away
// from the shifted cloud and the LAD timestamp→origin join would be in the wrong
// frame. A null/zero shift returns the stream unchanged (no allocation churn).
export function shiftPoseStream(
  stream: PoseStream,
  shift: [number, number, number] | null | undefined,
): PoseStream {
  if (!shift || (shift[0] === 0 && shift[1] === 0 && shift[2] === 0)) return stream;
  const [sx, sy, sz] = shift;
  return {
    ...stream,
    poses: stream.poses.map((p) => ({ ...p, x: p.x - sx, y: p.y - sy, z: p.z - sz })),
  };
}

// Axis-aligned bounds of a pose stream's positions (attitude ignored). Returns
// null for an empty stream so callers can distinguish "no anchor" from a zero
// box at the origin. Used to derive a trajectory's representative anchor for
// frame-mismatch detection and to frame a newly imported trajectory in view.
export function poseStreamBounds(
  stream: PoseStream,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const poses = stream.poses;
  if (poses.length === 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of poses) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

// Inverse of poseStreamToWire: build a renderer PoseStream from the backend wire
// shape (snake_case), e.g. the JSON returned by POST /api/trajectory/parse for a
// binary SBET. Validates the poses array so a malformed payload surfaces as a
// PoseStreamParseError (caught by the import handler) rather than a silent bad join.
export function poseStreamFromWire(wire: unknown, label?: string): PoseStream {
  const w = wire as Record<string, unknown> | null;
  const rawPoses = w && Array.isArray(w.poses) ? (w.poses as unknown[]) : null;
  if (!rawPoses || rawPoses.length === 0) {
    throw new PoseStreamParseError('Trajectory response carried no poses.');
  }
  const poses: PoseSample[] = rawPoses.map((p, i) => {
    const o = p as Record<string, unknown>;
    const num = (k: string) => {
      const v = Number(o[k]);
      if (!Number.isFinite(v)) {
        throw new PoseStreamParseError(
          `Trajectory pose ${i} has a non-finite "${k}".`);
      }
      return v;
    };
    return {
      t: num('t'), x: num('x'), y: num('y'), z: num('z'),
      qx: num('qx'), qy: num('qy'), qz: num('qz'), qw: num('qw'),
    };
  });
  const frame = (w?.frame ?? {}) as Record<string, unknown>;
  const bodyConv = frame.body_convention === 'FRD' ? 'FRD' : 'FLU';
  const lever = Array.isArray(w?.lever_arm) ? (w!.lever_arm as number[]) : [0, 0, 0];
  const bore = Array.isArray(w?.boresight_rpy) ? (w!.boresight_rpy as number[]) : [0, 0, 0];
  const fmt = w?.source_format;
  const sourceFormat: PoseStream['sourceFormat'] =
    fmt === 'sbet' || fmt === 'las_extrabytes' || fmt === 'reconstructed' ||
    fmt === 'simulated' || fmt === 'pose_csv' ? fmt : 'sbet';
  return {
    poses,
    frame: {
      crs: typeof frame.crs === 'string' ? frame.crs : null,
      upAxis: 'z',
      bodyConvention: bodyConv,
      timeRef: typeof frame.time_ref === 'string' ? frame.time_ref : null,
    },
    leverArm: [lever[0] ?? 0, lever[1] ?? 0, lever[2] ?? 0],
    boresightRpy: [bore[0] ?? 0, bore[1] ?? 0, bore[2] ?? 0],
    sourceFormat,
    label: label ?? (typeof w?.label === 'string' ? (w.label as string) : undefined),
  };
}

// Duration of a trajectory in seconds (last pose time − first). 0 for a
// single-pose stream.
export function trajectoryDurationS(stream: PoseStream): number {
  const p = stream.poses;
  if (p.length < 2) return 0;
  return p[p.length - 1].t - p[0].t;
}

// The full-flight scan grid derived for a moving-platform scan, mirroring the
// backend `_derive_moving_scan_grid`. A real spinning sensor fires continuously at
// its PRF, spinning at a rate set by PRF ÷ per-revolution resolution, for the
// whole flight — so the total pulse count is ≈ PRF × duration and the cloud covers
// the entire path. The user sets resolution PER REVOLUTION (nTheta channels/zenith
// rows × nPhiPerRev azimuth steps); PRF is the instrument's fixed laser spec.
export interface MovingScanGrid {
  rotationRateHz: number;   // PRF ÷ (nTheta × nPhiPerRev), revolutions/second
  nRevolutions: number;     // rotationRate × flight duration
  totalPulses: number;      // ≈ PRF × duration (fired across the whole flight)
  durationS: number;
}

export function deriveMovingScanGrid(
  nTheta: number,
  nPhiPerRev: number,
  pulseRateHz: number,
  durationS: number,
): MovingScanGrid {
  const pulsesPerRev = Math.max(Math.round(nTheta) * Math.round(nPhiPerRev), 1);
  const rotationRateHz = pulseRateHz / pulsesPerRev;
  let nRevolutions = rotationRateHz * durationS;
  if (!(nRevolutions > 0) || !Number.isFinite(nRevolutions)) nRevolutions = 1;
  const nPhiTotal = Math.max(Math.round(nPhiPerRev * nRevolutions), 1);
  return {
    rotationRateHz,
    nRevolutions,
    totalPulses: Math.round(nTheta) * nPhiTotal,
    durationS,
  };
}
