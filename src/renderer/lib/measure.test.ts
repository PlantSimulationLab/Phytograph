import { describe, it, expect } from 'vitest';
import {
  deltas,
  distance,
  segmentLengths,
  totalLength,
  angleAt,
  measurementAngle,
  labelAnchor,
  formatLength,
  formatAngle,
  formatDelta,
  primaryValue,
  isComplete,
  autoCommitsAt,
  measurementsToCsv,
  measurementToText,
  type Measurement,
  type MeasureVertex,
} from './measure';
import type { Vec3 } from './pointPick';

// The E2E fixture (tests/e2e/fixtures/scalars.xyz) is a collinear ramp stepping
// (0.2, 0, 0.15) per point, so adjacent points are exactly 0.25 apart. Using
// the same numbers here keeps the unit and E2E expectations in one story.
const RAMP_STEP: Vec3 = [0.2, 0, 0.15];
const RAMP_SEGMENT = 0.25;

function v(world: Vec3, cloudId = 'cloud-a'): MeasureVertex {
  return { world, local: world, cloudId };
}

function measurement(kind: Measurement['kind'], worlds: Vec3[]): Measurement {
  return {
    id: 'm1',
    seq: 0,
    kind,
    vertices: worlds.map((w) => v(w)),
    hasShift: false,
  };
}

describe('distance', () => {
  it('measures a 3-4-5 triangle exactly', () => {
    expect(distance([0, 0, 0], [3, 4, 0])).toBe(5);
  });

  it('measures one ramp step as 0.25', () => {
    // sqrt(0.2^2 + 0.15^2) = sqrt(0.04 + 0.0225) = sqrt(0.0625) = 0.25
    expect(distance([0, 0, 0], RAMP_STEP)).toBeCloseTo(RAMP_SEGMENT, 12);
  });

  it('is zero for a point against itself', () => {
    expect(distance([1.5, -2, 3], [1.5, -2, 3])).toBe(0);
  });

  it('is symmetric', () => {
    expect(distance([1, 2, 3], [-4, 5, 6])).toBeCloseTo(distance([-4, 5, 6], [1, 2, 3]), 12);
  });
});

describe('deltas', () => {
  it('reports signed components from a to b', () => {
    const d = deltas([1, 2, 3], [4, 0, -1]);
    expect(d.dx).toBe(3);
    expect(d.dy).toBe(-2);
    expect(d.dz).toBe(-4);
    expect(d.dist).toBeCloseTo(Math.hypot(3, 2, 4), 12);
  });

  it('flips every sign when the endpoints swap', () => {
    const ab = deltas([1, 2, 3], [4, 0, -1]);
    const ba = deltas([4, 0, -1], [1, 2, 3]);
    expect(ba.dx).toBe(-ab.dx);
    expect(ba.dy).toBe(-ab.dy);
    expect(ba.dz).toBe(-ab.dz);
    // Distance is unsigned, so it survives the swap.
    expect(ba.dist).toBeCloseTo(ab.dist, 12);
  });
});

describe('polyline lengths', () => {
  it('produces N-1 segments for N vertices', () => {
    const vs = [v([0, 0, 0]), v([1, 0, 0]), v([1, 1, 0]), v([1, 1, 1])];
    expect(segmentLengths(vs)).toHaveLength(3);
  });

  it('totals the sum of its segments', () => {
    const vs = [v([0, 0, 0]), v([3, 4, 0]), v([3, 4, 12])];
    expect(segmentLengths(vs)).toEqual([5, 12]);
    expect(totalLength(vs)).toBe(17);
  });

  it('walks three ramp points as two 0.25 segments totalling 0.5', () => {
    const vs = [
      v([0, 0, 0]),
      v([0.2, 0, 0.15]),
      v([0.4, 0, 0.3]),
    ];
    for (const s of segmentLengths(vs)) expect(s).toBeCloseTo(RAMP_SEGMENT, 12);
    expect(totalLength(vs)).toBeCloseTo(0.5, 12);
  });

  it('is zero for a single vertex, with no segments', () => {
    expect(segmentLengths([v([1, 2, 3])])).toEqual([]);
    expect(totalLength([v([1, 2, 3])])).toBe(0);
  });

  it('is zero for an empty list', () => {
    expect(totalLength([])).toBe(0);
  });
});

describe('angleAt', () => {
  it('measures a right angle as 90', () => {
    expect(angleAt([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(90, 10);
  });

  it('measures a straight line as 180', () => {
    // Three consecutive ramp points are collinear.
    expect(angleAt([0, 0, 0], RAMP_STEP, [0.4, 0, 0.3])).toBeCloseTo(180, 8);
  });

  it('measures coincident directions as 0', () => {
    expect(angleAt([2, 0, 0], [0, 0, 0], [5, 0, 0])).toBeCloseTo(0, 10);
  });

  it('still RESOLVES an angle a hair off straight, where acos saturates to 180', () => {
    // The acos(dot/|u||v|) form collapses to exactly 180 once the deviation
    // drops below ~1e-8: the quotient rounds to -1 and the angle is lost. The
    // atan2(|cross|, dot) form keeps resolving it. 180 exactly is the tell that
    // someone swapped the formulation back.
    const deg = angleAt([-1, 0, 0], [0, 0, 0], [1, 1e-9, 0]);
    expect(deg).not.toBeNull();
    expect(deg!).toBeLessThan(180);
    expect(deg!).toBeGreaterThan(179.9999);
  });

  it('still resolves an angle a hair off zero', () => {
    // The mirror case: acos saturates to 0 as the quotient rounds to +1.
    const deg = angleAt([1, 0, 0], [0, 0, 0], [1, 1e-9, 0]);
    expect(deg).not.toBeNull();
    expect(deg!).toBeGreaterThan(0);
    expect(deg!).toBeLessThan(0.0001);
  });

  it('never returns NaN for a numerically degenerate near-straight angle', () => {
    // Float error can push dot/|u||v| just past -1, where acos returns NaN
    // outright. atan2 has no domain to leave.
    for (const eps of [1e-10, 1e-12, 1e-15, 0]) {
      const deg = angleAt([-1, 0, 0], [0, 0, 0], [1, eps, 0]);
      expect(deg).not.toBeNull();
      expect(Number.isNaN(deg!)).toBe(false);
    }
  });

  it('returns null rather than NaN for a zero-length arm', () => {
    // Clicking the same point twice is easy to do; acos(0/0) would poison the
    // readout with NaN.
    expect(angleAt([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNull();
    expect(angleAt([1, 0, 0], [0, 0, 0], [0, 0, 0])).toBeNull();
  });

  it('is independent of arm length', () => {
    const near = angleAt([1, 0, 0], [0, 0, 0], [0, 1, 0]);
    const far = angleAt([1000, 0, 0], [0, 0, 0], [0, 0.001, 0]);
    expect(far).toBeCloseTo(near!, 10);
  });

  it('never exceeds 180 regardless of vertex order', () => {
    const deg = angleAt([0, 1, 0], [0, 0, 0], [1, 0, 0]);
    expect(deg!).toBeGreaterThanOrEqual(0);
    expect(deg!).toBeLessThanOrEqual(180);
  });
});

describe('measurementAngle', () => {
  it('reads the angle of a 3-vertex measurement', () => {
    const m = measurement('angle', [[1, 0, 0], [0, 0, 0], [0, 1, 0]]);
    expect(measurementAngle(m)).toBeCloseTo(90, 10);
  });

  it('is null for anything that is not three vertices', () => {
    expect(measurementAngle(measurement('distance', [[0, 0, 0], [1, 0, 0]]))).toBeNull();
    expect(measurementAngle(measurement('polyline', [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]])))
      .toBeNull();
  });
});

describe('completion rules', () => {
  it('needs two vertices for a distance and three for an angle', () => {
    expect(isComplete('distance', 1)).toBe(false);
    expect(isComplete('distance', 2)).toBe(true);
    expect(isComplete('angle', 2)).toBe(false);
    expect(isComplete('angle', 3)).toBe(true);
  });

  it('treats a polyline as complete from two vertices on', () => {
    expect(isComplete('polyline', 1)).toBe(false);
    expect(isComplete('polyline', 2)).toBe(true);
    expect(isComplete('polyline', 9)).toBe(true);
  });

  it('auto-commits a distance and an angle but never a polyline', () => {
    // This is the whole behavioural difference: a polyline keeps growing until
    // the user closes it, so it must not commit itself at two vertices.
    expect(autoCommitsAt('distance', 2)).toBe(true);
    expect(autoCommitsAt('angle', 3)).toBe(true);
    expect(autoCommitsAt('polyline', 2)).toBe(false);
    expect(autoCommitsAt('polyline', 20)).toBe(false);
  });
});

describe('labelAnchor', () => {
  it('puts a distance label at the segment midpoint', () => {
    const m = measurement('distance', [[0, 0, 0], [2, 4, 6]]);
    expect(labelAnchor(m)).toEqual([1, 2, 3]);
  });

  it('puts an angle label at the vertex the angle is measured at', () => {
    const m = measurement('angle', [[1, 0, 0], [9, 9, 9], [0, 1, 0]]);
    expect(labelAnchor(m)).toEqual([9, 9, 9]);
  });

  it('trails a polyline label at the last vertex', () => {
    const m = measurement('polyline', [[0, 0, 0], [1, 0, 0], [7, 8, 9]]);
    expect(labelAnchor(m)).toEqual([7, 8, 9]);
  });

  it('is null for an empty measurement', () => {
    expect(labelAnchor(measurement('distance', []))).toBeNull();
  });

  it('anchors from local, not world', () => {
    // The scene renders from `local`; anchoring from `world` is invisible until
    // a UTM-scale import, which is exactly why it is asserted here.
    const m: Measurement = {
      id: 'm', seq: 0, kind: 'distance', hasShift: true,
      vertices: [
        { world: [545000, 4183000, 10], local: [0, 0, 10], cloudId: 'a' },
        { world: [545002, 4183000, 10], local: [2, 0, 10], cloudId: 'a' },
      ],
    };
    expect(labelAnchor(m)).toEqual([1, 0, 10]);
  });
});

describe('formatLength', () => {
  it('drops to 2 decimals for large values', () => {
    expect(formatLength(123.456789)).toBe('123.46');
  });

  it('uses 3 decimals in the metre range', () => {
    expect(formatLength(1.23456)).toBe('1.235');
    expect(formatLength(0.25)).toBe('0.250');
  });

  it('keeps 3 decimals down to a millimetre', () => {
    // Sub-metre is the common case here, and it matches the 3-decimal
    // coordinate rows shown directly above the length in the same bubble.
    expect(formatLength(0.012345)).toBe('0.012');
    expect(formatLength(0.0012)).toBe('0.001');
  });

  it('goes exponential below a millimetre rather than printing zeros', () => {
    expect(formatLength(0.0000123)).toBe('1.230e-5');
  });

  it('prints an exact zero plainly', () => {
    expect(formatLength(0)).toBe('0.000');
  });

  it('degrades non-finite values to a dash', () => {
    expect(formatLength(NaN)).toBe('—');
    expect(formatLength(Infinity)).toBe('—');
  });

  it('carries no unit suffix', () => {
    // Scene units are not known to be metres, so the readout must not claim one.
    expect(formatLength(1.5)).not.toMatch(/[a-zA-Z]/);
  });
});

describe('formatAngle', () => {
  it('prints one decimal', () => {
    expect(formatAngle(90)).toBe('90.0');
    expect(formatAngle(179.96)).toBe('180.0');
  });

  it('degrades null and non-finite to a dash', () => {
    expect(formatAngle(null)).toBe('—');
    expect(formatAngle(NaN)).toBe('—');
  });
});

describe('formatDelta', () => {
  it('keeps the sign so a component reads as a direction', () => {
    expect(formatDelta(1.5)).toBe('1.500');
    expect(formatDelta(-1.5)).toBe('−1.500');
  });

  it('prints zero without a sign', () => {
    expect(formatDelta(0)).toBe('0.000');
  });
});

describe('primaryValue', () => {
  it('reports a length for a distance', () => {
    expect(primaryValue(measurement('distance', [[0, 0, 0], [3, 4, 0]]))).toBe('5.000');
  });

  it('reports the total for a polyline', () => {
    expect(primaryValue(measurement('polyline', [[0, 0, 0], [3, 4, 0], [3, 4, 12]])))
      .toBe('17.000');
  });

  it('reports degrees for an angle', () => {
    expect(primaryValue(measurement('angle', [[1, 0, 0], [0, 0, 0], [0, 1, 0]]))).toBe('90.0');
  });
});

describe('clipboard serialisation', () => {
  it('writes a summary row plus one row per vertex', () => {
    const csv = measurementsToCsv([measurement('distance', [[0, 0, 0], [3, 4, 0]])]);
    const lines = csv.split('\n');
    // header + 1 summary + 2 vertices
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('kind');
    expect(lines[0]).toContain('world_x');
    expect(lines[1]).toContain('distance');
    expect(lines[1]).toContain('5.000');
  });

  it('carries the vertex coordinates so the number can be re-derived', () => {
    const csv = measurementsToCsv([measurement('distance', [[1.5, 2.5, 3.5], [4.5, 6.5, 3.5]])]);
    expect(csv).toContain('1.500,2.500,3.500');
    expect(csv).toContain('4.500,6.500,3.500');
  });

  it('records the angle for an angle measurement', () => {
    const csv = measurementsToCsv([measurement('angle', [[1, 0, 0], [0, 0, 0], [0, 1, 0]])]);
    expect(csv.split('\n')[1]).toContain('90.0');
  });

  it('quotes a value containing a comma', () => {
    const m = measurement('distance', [[0, 0, 0], [1, 0, 0]]);
    m.id = 'has,comma';
    expect(measurementsToCsv([m])).toContain('"has,comma"');
  });

  it('serialises several measurements into one sheet', () => {
    const a = measurement('distance', [[0, 0, 0], [1, 0, 0]]);
    const b = { ...measurement('angle', [[1, 0, 0], [0, 0, 0], [0, 1, 0]]), id: 'm2' };
    const lines = measurementsToCsv([a, b]).split('\n');
    // header + (1 + 2) + (1 + 3)
    expect(lines).toHaveLength(8);
  });

  it('produces only a header for an empty list', () => {
    expect(measurementsToCsv([]).split('\n')).toHaveLength(1);
  });
});

describe('measurementToText', () => {
  it('reports a distance with its components', () => {
    const text = measurementToText(measurement('distance', [[0, 0, 0], [3, 4, 0]]));
    expect(text).toContain('Distance');
    expect(text).toContain('length\t5.000');
    expect(text).toContain('dX\t3.000');
    expect(text).toContain('dY\t4.000');
    expect(text).toContain('dZ\t0.000');
  });

  it('reports a polyline with its per-segment breakdown', () => {
    const text = measurementToText(
      measurement('polyline', [[0, 0, 0], [3, 4, 0], [3, 4, 12]]),
    );
    expect(text).toContain('length\t17.000');
    expect(text).toContain('segments\t2');
    expect(text).toContain('seg 1\t5.000');
    expect(text).toContain('seg 2\t12.000');
  });

  it('reports an angle with both arm lengths', () => {
    const text = measurementToText(measurement('angle', [[2, 0, 0], [0, 0, 0], [0, 3, 0]]));
    expect(text).toContain('angle\t90.0');
    expect(text).toContain('arm 1\t2.000');
    expect(text).toContain('arm 2\t3.000');
  });

  it('lists every vertex coordinate', () => {
    const text = measurementToText(measurement('distance', [[1, 2, 3], [4, 5, 6]]));
    expect(text).toContain('P1');
    expect(text).toContain('P2');
    expect(text).toContain('X 1.000');
  });
});

describe('CSV coordinate precision', () => {
  it('keeps millimetre precision on UTM-scale coordinates', () => {
    // formatLength drops to 2 decimals above 100, which would print a UTM
    // easting a digit coarser than the inspect bubble reports for the very
    // same point. Vertex coordinates go through formatCoord instead.
    const m: Measurement = {
      id: 'm', seq: 0, kind: 'distance', hasShift: true,
      vertices: [
        { world: [500123.4567, 4000987.6543, 12.3456], local: [0, 0, 0], cloudId: 'a' },
        { world: [500124.4567, 4000987.6543, 12.3456], local: [1, 0, 0], cloudId: 'a' },
      ],
    };
    const csv = measurementsToCsv(m ? [m] : []);
    expect(csv).toContain('500123.457');
    expect(csv).toContain('4000987.654');
    // And NOT the 2-decimal length rendering.
    expect(csv).not.toContain('500123.46,');
  });

  it('names the delta columns as a chord, since a polyline total is not a chord', () => {
    const csv = measurementsToCsv([measurement('polyline', [[0, 0, 0], [3, 4, 0], [3, 4, 12]])]);
    expect(csv.split('\n')[0]).toContain('chord_dx');
    expect(csv.split('\n')[0]).not.toMatch(/,dx,/);
  });
});

describe('world vs local for cross-cloud measurement', () => {
  it('measures in world space, so two differently-shifted clouds are correct', () => {
    // Cloud A is shifted by 545000 and cloud B is not. In LOCAL space these two
    // vertices look 1 unit apart; in WORLD space they are genuinely 545000 apart.
    // Measuring in local space here would report a confidently wrong number.
    const vs: MeasureVertex[] = [
      { world: [545000, 0, 0], local: [0, 0, 0], cloudId: 'a' },
      { world: [545001, 0, 0], local: [1, 0, 0], cloudId: 'a' },
    ];
    expect(totalLength(vs)).toBe(1);

    const cross: MeasureVertex[] = [
      { world: [545000, 0, 0], local: [0, 0, 0], cloudId: 'a' },
      { world: [1, 0, 0], local: [1, 0, 0], cloudId: 'b' },
    ];
    expect(totalLength(cross)).toBeCloseTo(544999, 6);
  });
});
