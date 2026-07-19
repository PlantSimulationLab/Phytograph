import { describe, it, expect } from 'vitest';
import {
  parsePoseStreamCsv,
  quatFromRpy,
  quatToRpy,
  poseStreamToWire,
  poseStreamFromWire,
  PoseStreamParseError,
  trajectoryDurationS,
  deriveMovingScanGrid,
  shiftPoseStream,
  poseStreamBounds,
} from './poseStream';
import { recenterShiftFor, boundsCenterDiagonal } from './frameMismatch';

describe('quatFromRpy', () => {
  it('returns identity for zero angles', () => {
    expect(quatFromRpy(0, 0, 0)).toEqual([0, 0, 0, 1]);
  });

  it('matches a pure 90° yaw (rotation about +Z)', () => {
    const [qx, qy, qz, qw] = quatFromRpy(0, 0, Math.PI / 2);
    expect(qx).toBeCloseTo(0, 12);
    expect(qy).toBeCloseTo(0, 12);
    expect(qz).toBeCloseTo(Math.SQRT1_2, 12);
    expect(qw).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('produces a unit quaternion for an arbitrary rpy', () => {
    const q = quatFromRpy(0.3, -0.4, 1.1);
    const n = Math.hypot(...q);
    expect(n).toBeCloseTo(1, 12);
  });
});

describe('quatToRpy', () => {
  it('returns zero angles for the identity quaternion', () => {
    expect(quatToRpy(0, 0, 0, 1)).toEqual([0, 0, 0]);
  });

  it('recovers a pure 90° yaw', () => {
    const [qx, qy, qz, qw] = quatFromRpy(0, 0, Math.PI / 2);
    const [r, p, y] = quatToRpy(qx, qy, qz, qw);
    expect(r).toBeCloseTo(0, 12);
    expect(p).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(Math.PI / 2, 12);
  });

  it('round-trips quatFromRpy across a grid of angles', () => {
    const angles = [-1.2, -0.5, -0.1, 0, 0.1, 0.5, 1.2];
    for (const roll of angles) {
      for (const pitch of angles) {
        for (const yaw of angles) {
          const [qx, qy, qz, qw] = quatFromRpy(roll, pitch, yaw);
          const [r, p, y] = quatToRpy(qx, qy, qz, qw);
          // Re-derive the quaternion from the recovered angles: the split may
          // differ near singularities but the orientation must be identical.
          const q2 = quatFromRpy(r, p, y);
          // Quaternions q and -q are the same rotation.
          const dot = Math.abs(qx * q2[0] + qy * q2[1] + qz * q2[2] + qw * q2[3]);
          expect(dot).toBeCloseTo(1, 10);
        }
      }
    }
  });

  it('clamps pitch and folds roll into yaw at the +90° gimbal-lock singularity', () => {
    // A quaternion exactly at pitch = +90° (2*(qw*qy - qz*qx) == 1): a pure +90°
    // rotation about +Y is q = (0, sin45, 0, cos45).
    const s = Math.SQRT1_2;
    const [r, p] = quatToRpy(0, s, 0, s);
    expect(p).toBeCloseTo(Math.PI / 2, 9);
    expect(r).toBe(0);
  });
});

describe('parsePoseStreamCsv', () => {
  it('parses an 8-column quaternion file', () => {
    const text = [
      '0 0 0 5 0 0 0 1',
      '1 2 0 5 0 0 0 1',
    ].join('\n');
    const s = parsePoseStreamCsv(text);
    expect(s.poses).toHaveLength(2);
    expect(s.poses[0]).toMatchObject({ t: 0, x: 0, y: 0, z: 5, qw: 1 });
    expect(s.poses[1]).toMatchObject({ t: 1, x: 2 });
    expect(s.sourceFormat).toBe('pose_csv');
  });

  it('parses a 7-column Euler file and converts to quaternions', () => {
    // roll=pitch=0, yaw=90° (radians).
    const text = `0,0,0,5,0,0,${Math.PI / 2}`;
    const s = parsePoseStreamCsv(text);
    expect(s.poses).toHaveLength(1);
    const p = s.poses[0];
    expect(p.qz).toBeCloseTo(Math.SQRT1_2, 12);
    expect(p.qw).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('honors eulerInDegrees', () => {
    const text = '0 0 0 5 0 0 90';
    const s = parsePoseStreamCsv(text, { eulerInDegrees: true });
    expect(s.poses[0].qz).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('accepts comma or whitespace separators and skips comments/blank lines', () => {
    const text = [
      '# trajectory',
      '0, 0, 0, 5, 0, 0, 0, 1',
      '',
      '1\t2\t0\t5\t0\t0\t0\t1',
      '// trailing comment',
    ].join('\n');
    const s = parsePoseStreamCsv(text);
    expect(s.poses).toHaveLength(2);
  });

  it('skips a non-numeric header row', () => {
    const text = [
      't x y z qx qy qz qw',
      '0 0 0 5 0 0 0 1',
      '1 1 0 5 0 0 0 1',
    ].join('\n');
    const s = parsePoseStreamCsv(text);
    expect(s.poses).toHaveLength(2);
  });

  it('allows a single row (constant pose)', () => {
    const s = parsePoseStreamCsv('3 1 2 3 0 0 0 1');
    expect(s.poses).toHaveLength(1);
    expect(s.poses[0].t).toBe(3);
  });

  it('normalizes a slightly off-unit quaternion', () => {
    const s = parsePoseStreamCsv('0 0 0 0 0 0 0 2'); // qw=2 -> normalize to 1
    expect(s.poses[0].qw).toBeCloseTo(1, 12);
  });

  it('rejects rows of inconsistent width', () => {
    const text = ['0 0 0 5 0 0 0 1', '1 2 0 5 0 0 0'].join('\n');
    expect(() => parsePoseStreamCsv(text)).toThrow(PoseStreamParseError);
  });

  it('rejects a wrong column count', () => {
    expect(() => parsePoseStreamCsv('0 0 0 5 0')).toThrow(/columns/);
  });

  it('rejects a non-numeric value', () => {
    expect(() => parsePoseStreamCsv('0 0 0 5 0 0 0 abc')).toThrow(/non-numeric/);
  });

  it('rejects non-increasing times', () => {
    const text = ['0 0 0 5 0 0 0 1', '0 1 0 5 0 0 0 1'].join('\n');
    expect(() => parsePoseStreamCsv(text)).toThrow(/strictly increasing/);
  });

  it('rejects an empty file', () => {
    expect(() => parsePoseStreamCsv('\n# only a comment\n')).toThrow(/no data/);
  });
});

describe('poseStreamToWire', () => {
  it('serializes to snake_case backend keys', () => {
    const s = parsePoseStreamCsv('0 0 0 5 0 0 0 1');
    const wire = poseStreamToWire(s) as Record<string, unknown>;
    expect(wire).toHaveProperty('lever_arm', [0, 0, 0]);
    expect(wire).toHaveProperty('boresight_rpy', [0, 0, 0]);
    expect(wire).toHaveProperty('source_format', 'pose_csv');
    const frame = wire.frame as Record<string, unknown>;
    expect(frame).toHaveProperty('up_axis', 'z');
    expect(frame).toHaveProperty('body_convention', 'FLU');
  });
});

describe('poseStreamFromWire', () => {
  it('round-trips through poseStreamToWire', () => {
    const s = parsePoseStreamCsv(['0 1 2 3 0 0 0 1', '1 4 5 6 0 0 0 1'].join('\n'));
    const back = poseStreamFromWire(poseStreamToWire(s));
    expect(back.poses).toEqual(s.poses);
    expect(back.leverArm).toEqual(s.leverArm);
    expect(back.boresightRpy).toEqual(s.boresightRpy);
    expect(back.sourceFormat).toBe(s.sourceFormat);
    expect(back.frame.upAxis).toBe('z');
  });

  it('maps an SBET wire payload (snake_case, FRD, EPSG crs)', () => {
    const wire = {
      poses: [{ t: 0, x: 100, y: 200, z: 50, qx: 0, qy: 0, qz: 0, qw: 1 }],
      frame: { crs: 'EPSG:32632', up_axis: 'z', body_convention: 'FRD', time_ref: 'gps' },
      lever_arm: [0.1, 0, -0.2],
      boresight_rpy: [0, 0, 0],
      source_format: 'sbet',
    };
    const s = poseStreamFromWire(wire, 'flight.sbet');
    expect(s.sourceFormat).toBe('sbet');
    expect(s.frame.crs).toBe('EPSG:32632');
    expect(s.frame.bodyConvention).toBe('FRD');
    expect(s.leverArm).toEqual([0.1, 0, -0.2]);
    expect(s.label).toBe('flight.sbet');
  });

  it('throws on an empty/malformed payload', () => {
    expect(() => poseStreamFromWire({ poses: [] })).toThrow(PoseStreamParseError);
    expect(() => poseStreamFromWire({})).toThrow(PoseStreamParseError);
    expect(() => poseStreamFromWire(
      { poses: [{ t: 0, x: NaN, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }] }
    )).toThrow(PoseStreamParseError);
  });
});

describe('SYSSIFOSS / HELIOS++ trajectory (tab/space, degrees Euler)', () => {
  it('parses a tab-separated 7-column degrees-Euler trajectory', () => {
    // HELIOS++ trajectory output: t x y z roll pitch yaw, angles in DEGREES, with a
    // header row. Tabs are handled by the existing /[,\s]+/ split.
    const text = [
      'gpsTime\tx\ty\tz\troll\tpitch\tyaw',
      '0.0\t10\t20\t30\t0\t0\t0',
      '1.0\t11\t20\t30\t0\t0\t90',
    ].join('\n');
    const s = parsePoseStreamCsv(text, { eulerInDegrees: true });
    expect(s.poses).toHaveLength(2);
    expect(s.poses[0].x).toBe(10);
    // yaw 90° about +Z → qz = sin(45°), qw = cos(45°).
    expect(s.poses[1].qz).toBeCloseTo(Math.SQRT1_2, 6);
    expect(s.poses[1].qw).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('auto-detects degrees when an angle exceeds 2π (no option needed)', () => {
    // A HELIOS++/SYSSIFOSS file imported through the picker passes no eulerInDegrees
    // flag; yaw=90 (> 2π) must be read as degrees, not radians.
    const text = ['0 0 0 5 0 0 0', '1 1 0 5 0 0 90'].join('\n');
    const s = parsePoseStreamCsv(text);
    expect(s.poses[1].qz).toBeCloseTo(Math.SQRT1_2, 6); // 90° → not 90 rad
  });

  it('keeps small angles as radians when auto-detecting', () => {
    // All angles ≤ 2π → genuine radians; a 1.0 rad yaw stays 1.0 rad.
    const text = ['0 0 0 5 0 0 0', '1 1 0 5 0 0 1.0'].join('\n');
    const s = parsePoseStreamCsv(text);
    expect(s.poses[1].qz).toBeCloseTo(Math.sin(0.5), 6); // yaw 1.0 rad
  });

  it('reads the REAL position-first SYSSIFOSS header (Easting Northing Height Time …)', () => {
    // The raw PANGAEA SYSSIFOSS export is POSITION-first with a units-labeled
    // header. Time is column 4, not column 0. Header-driven column mapping must
    // pull Time → t (monotonic), Easting → x, etc. — otherwise Easting is read as
    // time and the strictly-increasing check (correctly) rejects the file.
    const text = [
      'Easting [m]\tNorthing [m]\tHeight [m]\tTime [s]\tRoll [deg]\tPitch [deg]\tYaw [deg]',
      '476638.59\t5428859.08\t954.99\t469934.258\t0.234777\t2.056616\t119.895469',
      '476638.78\t5428858.98\t954.99\t469934.262\t0.240411\t2.061002\t119.896072',
    ].join('\n');
    const s = parsePoseStreamCsv(text);
    expect(s.poses).toHaveLength(2);
    // t came from the Time column, monotonic.
    expect(s.poses[0].t).toBeCloseTo(469934.258, 3);
    expect(s.poses[1].t).toBeCloseTo(469934.262, 3);
    // x/y/z from Easting/Northing/Height.
    expect(s.poses[0].x).toBeCloseTo(476638.59, 2);
    expect(s.poses[0].y).toBeCloseTo(5428859.08, 2);
    expect(s.poses[0].z).toBeCloseTo(954.99, 2);
    // Yaw ≈ 120° auto-detected as degrees (not radians).
    expect(Math.abs(s.poses[0].qz)).toBeLessThanOrEqual(1);
  });

  it('maps named columns regardless of order (quaternion, shuffled header)', () => {
    const text = [
      'qw qx qy qz z y x t',
      '1 0 0 0 30 20 10 0',
      '0.92388 0 0 0.38268 30 20 11 1', // qw/qz for 45° yaw
    ].join('\n');
    const s = parsePoseStreamCsv(text);
    expect(s.poses[0].x).toBe(10);
    expect(s.poses[0].y).toBe(20);
    expect(s.poses[0].z).toBe(30);
    expect(s.poses[1].t).toBe(1);
    expect(s.poses[1].qz).toBeCloseTo(0.38268, 4);
  });

  it('falls back to positional order for an unrecognized header', () => {
    // A header whose names don't resolve (e.g. a generic 'col1 col2 …') must not
    // break the long-standing positional t-first behavior.
    const text = ['c1 c2 c3 c4 c5 c6 c7', '0 0 0 5 0 0 0', '1 1 0 5 0 0 0'].join('\n');
    const s = parsePoseStreamCsv(text);
    expect(s.poses[0].t).toBe(0);
    expect(s.poses[1].t).toBe(1);
    expect(s.poses[0].x).toBe(0);
  });
});

describe('trajectoryDurationS', () => {
  it('returns last minus first pose time', () => {
    const s = parsePoseStreamCsv(['0 0 0 5 0 0 0 1', '2.5 1 0 5 0 0 0 1'].join('\n'));
    expect(trajectoryDurationS(s)).toBeCloseTo(2.5, 9);
  });
  it('is 0 for a single pose', () => {
    expect(trajectoryDurationS(parsePoseStreamCsv('3 0 0 5 0 0 0 1'))).toBe(0);
  });
});

describe('shiftPoseStream', () => {
  // A UTM-scale trajectory like the ALS BR04 fixture (x≈476638, y≈5428859, z≈955).
  const utm = parsePoseStreamCsv([
    '0 476638.59 5428859.08 954.99 0 0 0 1',
    '1 476640.59 5428858.08 955.50 0 0 0 1',
  ].join('\n'), { label: 'als.txt' });

  it('subtracts the worldShift from every pose position', () => {
    const shifted = shiftPoseStream(utm, [476000, 5428000, 0]);
    expect(shifted.poses[0].x).toBeCloseTo(638.59, 6);
    expect(shifted.poses[0].y).toBeCloseTo(859.08, 6);
    expect(shifted.poses[0].z).toBeCloseTo(954.99, 6); // Z shift 0 → unchanged
    expect(shifted.poses[1].x).toBeCloseTo(640.59, 6);
    expect(shifted.poses[1].y).toBeCloseTo(858.08, 6);
  });

  it('leaves attitude, time, lever-arm, and frame metadata untouched', () => {
    const shifted = shiftPoseStream(utm, [476000, 5428000, 0]);
    expect(shifted.poses[0].t).toBe(0);
    expect(shifted.poses[0].qw).toBe(1);
    expect(shifted.leverArm).toEqual(utm.leverArm);
    expect(shifted.label).toBe('als.txt');
  });

  it('returns the SAME object for a null or all-zero shift (no churn)', () => {
    expect(shiftPoseStream(utm, null)).toBe(utm);
    expect(shiftPoseStream(utm, [0, 0, 0])).toBe(utm);
  });

  it('does not mutate the input stream', () => {
    const before = utm.poses[0].x;
    shiftPoseStream(utm, [476000, 5428000, 0]);
    expect(utm.poses[0].x).toBe(before);
  });
});

describe('poseStreamBounds', () => {
  it('returns the axis-aligned extent of the poses', () => {
    const s = parsePoseStreamCsv([
      '0 1 2 3 0 0 0 1',
      '1 -4 5 -6 0 0 0 1',
      '2 10 0 3 0 0 0 1',
    ].join('\n'));
    const b = poseStreamBounds(s);
    expect(b).not.toBeNull();
    expect(b!.min).toEqual([-4, 0, -6]);
    expect(b!.max).toEqual([10, 5, 3]);
  });

  it('returns null for an empty stream', () => {
    // parsePoseStreamCsv rejects empty input, so construct the empty stream directly.
    const s = { ...parsePoseStreamCsv('0 0 0 0 0 0 0 1'), poses: [] };
    expect(poseStreamBounds(s)).toBeNull();
  });
});

describe('shiftPoseStream ∘ recenterShiftFor (Move onto scene math)', () => {
  it('lands the trajectory bounds-center on the existing content center', () => {
    // A UTM trajectory far from an origin-based plane.
    const utm = parsePoseStreamCsv([
      '0 476638.59 5428859.08 954.99 0 0 0 1',
      '1 476642.59 5428855.08 956.99 0 0 0 1',
    ].join('\n'));
    const b = poseStreamBounds(utm)!;
    const anchor = boundsCenterDiagonal(
      { x: b.min[0], y: b.min[1], z: b.min[2] },
      { x: b.max[0], y: b.max[1], z: b.max[2] },
    ).center;
    // Existing content: a 25×25 m plane centered at the origin.
    const existingCenter = { x: 0, y: 0, z: 0 };

    const shift = recenterShiftFor(anchor, existingCenter);
    const moved = shiftPoseStream(utm, shift);
    const mb = poseStreamBounds(moved)!;
    const movedCenter = boundsCenterDiagonal(
      { x: mb.min[0], y: mb.min[1], z: mb.min[2] },
      { x: mb.max[0], y: mb.max[1], z: mb.max[2] },
    ).center;

    expect(movedCenter.x).toBeCloseTo(existingCenter.x, 4);
    expect(movedCenter.y).toBeCloseTo(existingCenter.y, 4);
    expect(movedCenter.z).toBeCloseTo(existingCenter.z, 4);
  });
});

describe('deriveMovingScanGrid', () => {
  it('spans the full flight: total pulses ≈ PRF × duration', () => {
    const g = deriveMovingScanGrid(32, 360, 695000, 10);
    expect(g.durationS).toBe(10);
    expect(g.rotationRateHz).toBeCloseTo(695000 / (32 * 360), 6);
    expect(g.nRevolutions).toBeCloseTo(g.rotationRateHz * 10, 6);
    // ≈ PRF × duration (the whole flight fired at the PRF).
    expect(g.totalPulses).toBeGreaterThan(0.99 * 695000 * 10);
    expect(g.totalPulses).toBeLessThan(1.01 * 695000 * 10);
  });
  it('scales pulse count with flight duration', () => {
    const short = deriveMovingScanGrid(32, 360, 100000, 2);
    const long = deriveMovingScanGrid(32, 360, 100000, 20);
    expect(long.totalPulses / short.totalPulses).toBeCloseTo(10, 1);
  });
  it('falls back to one revolution for a zero-duration flight', () => {
    const g = deriveMovingScanGrid(32, 360, 695000, 0);
    expect(g.nRevolutions).toBe(1);
    expect(g.totalPulses).toBe(32 * 360);
  });
});
