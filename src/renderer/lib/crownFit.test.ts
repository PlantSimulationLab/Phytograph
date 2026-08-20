import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { PointCloudData, OctreeRef, ScalarField } from './pointCloudTypes';
import type { Scan } from './scan';
import {
  evaluateScanForCrownFit,
  coerceCrownFitOptions,
  DEFAULT_CROWN_FIT_OPTIONS,
  MIN_CROWN_POINTS,
  MAX_STRICTNESS,
  crownColorForTreeId,
  allocateCrownColor,
} from './crownFit';
import {
  GROUND_CLASS_ATTRIBUTE as GC,
  WOOD_CLASS_ATTRIBUTE as WC,
  TREE_INSTANCE_ATTRIBUTE as TI,
  treeInstanceColor,
} from './classification';

function makeData(pointCount = 500): PointCloudData {
  return {
    positions: new Float32Array(),
    pointCount,
    bounds: {
      min: new THREE.Vector3(0, 0, 0),
      max: new THREE.Vector3(1, 1, 1),
      center: new THREE.Vector3(0.5, 0.5, 0.5),
      size: new THREE.Vector3(1, 1, 1),
    },
    fileName: 'tree.las',
  };
}

// Octree-backed scan carrying the given slugs, with an optional tree_instance
// [min,max] range so multiTree detection can be exercised.
function makeScan(
  slugs: string[],
  opts: { pointCount?: number; treeMax?: number; sessionId?: string | null; sourceXyzPath?: string } = {},
): Scan {
  const data = makeData(opts.pointCount ?? 500);
  const octree: OctreeRef = {
    cacheId: 'c',
    sourceXyzPath: opts.sourceXyzPath ?? '',
    sessionId: opts.sessionId === undefined ? 'sess-1' : opts.sessionId,
    attributeLabels: Object.fromEntries(slugs.map((s) => [s, s])),
    attributeRanges: opts.treeMax
      ? { [TI]: { min: [0], max: [opts.treeMax] } }
      : undefined,
  };
  data.octree = octree;
  return { id: 's1', label: 'tree', visible: true, color: '#0f0', data };
}

// Flat scan carrying exact tree_instance values.
function makeFlatScan(treeValues: number[]): Scan {
  const data = makeData(treeValues.length);
  const fields: Record<string, ScalarField> = {
    [TI]: { values: new Float32Array(treeValues), min: Math.min(...treeValues), max: Math.max(...treeValues) },
  };
  data.scalarFields = fields;
  data.octree = { cacheId: 'c', sourceXyzPath: '/tmp/tree.xyz' };
  return { id: 'f1', label: 'flat', visible: true, color: '#0f0', data };
}

describe('evaluateScanForCrownFit — hard-disable rules', () => {
  it('disables a scan with no data', () => {
    const scan: Scan = { id: 'x', label: 'x', visible: true, color: '#000' };
    const e = evaluateScanForCrownFit(scan);
    expect(e.eligible).toBe(false);
    expect(e.disabledReason).toMatch(/no point data/i);
  });

  it('disables a scan with no session and no source path', () => {
    const scan = makeScan([GC, WC], { sessionId: null, sourceXyzPath: '' });
    const e = evaluateScanForCrownFit(scan);
    expect(e.eligible).toBe(false);
    expect(e.disabledReason).toMatch(/no backing data source/i);
  });

  it('disables a scan below the point-count floor', () => {
    const scan = makeScan([GC, WC, TI], { pointCount: MIN_CROWN_POINTS - 1 });
    const e = evaluateScanForCrownFit(scan);
    expect(e.eligible).toBe(false);
    expect(e.disabledReason).toMatch(/too few points/i);
  });
});

describe('evaluateScanForCrownFit — warnings for missing labels (never hard-block)', () => {
  it('fully labelled scan is eligible with no warning', () => {
    const scan = makeScan([GC, WC, TI], { treeMax: 1 });
    const e = evaluateScanForCrownFit(scan);
    expect(e.eligible).toBe(true);
    expect(e.warning).toBeUndefined();
    expect(e.useLeafOnly).toBe(true);
    expect(e.groundBaseline).toBe('ground_class');
  });

  it('missing tree labels → eligible + tree warning + min_z stays if ground present', () => {
    const scan = makeScan([GC, WC]); // no tree_instance
    const e = evaluateScanForCrownFit(scan);
    expect(e.eligible).toBe(true);
    expect(e.warning).toMatch(/tree segmentation/i);
    expect(e.mode).toBe('single');
    expect(e.groundBaseline).toBe('ground_class');
  });

  it('missing ground labels → eligible + ground warning + min_z baseline', () => {
    const scan = makeScan([WC, TI], { treeMax: 1 });
    const e = evaluateScanForCrownFit(scan);
    expect(e.eligible).toBe(true);
    expect(e.warning).toMatch(/ground segmentation/i);
    expect(e.groundBaseline).toBe('min_z');
    expect(e.hasGround).toBe(false);
  });

  it('missing wood labels → eligible + wood warning + useLeafOnly false', () => {
    const scan = makeScan([GC, TI], { treeMax: 1 });
    const e = evaluateScanForCrownFit(scan);
    expect(e.eligible).toBe(true);
    expect(e.warning).toMatch(/leaf\/wood segmentation/i);
    expect(e.useLeafOnly).toBe(false);
  });

  it('no labels at all → eligible with all three warnings composed', () => {
    const scan = makeScan([]);
    const e = evaluateScanForCrownFit(scan);
    expect(e.eligible).toBe(true);
    expect(e.warning).toMatch(/tree segmentation/i);
    expect(e.warning).toMatch(/ground segmentation/i);
    expect(e.warning).toMatch(/leaf\/wood segmentation/i);
  });
});

describe('evaluateScanForCrownFit — multiTree detection', () => {
  it('octree range with max ≥ 2 → multiTree with enumerated ids', () => {
    const scan = makeScan([GC, WC, TI], { treeMax: 3 });
    const e = evaluateScanForCrownFit(scan);
    expect(e.mode).toBe('multiTree');
    expect(e.treeInstanceIds).toEqual([1, 2, 3]);
  });

  it('octree range with max 1 → single tree', () => {
    const scan = makeScan([GC, WC, TI], { treeMax: 1 });
    const e = evaluateScanForCrownFit(scan);
    expect(e.mode).toBe('single');
    expect(e.treeInstanceIds).toEqual([1]);
  });

  it('flat scan reads exact distinct nonzero tree ids (0 excluded)', () => {
    const scan = makeFlatScan([0, 0, 2, 5, 5, 2]);
    const e = evaluateScanForCrownFit(scan);
    expect(e.mode).toBe('multiTree');
    expect(e.treeInstanceIds).toEqual([2, 5]);
  });
});

describe('coerceCrownFitOptions', () => {
  it('returns defaults for null/undefined/non-object', () => {
    expect(coerceCrownFitOptions(undefined)).toEqual(DEFAULT_CROWN_FIT_OPTIONS);
    expect(coerceCrownFitOptions(null)).toEqual(DEFAULT_CROWN_FIT_OPTIONS);
    expect(coerceCrownFitOptions(7)).toEqual(DEFAULT_CROWN_FIT_OPTIONS);
  });

  it('clamps strictness into [0, MAX_STRICTNESS]', () => {
    expect(coerceCrownFitOptions({ strictness: -1 }).strictness).toBe(0);
    // A stored value above the UI cap (e.g. the old 0.8) is brought into range.
    expect(coerceCrownFitOptions({ strictness: 5 }).strictness).toBe(MAX_STRICTNESS);
    expect(coerceCrownFitOptions({ strictness: 0.8 }).strictness).toBe(MAX_STRICTNESS);
    expect(coerceCrownFitOptions({ strictness: 0.3 }).strictness).toBeCloseTo(0.3);
  });

  it('defaults fuzziness to 0.2', () => {
    expect(DEFAULT_CROWN_FIT_OPTIONS.strictness).toBe(0.2);
    expect(coerceCrownFitOptions({}).strictness).toBe(0.2);
  });

  it('rejects an unknown shape but keeps a valid one', () => {
    expect(coerceCrownFitOptions({ shape: 'blob' }).shape).toBe(DEFAULT_CROWN_FIT_OPTIONS.shape);
    expect(coerceCrownFitOptions({ shape: 'cone' }).shape).toBe('cone');
  });

  it('nulls a non-positive/invalid alpha, keeps a positive one', () => {
    expect(coerceCrownFitOptions({ alpha: 0 }).alpha).toBeNull();
    expect(coerceCrownFitOptions({ alpha: -2 }).alpha).toBeNull();
    expect(coerceCrownFitOptions({ alpha: 0.5 }).alpha).toBe(0.5);
  });

  it('fills in the export settings a pre-existing stored blob lacks', () => {
    // Anyone who used crown fitting before the export fields existed has a
    // persisted object without them; it must still coerce to valid options
    // rather than leaving the base name / mesh format undefined.
    const legacy = { shape: 'cone', strictness: 0.3, alpha: null, exportCsv: true };
    const o = coerceCrownFitOptions(legacy);
    expect(o.exportBaseName).toBe(DEFAULT_CROWN_FIT_OPTIONS.exportBaseName);
    expect(o.meshFormat).toBe(DEFAULT_CROWN_FIT_OPTIONS.meshFormat);
    expect(o.shape).toBe('cone');
    expect(o.exportCsv).toBe(true);
  });

  it('keeps a valid mesh format and rejects anything else', () => {
    expect(coerceCrownFitOptions({ meshFormat: 'ply' }).meshFormat).toBe('ply');
    expect(coerceCrownFitOptions({ meshFormat: 'stl' }).meshFormat).toBe('stl');
    expect(coerceCrownFitOptions({ meshFormat: 'gltf' as never }).meshFormat)
      .toBe(DEFAULT_CROWN_FIT_OPTIONS.meshFormat);
  });

  it('keeps a stored base name, and ignores a non-string one', () => {
    expect(coerceCrownFitOptions({ exportBaseName: 'plot3_crowns' }).exportBaseName)
      .toBe('plot3_crowns');
    expect(coerceCrownFitOptions({ exportBaseName: 42 as never }).exportBaseName).toBe('');
  });
});

describe('crown colours', () => {
  it('crownColorForTreeId returns null for the whole-cloud sentinel (id 0)', () => {
    expect(crownColorForTreeId(0)).toBeNull();
    expect(crownColorForTreeId(-1)).toBeNull();
  });

  it('crownColorForTreeId matches the tree_instance colormap for id > 0', () => {
    // Same hex the viewer paints tree N (RGB 0-1 → #rrggbb).
    const [r, g, b] = treeInstanceColor(3);
    const to = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
    expect(crownColorForTreeId(3)).toBe(`#${to(r)}${to(g)}${to(b)}`);
    // Distinct ids get distinct colours.
    expect(crownColorForTreeId(1)).not.toBe(crownColorForTreeId(2));
  });

  it('allocateCrownColor picks unused palette entries, then cycles', () => {
    const c1 = allocateCrownColor(new Set());
    expect(c1).toBe('#3b82f6');
    const c2 = allocateCrownColor(new Set([c1]));
    expect(c2).toBe('#22c55e');
    expect(c2).not.toBe(c1);
    // All eight taken → cycles by count rather than returning undefined.
    const all = new Set(['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']);
    expect(typeof allocateCrownColor(all)).toBe('string');
  });
});
