import { describe, it, expect } from 'vitest';
import {
  parsePoseStreamCsv,
  quatFromRpy,
  poseStreamToWire,
  PoseStreamParseError,
  trajectoryDurationS,
  deriveMovingScanGrid,
} from './poseStream';

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

describe('trajectoryDurationS', () => {
  it('returns last minus first pose time', () => {
    const s = parsePoseStreamCsv(['0 0 0 5 0 0 0 1', '2.5 1 0 5 0 0 0 1'].join('\n'));
    expect(trajectoryDurationS(s)).toBeCloseTo(2.5, 9);
  });
  it('is 0 for a single pose', () => {
    expect(trajectoryDurationS(parsePoseStreamCsv('3 0 0 5 0 0 0 1'))).toBe(0);
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
