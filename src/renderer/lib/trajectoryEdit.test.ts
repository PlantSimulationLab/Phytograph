import { describe, it, expect } from 'vitest';
import {
  makeStarterDrafts,
  poseStreamToDrafts,
  draftsToPoseStream,
  appendPose,
  addPose,
  sortDraftsByTime,
  sampleTrajectoryAt,
  insertPoseBetween,
  deletePose,
  updatePoseField,
  renumberTimestampsEven,
  validateTimestamps,
  type PoseDraft,
} from './trajectoryEdit';
import { quatFromRpy, quatToRpy, type PoseStream } from './poseStream';

function draft(over: Partial<PoseDraft>): PoseDraft {
  return { id: 'x', t: 0, x: 0, y: 0, z: 0, rollDeg: 0, pitchDeg: 0, yawDeg: 0, ...over };
}

describe('draftsToPoseStream / poseStreamToDrafts', () => {
  it('round-trips a stream through drafts and back (orientation preserved)', () => {
    const [qx, qy, qz, qw] = quatFromRpy(0.2, -0.3, 1.0);
    const stream: PoseStream = {
      poses: [
        { t: 0, x: 1, y: 2, z: 3, qx: 0, qy: 0, qz: 0, qw: 1 },
        { t: 1, x: 4, y: 5, z: 6, qx, qy, qz, qw },
      ],
      frame: { crs: null, upAxis: 'z', bodyConvention: 'FLU', timeRef: null },
      leverArm: [0.1, 0, 0],
      boresightRpy: [0, 0, 0],
      sourceFormat: 'pose_csv',
    };
    const drafts = poseStreamToDrafts(stream);
    const out = draftsToPoseStream(drafts, {
      frame: stream.frame,
      leverArm: stream.leverArm,
      boresightRpy: stream.boresightRpy,
      label: 'x',
    });
    expect(out.poses).toHaveLength(2);
    out.poses.forEach((p, i) => {
      const src = stream.poses[i];
      expect(p.t).toBeCloseTo(src.t, 9);
      expect(p.x).toBeCloseTo(src.x, 9);
      expect(p.y).toBeCloseTo(src.y, 9);
      expect(p.z).toBeCloseTo(src.z, 9);
      // Same rotation (allow sign flip).
      const dot = Math.abs(p.qx * src.qx + p.qy * src.qy + p.qz * src.qz + p.qw * src.qw);
      expect(dot).toBeCloseTo(1, 8);
    });
    expect(out.sourceFormat).toBe('simulated');
    expect(out.leverArm).toEqual([0.1, 0, 0]);
  });
});

describe('makeStarterDrafts', () => {
  it('produces two distinct, time-ordered poses', () => {
    const d = makeStarterDrafts();
    expect(d).toHaveLength(2);
    expect(d[1].t).toBeGreaterThan(d[0].t);
    expect(validateTimestamps(d).ok).toBe(true);
  });
});

describe('insertPoseBetween', () => {
  it('inserts the linear + SLERP midpoint with a midpoint timestamp', () => {
    const drafts = [
      draft({ id: 'a', t: 0, x: 0, y: 0, z: 0, yawDeg: 0 }),
      draft({ id: 'b', t: 2, x: 4, y: 0, z: 0, yawDeg: 90 }),
    ];
    const out = insertPoseBetween(drafts, 0);
    expect(out).toHaveLength(3);
    const mid = out[1];
    expect(mid.t).toBeCloseTo(1, 9);
    expect(mid.x).toBeCloseTo(2, 9);
    expect(mid.y).toBeCloseTo(0, 9);
    // SLERP of 0° and 90° yaw is 45°.
    expect(mid.yawDeg).toBeCloseTo(45, 6);
  });

  it('is a no-op for an out-of-range index', () => {
    const drafts = [draft({ id: 'a' }), draft({ id: 'b', t: 1 })];
    expect(insertPoseBetween(drafts, 5)).toBe(drafts);
    expect(insertPoseBetween(drafts, 1)).toBe(drafts);
  });
});

describe('appendPose', () => {
  it('appends after the last pose with an increasing timestamp', () => {
    const drafts = [draft({ id: 'a', t: 0, x: 0 }), draft({ id: 'b', t: 1, x: 3 })];
    const out = appendPose(drafts);
    expect(out).toHaveLength(3);
    expect(out[2].t).toBeGreaterThan(out[1].t);
    // Continues the last segment direction (+3 in x).
    expect(out[2].x).toBeCloseTo(6, 9);
    expect(validateTimestamps(out).ok).toBe(true);
  });
});

describe('deletePose / updatePoseField', () => {
  it('deletes by index', () => {
    const drafts = [draft({ id: 'a' }), draft({ id: 'b', t: 1 }), draft({ id: 'c', t: 2 })];
    const out = deletePose(drafts, 1);
    expect(out.map((d) => d.id)).toEqual(['a', 'c']);
  });

  it('updates a single field immutably', () => {
    const drafts = [draft({ id: 'a', x: 0 })];
    const out = updatePoseField(drafts, 0, 'x', 5);
    expect(out[0].x).toBe(5);
    expect(drafts[0].x).toBe(0);
  });

  it('applies a time edit in place WITHOUT re-sorting (the caller defers the sort)', () => {
    const drafts = [
      draft({ id: 'a', t: 0 }),
      draft({ id: 'b', t: 1 }),
      draft({ id: 'c', t: 2 }),
    ];
    // Move pose 'a' to t=5 — order is preserved here; sorting happens later.
    const out = updatePoseField(drafts, 0, 't', 5);
    expect(out.map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(out[0].t).toBe(5);
  });

  it('does not reorder when a non-time field is edited', () => {
    const drafts = [draft({ id: 'a', t: 0 }), draft({ id: 'b', t: 1 })];
    const out = updatePoseField(drafts, 1, 'x', 9);
    expect(out.map((d) => d.id)).toEqual(['a', 'b']);
    expect(out[1].x).toBe(9);
  });
});

describe('sampleTrajectoryAt', () => {
  const drafts = [
    draft({ id: 'a', t: 0, x: 0, y: 0, z: 0, yawDeg: 0 }),
    draft({ id: 'b', t: 2, x: 4, y: 0, z: 0, yawDeg: 90 }),
  ];

  it('returns null for an empty trajectory', () => {
    expect(sampleTrajectoryAt([], 0.5)).toBeNull();
  });

  it('clamps to the first pose before the start', () => {
    const s = sampleTrajectoryAt(drafts, -1)!;
    expect(s[0]).toBeCloseTo(0, 9);
  });

  it('clamps to the last pose after the end', () => {
    const s = sampleTrajectoryAt(drafts, 5)!;
    expect(s[0]).toBeCloseTo(4, 9);
  });

  it('linearly interpolates position and SLERPs orientation mid-segment', () => {
    const s = sampleTrajectoryAt(drafts, 1)!; // halfway
    expect(s[0]).toBeCloseTo(2, 9); // x = midpoint of 0..4
    // Orientation is the SLERP-midpoint of yaw 0° and 90° → 45°.
    const [, , yaw] = quatToRpy(s[3], s[4], s[5], s[6]);
    expect((yaw * 180) / Math.PI).toBeCloseTo(45, 6);
  });
});

describe('sortDraftsByTime / addPose', () => {
  it('sorts ascending by time, stable on ties', () => {
    const drafts = [
      draft({ id: 'a', t: 2 }),
      draft({ id: 'b', t: 1 }),
      draft({ id: 'c', t: 1 }),
    ];
    const out = sortDraftsByTime(drafts);
    // b and c tie at t=1 and keep input order; a (t=2) last.
    expect(out.map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });

  it('addPose appends after the latest time and stays sorted', () => {
    const drafts = [draft({ id: 'a', t: 0, x: 0 }), draft({ id: 'b', t: 1, x: 3 })];
    const out = addPose(drafts);
    expect(out).toHaveLength(3);
    expect(validateTimestamps(out).ok).toBe(true);
    // The new pose has the largest time, so it is last.
    expect(out[out.length - 1].t).toBeGreaterThan(out[out.length - 2].t);
  });
});

describe('validateTimestamps / renumberTimestampsEven', () => {
  it('rejects a single pose', () => {
    expect(validateTimestamps([draft({ id: 'a' })]).ok).toBe(false);
  });

  it('flags the first non-increasing row (1-based)', () => {
    const drafts = [
      draft({ id: 'a', t: 0 }),
      draft({ id: 'b', t: 1 }),
      draft({ id: 'c', t: 1 }),
    ];
    const v = validateTimestamps(drafts);
    expect(v.ok).toBe(false);
    expect(v.badRow).toBe(3);
  });

  it('renumbers to a strictly increasing sequence', () => {
    const drafts = [
      draft({ id: 'a', t: 5 }),
      draft({ id: 'b', t: 5 }),
      draft({ id: 'c', t: 2 }),
    ];
    const out = renumberTimestampsEven(drafts);
    expect(validateTimestamps(out).ok).toBe(true);
    expect(out[0].t).toBe(5);
  });
});
