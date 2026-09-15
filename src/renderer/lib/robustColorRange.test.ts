import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { robustScalarRange } from './robustColorRange';
import { buildPointCloudFromOctree } from './pointCloudParsers';
import {
  registerCategoricalSlug,
  unregisterCategoricalSlug,
  registerContinuousSlug,
  unregisterContinuousSlug,
  GROUND_CLASS_ATTRIBUTE,
  TREE_INSTANCE_ATTRIBUTE,
} from './classification';
import type { PointCloudData } from './pointCloudTypes';

// Minimal cloud carrying only what robustScalarRange reads.
function cloud(opts: {
  robust?: Record<string, [number, number]>;
  observed?: Record<string, number[]>;
} = {}): PointCloudData {
  const zero = new THREE.Vector3(0, 0, 0);
  return {
    positions: new Float32Array(0),
    pointCount: 0,
    bounds: { min: zero.clone(), max: zero.clone(), center: zero.clone(), size: zero.clone() },
    octree: {
      cacheId: 'c',
      sessionId: 's',
      ...(opts.robust ? { robustAttributeRanges: opts.robust } : {}),
      ...(opts.observed ? { observedClasses: opts.observed } : {}),
    },
  } as unknown as PointCloudData;
}

describe('robustScalarRange', () => {
  afterEach(() => {
    unregisterCategoricalSlug('my_label');
    unregisterContinuousSlug(GROUND_CLASS_ATTRIBUTE);
    unregisterContinuousSlug('is_miss');
  });

  it('prefers the percentile range over the raw extrema for a continuous field', () => {
    // The motivating case: reflectance runs 10..40 over the real data, with one
    // saturated return at 900 stretching the raw domain 30x.
    const d = cloud({ robust: { reflectance: [10, 40] } });
    expect(robustScalarRange(d, 'reflectance', [10, 900])).toEqual([10, 40]);
  });

  it('falls back to the raw extrema when the backend reported no robust range', () => {
    // Clouds built renderer-side, or imported before this existed, carry none.
    const d = cloud();
    expect(robustScalarRange(d, 'reflectance', [10, 900])).toEqual([10, 900]);
  });

  it('falls back when the slug is absent from an otherwise-populated map', () => {
    const d = cloud({ robust: { reflectance: [10, 40] } });
    expect(robustScalarRange(d, 'deviation', [0, 500])).toEqual([0, 500]);
  });

  // The destructive case the gate exists for. A class-ID column's rarest class
  // sits in the tail by definition, so trimming 1% deletes it from the palette
  // and repaints its points as a neighbouring class.
  it('does NOT trim a statically registered categorical field', () => {
    const d = cloud({ robust: { [GROUND_CLASS_ATTRIBUTE]: [0, 1] } });
    expect(robustScalarRange(d, GROUND_CLASS_ATTRIBUTE, [0, 2])).toEqual([0, 2]);
  });

  it('does NOT trim tree_instance', () => {
    const d = cloud({ robust: { [TREE_INSTANCE_ATTRIBUTE]: [0, 6] } });
    expect(robustScalarRange(d, TREE_INSTANCE_ATTRIBUTE, [0, 9])).toEqual([0, 9]);
  });

  it('does NOT trim a field the user marked categorical in the import wizard', () => {
    // Same slug, same numbers — only the wizard registration differs, which is
    // exactly why this decision cannot live in the backend.
    const d = cloud({ robust: { my_label: [1, 4] } });
    expect(robustScalarRange(d, 'my_label', [1, 12])).toEqual([1, 4]);
    registerCategoricalSlug('my_label');
    expect(robustScalarRange(d, 'my_label', [1, 12])).toEqual([1, 12]);
  });

  it('DOES trim a registered-categorical slug the user forced to continuous', () => {
    // "Scalar" over a by-name scheme means the user asked for a gradient, so the
    // percentile applies again. Mirrors categoricalSchemeForRange's precedence.
    const d = cloud({ robust: { [GROUND_CLASS_ATTRIBUTE]: [0, 1] } });
    expect(robustScalarRange(d, GROUND_CLASS_ATTRIBUTE, [0, 2])).toEqual([0, 2]);
    registerContinuousSlug(GROUND_CLASS_ATTRIBUTE);
    expect(robustScalarRange(d, GROUND_CLASS_ATTRIBUTE, [0, 2])).toEqual([0, 1]);
  });

  it('honours observedClasses when resolving the scheme', () => {
    // A dynamic scheme built from exact surviving values still counts as
    // categorical; the gate must see it.
    registerCategoricalSlug('my_label');
    const d = cloud({ robust: { my_label: [1, 4] }, observed: { my_label: [1, 3, 7] } });
    expect(robustScalarRange(d, 'my_label', [1, 7])).toEqual([1, 7]);
  });

  it('never widens beyond the raw extrema', () => {
    // A stale pairing (percentile from the session, extrema from an octree
    // rebuilt after an edit) must not invent a domain containing no points.
    const d = cloud({ robust: { reflectance: [-5, 90] } });
    expect(robustScalarRange(d, 'reflectance', [0, 50])).toEqual([0, 50]);
  });

  it('never returns an inverted range when robust and raw do not overlap', () => {
    // The clamp's own failure mode. A robust range entirely outside the raw one
    // (a stale pairing — percentile from one point set, extrema from another)
    // would clamp to min > max, whose negative span reverses the colormap and
    // pushes every point off the end of the ramp. Distrust it and keep raw.
    expect(robustScalarRange(cloud({ robust: { a: [100, 200] } }), 'a', [0, 50]))
      .toEqual([0, 50]);
    expect(robustScalarRange(cloud({ robust: { a: [-50, -10] } }), 'a', [0, 50]))
      .toEqual([0, 50]);
    // Touching-but-not-overlapping is still no usable span.
    expect(robustScalarRange(cloud({ robust: { a: [50, 80] } }), 'a', [0, 50]))
      .toEqual([0, 50]);
  });

  it('returns a usable span for every accepted input', () => {
    // The invariant the shaders depend on: max > min, always, whichever branch
    // produced the answer.
    const inputs: Array<[[number, number], [number, number]]> = [
      [[10, 40], [10, 900]], [[100, 200], [0, 50]], [[-50, -10], [0, 50]],
      [[5, 5], [0, 10]], [[9, 2], [0, 10]], [[0, 100], [25, 75]],
    ];
    for (const [robust, raw] of inputs) {
      const [lo, hi] = robustScalarRange(cloud({ robust: { a: robust } }), 'a', raw);
      expect(hi).toBeGreaterThan(lo);
    }
  });

  it('falls back on a degenerate or inverted robust range', () => {
    expect(robustScalarRange(cloud({ robust: { a: [7, 7] } }), 'a', [0, 10])).toEqual([0, 10]);
    expect(robustScalarRange(cloud({ robust: { a: [9, 2] } }), 'a', [0, 10])).toEqual([0, 10]);
    expect(robustScalarRange(cloud({ robust: { a: [NaN, 5] } }), 'a', [0, 10])).toEqual([0, 10]);
  });
});

// A helper reading a field nobody populates is dead code that unit-tests green.
// These run the REAL parser over a backend-shaped payload, so the wire name
// (`robust_attribute_ranges`) and the consumer's field name are pinned together:
// rename one and this fails rather than silently reverting to raw extrema.
describe('robustAttributeRanges wiring (backend payload → parser → consumer)', () => {
  const META = {
    cache_id: 'c1',
    cache_dir: '/tmp/c1',
    cached: true,
    version: '2.0',
    point_count: 100,
    spacing: 0.1,
    scale: [1, 1, 1],
    offset: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    tight_bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    attributes: [
      { name: 'reflectance', size: 4, type: 'float', numElements: 1, min: [10], max: [900] },
    ],
    robust_attribute_ranges: { reflectance: [10, 40] },
  };

  it('carries the backend field through the parser onto the cloud', () => {
    const d = buildPointCloudFromOctree(META as never, '/tmp/x.las', 'x.las');
    expect(d.octree?.robustAttributeRanges).toEqual({ reflectance: [10, 40] });
  });

  it('end-to-end: a parsed cloud reports the trimmed domain, not the raw one', () => {
    const d = buildPointCloudFromOctree(META as never, '/tmp/x.las', 'x.las');
    const raw = d.octree!.attributeRanges!.reflectance;
    expect([raw.min[0], raw.max[0]]).toEqual([10, 900]);
    expect(robustScalarRange(d, 'reflectance', [raw.min[0], raw.max[0]])).toEqual([10, 40]);
  });

  it('omits the field entirely when the backend sent none', () => {
    const { robust_attribute_ranges, ...without } = META;
    const d = buildPointCloudFromOctree(without as never, '/tmp/x.las', 'x.las');
    expect(d.octree?.robustAttributeRanges).toBeUndefined();
    expect(robustScalarRange(d, 'reflectance', [10, 900])).toEqual([10, 900]);
  });

  it('drops malformed entries rather than trusting them', () => {
    const d = buildPointCloudFromOctree(
      { ...META, robust_attribute_ranges: { a: [5], b: 'x', c: [3, 3], d: [1, 2] } } as never,
      '/tmp/x.las', 'x.las',
    );
    expect(d.octree?.robustAttributeRanges).toEqual({ d: [1, 2] });
  });
});
