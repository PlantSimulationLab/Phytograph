import { describe, it, expect, afterEach } from 'vitest';
import {
  displayToLocal,
  localToWorld,
  hasNonZeroShift,
  formatCoord,
  formatScalar,
  buildAttributeRows,
  flatCloudAttributeValues,
  flatCloudRanges,
  pickedPointsToCsv,
  pickedPointToText,
  labelOffsetFor,
  worldPerPixel,
  nearSurfaceDistance,
  pickProbeOffsets,
  chooseNearestCandidate,
  type PickedPoint,
} from './pointPick';
import {
  registerCategoricalSlug,
  unregisterCategoricalSlug,
  registerContinuousSlug,
  unregisterContinuousSlug,
} from './classification';

// The classification registries are module-level (process-wide), so any test
// that registers a slug must clean up or it leaks into the next test file.
afterEach(() => {
  unregisterCategoricalSlug('deviation');
  unregisterContinuousSlug('is_miss');
});

describe('frame conversion', () => {
  it('adds the display offset to get back to the app frame', () => {
    // The scene renders at (world − displayOffset), so a pick at display
    // (10, 20, 30) under a 545000/4183000 offset is really out at UTM scale.
    expect(displayToLocal({ x: 10, y: 20, z: 30 }, { x: 545000, y: 4183000, z: 0 }))
      .toEqual([545010, 4183020, 30]);
  });

  it('is a no-op for a zero / absent display offset', () => {
    expect(displayToLocal({ x: 1.5, y: -2, z: 0.25 }, { x: 0, y: 0, z: 0 }))
      .toEqual([1.5, -2, 0.25]);
    expect(displayToLocal({ x: 1.5, y: -2, z: 0.25 }, null))
      .toEqual([1.5, -2, 0.25]);
  });

  it('adds the global shift to recover true file coordinates', () => {
    // worldShift is SUBTRACTED at import, so world = stored + worldShift.
    expect(localToWorld([37.184, 883.902, 61.447], [412000, 4271000, 0]))
      .toEqual([412037.184, 4271883.902, 61.447]);
  });

  it('composes display → local → world across both offsets', () => {
    const local = displayToLocal({ x: 3, y: 4, z: 5 }, { x: 100, y: 200, z: 0 });
    expect(localToWorld(local, [545000, 4183000, 0]))
      .toEqual([545103, 4183204, 5]);
  });

  it('treats a missing or all-zero shift as no shift', () => {
    expect(hasNonZeroShift(null)).toBe(false);
    expect(hasNonZeroShift(undefined)).toBe(false);
    expect(hasNonZeroShift([0, 0, 0])).toBe(false);
    expect(hasNonZeroShift([0, 0, -3])).toBe(true);
  });
});

describe('formatting', () => {
  it('prints coordinates at millimetre resolution, including UTM magnitudes', () => {
    expect(formatCoord(61.4472)).toBe('61.447');
    expect(formatCoord(4271883.9019)).toBe('4271883.902');
    expect(formatCoord(-0.0004)).toBe('-0.000');
  });

  it('degrades non-finite coordinates to a dash rather than NaN', () => {
    expect(formatCoord(NaN)).toBe('—');
    expect(formatCoord(Infinity)).toBe('—');
  });

  it('prints integers bare and scales precision to magnitude', () => {
    expect(formatScalar(3)).toBe('3');
    expect(formatScalar(0)).toBe('0');
    expect(formatScalar(0.7321)).toBe('0.732100');
    expect(formatScalar(12.5)).toBe('12.5000');
    expect(formatScalar(1234.5678)).toBe('1234.568');
    expect(formatScalar(NaN)).toBe('—');
  });

  it('keeps a big GPS timestamp positional rather than exponential', () => {
    // 1.2e9-scale timestamps are the motivating large-magnitude case; the
    // seconds are the whole reason someone picks the point.
    expect(formatScalar(1234567890.125)).toBe('1234567890.125');
    expect(formatScalar(1234567890)).toBe('1234567890');
  });

  it('uses exponential only where toFixed would round to zero', () => {
    expect(formatScalar(1.25e-7)).toBe('1.2500e-7');
  });
});

describe('buildAttributeRows', () => {
  it('drops potree internals and keeps real attributes', () => {
    const rows = buildAttributeRows({
      position: { x: 1, y: 2, z: 3 },
      normal: { x: 0, y: 0, z: 1 },
      pointCloud: {},
      indices: 4,
      spacing: 0.1,
      intensity: 0.732,
    });
    expect(rows.map((r) => r.slug)).toEqual(['intensity']);
  });

  it('keeps intensity, which the colour-by dropdown deliberately hides', () => {
    // octreeScalarFieldOptions filters `intensity` out of the Color by list
    // because it owns a dedicated colour mode — but a point picker that hid a
    // point's intensity would be missing the point.
    const rows = buildAttributeRows({ intensity: 1200 });
    expect(rows).toHaveLength(1);
    expect(rows[0].display).toBe('1200');
  });

  it('drops the degenerate LAS schema dimensions PotreeConverter always writes', () => {
    // An ASCII import still gets the full default LAS schema in its octree, so
    // without this filter every bubble carries half a dozen all-zero rows.
    const rows = buildAttributeRows({
      'return number': 0,
      'number of returns': 0,
      'scan angle rank': 0,
      'user data': 0,
      'point source id': 0,
      'gps-time': 0,
      Deviation: 2,
    });
    expect(rows.map((r) => r.slug)).toEqual(['Deviation']);
  });

  it('keeps a real LAS file\'s standard dimensions, which import as las_* extras', () => {
    const rows = buildAttributeRows({ las_classification: 2, las_scan_angle: -7 });
    expect(rows.map((r) => r.slug).sort()).toEqual(['las_classification', 'las_scan_angle']);
  });

  it('applies display labels and sorts rows by label', () => {
    const rows = buildAttributeRows(
      { Timestamp_s: 100, Deviation: 2 },
      { labels: { Timestamp_s: 'Timestamp [s]', Deviation: 'Deviation' } },
    );
    expect(rows.map((r) => r.label)).toEqual(['Deviation', 'Timestamp [s]']);
  });

  it('resolves a registered categorical attribute to its class name', () => {
    const rows = buildAttributeRows({ ground_class: 2 });
    expect(rows[0].display).toBe('2 (Non-ground)');
    expect(rows[0].value).toBe(2);
  });

  it('resolves wood_class and is_miss through their fixed schemes', () => {
    expect(buildAttributeRows({ wood_class: 1 })[0].display).toBe('1 (Wood)');
    expect(buildAttributeRows({ is_miss: 0 })[0].display).toBe('0 (Hit)');
  });

  it('builds a range-derived scheme for tree_instance', () => {
    const rows = buildAttributeRows(
      { tree_instance: 3 },
      { ranges: { tree_instance: { min: [0], max: [5] } } },
    );
    expect(rows[0].display).toBe('3 (Tree 3)');
  });

  it('honours a wizard-marked categorical slug via its observed range', () => {
    registerCategoricalSlug('deviation');
    const rows = buildAttributeRows(
      { deviation: 2 },
      { ranges: { deviation: { min: [0], max: [4] } } },
    );
    expect(rows[0].display).toBe('2 (Class 2)');
  });

  it('honours a wizard "Scalar" override over a registered scheme', () => {
    registerContinuousSlug('is_miss');
    expect(buildAttributeRows({ is_miss: 1 })[0].display).toBe('1');
  });

  it('rounds a float32-quantised class value to its class', () => {
    // Class labels round-trip through float32 buffers, so 2 can come back as
    // 1.9999999.
    expect(buildAttributeRows({ ground_class: 1.9999999 })[0].display).toBe('2 (Non-ground)');
  });

  it('collapses an rgba attribute to one row and drops other vector values', () => {
    const rows = buildAttributeRows({ rgba: [255, 128, 0, 255], someVec: [1, 2] });
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('rgba');
    expect(rows[0].display).toBe('255, 128, 0');
  });

  it('drops NaN and non-numeric values instead of printing them', () => {
    const rows = buildAttributeRows({ good: 1, bad: NaN, worse: 'hello', worst: null });
    expect(rows.map((r) => r.slug)).toEqual(['good']);
  });

  it('returns an empty list for an empty bag', () => {
    expect(buildAttributeRows({})).toEqual([]);
  });
});

describe('flat-cloud sampling', () => {
  const data = {
    intensities: new Float32Array([0.1, 0.2, 0.3]),
    scalarFields: {
      ground_class: { values: new Float32Array([1, 2, 2]), min: 1, max: 2 },
      Deviation: { values: new Float32Array([0, 1, 2]), min: 0, max: 2 },
    },
  };

  it('samples every per-point array at one index', () => {
    const vals = flatCloudAttributeValues(data, 1);
    expect(vals.intensity).toBeCloseTo(0.2, 6);
    expect(vals.ground_class).toBe(2);
    expect(vals.Deviation).toBe(1);
  });

  it('feeds straight into buildAttributeRows with the derived ranges', () => {
    const rows = buildAttributeRows(
      flatCloudAttributeValues(data, 0),
      { ranges: flatCloudRanges(data) },
    );
    const byslug = Object.fromEntries(rows.map((r) => [r.slug, r.display]));
    expect(byslug.ground_class).toBe('1 (Ground)');
    expect(byslug.Deviation).toBe('0');
  });

  it('reshapes scalar-field min/max into the octree attributeRanges form', () => {
    expect(flatCloudRanges(data)).toEqual({
      ground_class: { min: [1], max: [2] },
      Deviation: { min: [0], max: [2] },
    });
  });

  it('skips arrays shorter than the index rather than reading undefined', () => {
    expect(flatCloudAttributeValues(data, 99)).toEqual({});
  });

  it('tolerates a cloud with no intensities and no scalar fields', () => {
    expect(flatCloudAttributeValues({}, 0)).toEqual({});
    expect(flatCloudRanges({})).toEqual({});
  });
});

describe('clipboard serialisation', () => {
  const a: PickedPoint = {
    id: 'p1',
    seq: 0,
    cloudId: 'c1',
    cloudLabel: 'scalars.xyz',
    world: [412037.184, 4271883.902, 61.447],
    local: [37.184, 883.902, 61.447],
    hasShift: true,
    attributes: [
      { slug: 'Deviation', label: 'Deviation', value: 2, display: '2' },
      { slug: 'intensity', label: 'intensity', value: 0.5, display: '0.500000' },
    ],
    sourceIndex: 4,
  };
  const b: PickedPoint = {
    id: 'p2',
    seq: 1,
    cloudId: 'c2',
    cloudLabel: 'tree, big.xyz',
    world: [1, 2, 3],
    local: [1, 2, 3],
    hasShift: false,
    attributes: [{ slug: 'ground_class', label: 'Ground class', value: 2, display: '2 (Non-ground)' }],
  };

  it('unions attribute columns across points, in first-appearance order', () => {
    const lines = pickedPointsToCsv([a, b]).split('\n');
    expect(lines[0]).toBe(
      'scan,world_x,world_y,world_z,local_x,local_y,local_z,index,Deviation,intensity,ground_class',
    );
    expect(lines).toHaveLength(3);
  });

  it('writes coordinates at millimetre precision and leaves absent cells empty', () => {
    const lines = pickedPointsToCsv([a, b]).split('\n');
    expect(lines[1]).toBe('scalars.xyz,412037.184,4271883.902,61.447,37.184,883.902,61.447,4,2,0.5,');
    // b has no index and none of a's attributes.
    expect(lines[2]).toBe('tree, big.xyz,1.000,2.000,3.000,1.000,2.000,3.000,,,,2'
      .replace('tree, big.xyz', '"tree, big.xyz"'));
  });

  it('quotes a scan name containing a comma', () => {
    expect(pickedPointsToCsv([b])).toContain('"tree, big.xyz"');
  });

  it('emits a header-only document for no points', () => {
    expect(pickedPointsToCsv([]).split('\n')).toHaveLength(1);
  });

  it('prints both frames in the per-point text when the cloud is shifted', () => {
    const text = pickedPointToText(a);
    expect(text.split('\n')[0]).toBe('scalars.xyz');
    expect(text).toContain('X\t412037.184\t(local 37.184)');
    expect(text).toContain('index\t4');
    expect(text).toContain('Deviation\t2');
  });

  it('prints one coordinate column when the cloud has no shift', () => {
    const text = pickedPointToText(b);
    expect(text).toContain('X\t1.000');
    expect(text).not.toContain('local');
    expect(text).not.toContain('index');
  });
});

describe('labelOffsetFor', () => {
  it('steps successive labels away from each other', () => {
    expect(labelOffsetFor(1).dx).toBeGreaterThan(labelOffsetFor(0).dx);
    expect(labelOffsetFor(1).dy).toBeGreaterThan(labelOffsetFor(0).dy);
  });

  it('cycles so offsets stay near the point instead of drifting off-screen', () => {
    expect(labelOffsetFor(5)).toEqual(labelOffsetFor(0));
    expect(labelOffsetFor(12)).toEqual(labelOffsetFor(2));
  });

  it('handles a negative sequence without producing a negative step', () => {
    expect(labelOffsetFor(-1)).toEqual(labelOffsetFor(4));
  });
});

describe('worldPerPixel', () => {
  const persp = { isPerspectiveCamera: true as const, fov: 50 };

  it('scales linearly with distance under a perspective camera', () => {
    // Twice as far away ⇒ each pixel spans twice as much world.
    const near = worldPerPixel(persp, 1000, 10);
    const far = worldPerPixel(persp, 1000, 20);
    expect(far / near).toBeCloseTo(2, 10);
  });

  it('matches the frustum height at a known distance', () => {
    // Frustum height at distance d is 2·d·tan(fov/2); over 1000 px rows that
    // is the per-pixel span.
    const expected = (2 * 10 * Math.tan((50 * Math.PI) / 360)) / 1000;
    expect(worldPerPixel(persp, 1000, 10)).toBeCloseTo(expected, 12);
  });

  it('ignores distance under an orthographic camera', () => {
    const ortho = { top: 5, bottom: -5, zoom: 1 };
    expect(worldPerPixel(ortho, 500, 1)).toBeCloseTo(worldPerPixel(ortho, 500, 9999), 12);
    expect(worldPerPixel(ortho, 500, 1)).toBeCloseTo(10 / 500, 12);
  });

  it('divides the ortho span by zoom', () => {
    const zoomed = { top: 5, bottom: -5, zoom: 4 };
    expect(worldPerPixel(zoomed, 500, 1)).toBeCloseTo(10 / 4 / 500, 12);
  });

  it('treats zoom 0 as 1 rather than dividing by zero', () => {
    expect(worldPerPixel({ top: 5, bottom: -5, zoom: 0 }, 500, 1)).toBeCloseTo(10 / 500, 12);
  });

  it('returns 0 for a zero-height viewport instead of Infinity', () => {
    expect(worldPerPixel(persp, 0, 10)).toBe(0);
  });
});

describe('nearSurfaceDistance', () => {
  it('measures to the near surface, not the centre', () => {
    // Camera 100 m from the centre of a 40 m-radius cloud: the closest visible
    // points are 60 m out, not 100.
    expect(nearSurfaceDistance(100, 40)).toBeCloseTo(60, 12);
  });

  it('keeps the near half of a deep cloud clickable', () => {
    // The regression this exists for. A 100 m-deep scan viewed end-on, camera
    // 10 m off its near face: centre-based sizing computed the tolerance for a
    // point 60 m away, ~6x too large in world terms for the near face — which
    // in practice meant the pixel tolerance the user experienced at the near
    // points was far off the intended one.
    const cameraToCenter = 60;
    const radius = 50;
    const centreBased = cameraToCenter;
    const nearBased = nearSurfaceDistance(cameraToCenter, radius);

    expect(nearBased).toBeCloseTo(10, 12);
    // Sizing from the centre over-states the near-face distance six-fold.
    expect(centreBased / nearBased).toBeCloseTo(6, 10);
  });

  it('scales the radius by the object matrix', () => {
    // A cloud scaled 2x has a world radius twice its local one.
    expect(nearSurfaceDistance(100, 20, 2)).toBeCloseTo(60, 12);
  });

  it('stays positive when the camera is inside the cloud', () => {
    // Camera 5 m from the centre of a 50 m-radius cloud is deep inside it; a
    // naive subtraction gives -45, which would invert the tolerance.
    const d = nearSurfaceDistance(5, 50);
    expect(d).toBeGreaterThan(0);
    expect(Number.isFinite(d)).toBe(true);
  });

  it('is a no-op for a degenerate zero-radius bound', () => {
    expect(nearSurfaceDistance(42, 0)).toBeCloseTo(42, 12);
  });
});

describe('pickProbeOffsets', () => {
  it('probes the cursor itself first so an exact hit short-circuits the ring', () => {
    expect(pickProbeOffsets(5)[0]).toEqual({ dx: 0, dy: 0 });
  });

  it('rings the cursor at the requested radius', () => {
    const ring = pickProbeOffsets(5).slice(1);
    expect(ring).toHaveLength(8);
    for (const o of ring) expect(Math.hypot(o.dx, o.dy)).toBeCloseTo(5, 10);
  });

  it('spreads the ring over eight distinct compass directions', () => {
    const dirs = pickProbeOffsets(4)
      .slice(1)
      .map((o) => `${Math.round(Math.atan2(o.dy, o.dx) * 1000)}`);
    expect(new Set(dirs).size).toBe(8);
  });

  it('collapses to the centre alone for a zero radius', () => {
    expect(pickProbeOffsets(0)).toEqual([{ dx: 0, dy: 0 }]);
  });
});

describe('chooseNearestCandidate', () => {
  it('returns -1 when nothing was hit', () => {
    expect(chooseNearestCandidate([])).toBe(-1);
    expect(chooseNearestCandidate([null, null])).toBe(-1);
  });

  it('prefers the nearer surface over the one closer to the cursor', () => {
    // The silhouette case this exists for: a background trunk whose splat
    // happens to sit nearer the cursor must NOT beat the foreground twig.
    const background = { depth: 20, offsetPx: 1 };
    const foreground = { depth: 3, offsetPx: 5 };
    expect(chooseNearestCandidate([background, foreground])).toBe(1);
  });

  it('breaks a same-surface tie by screen proximity', () => {
    // Two probes on the same twig — depths differ by less than the tolerance,
    // so the one nearest where the user actually clicked wins. Without this the
    // label would drift to whichever probe grazed marginally nearer.
    const far = { depth: 10.0, offsetPx: 5 };
    const near = { depth: 9.99, offsetPx: 1 };
    expect(chooseNearestCandidate([far, near])).toBe(1);
  });

  it('treats a sub-tolerance depth difference as the same surface', () => {
    // 1% apart at 2% tolerance: not a different surface, so offset decides.
    expect(chooseNearestCandidate([{ depth: 100, offsetPx: 0 }, { depth: 99, offsetPx: 7 }]))
      .toBe(0);
  });

  it('treats a super-tolerance depth difference as a nearer surface', () => {
    // 10% apart: genuinely different surfaces, so depth decides despite the
    // winner being further from the cursor.
    expect(chooseNearestCandidate([{ depth: 100, offsetPx: 0 }, { depth: 90, offsetPx: 7 }]))
      .toBe(1);
  });

  it('scales the tolerance with distance rather than using a fixed metric one', () => {
    // The same 1 m gap is noise on a 100 m stand but a real separation on a
    // 10 m one. Offset is held equal so only the tolerance can decide.
    const a = [{ depth: 100, offsetPx: 0 }, { depth: 99, offsetPx: 0 }];
    const b = [{ depth: 10, offsetPx: 0 }, { depth: 9, offsetPx: 0 }];
    expect(chooseNearestCandidate(a)).toBe(0);   // within tolerance → keeps first
    expect(chooseNearestCandidate(b)).toBe(1);   // outside tolerance → takes nearer
  });

  it('skips null and non-finite probes', () => {
    expect(chooseNearestCandidate([null, { depth: 5, offsetPx: 3 }])).toBe(1);
    expect(chooseNearestCandidate([{ depth: NaN, offsetPx: 0 }, { depth: 5, offsetPx: 3 }])).toBe(1);
    expect(chooseNearestCandidate([{ depth: Infinity, offsetPx: 0 }])).toBe(-1);
  });

  it('handles a single candidate', () => {
    expect(chooseNearestCandidate([{ depth: 7, offsetPx: 2 }])).toBe(0);
  });
});
