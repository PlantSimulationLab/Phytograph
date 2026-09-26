import { describe, it, expect } from 'vitest';
import type { TreeInventoryTree, StemCurveRow } from '../utils/backendApi';
import {
  sortTrees, carryOverEdits, buildTreeListCsv, buildStemCurveCsv, TREE_LIST_CSV_HEADER,
  STEM_CURVE_CSV_HEADER, treeFrameTarget, treeOverlaySegments, describeFlags,
} from './treeInventory';

function tree(id: number, over: Partial<TreeInventoryTree> = {}): TreeInventoryTree {
  return {
    tree_id: id, n_points: 1000, flags: [], height_m: 10 + id, dbh_m: 0.1 * id,
    stem_base: [612000 + id, 4270000, 100], stem_axis: [0, 0, 1], ground_z: 100,
    bbox_min: [612000 + id - 2, 4269998, 100], bbox_max: [612000 + id + 2, 4270002, 110 + id],
    dbh: {
      diameter_m: 0.1 * id, center: [612000 + id, 4270000, 101.3], rms_m: 0.002,
      arc_coverage: 0.75, max_gap_deg: 80, n_points: 300, n_inliers: 280,
      slice_thickness_m: 0.1, method: 'ransac', axial_m: 1.3, flags: [],
    },
    ...over,
  };
}

function parse(csv: string): string[][] {
  // The builders only quote cells that need it; none of these fixtures do
  // except the one test that checks quoting.
  return csv.trimEnd().split('\n').map(l => l.split(','));
}

describe('sortTrees', () => {
  const trees = [tree(2), tree(1), tree(3, { dbh_m: null, dbh: null }), tree(4)];

  it('sorts by DBH both ways, unmeasured trees always last', () => {
    expect(sortTrees(trees, 'dbh_cm', 'asc').map(t => t.tree_id)).toEqual([1, 2, 4, 3]);
    expect(sortTrees(trees, 'dbh_cm', 'desc').map(t => t.tree_id)).toEqual([4, 2, 1, 3]);
  });

  it('breaks ties on tree id and does not mutate the input', () => {
    const tied = [tree(5, { height_m: 7 }), tree(2, { height_m: 7 })];
    expect(sortTrees(tied, 'height_m', 'desc').map(t => t.tree_id)).toEqual([2, 5]);
    expect(tied.map(t => t.tree_id)).toEqual([5, 2]);
  });

  it('falls back to tree id for an unknown column', () => {
    expect(sortTrees(trees, 'nope', 'asc').map(t => t.tree_id)).toEqual([1, 2, 3, 4]);
  });
});

describe('carryOverEdits', () => {
  const prev = { 1: { species: 'Quercus', status: 'live' as const, label: 'a' },
                 2: { species: 'Fagus', status: '' as const, label: '' },
                 9: { species: 'Pinus', status: 'dead' as const, label: '' } };
  const before = [tree(1), tree(2), tree(9)];

  it('keeps entries for the same tree found again at the same place', () => {
    const moved = tree(2, { stem_base: [612002.3, 4270000.2, 100] });  // 0.36 m
    const r = carryOverEdits(before, prev, [tree(1), moved]);
    expect(r.edits).toEqual({ 1: prev[1], 2: prev[2] });
    expect(r.dropped).toBe(1);  // tree 9 is gone
  });

  it('drops an entry whose id now names a different tree', () => {
    // Re-segmentation renumbered: id 1 is now a stem 5 m away.
    const r = carryOverEdits(before, prev, [tree(1, { stem_base: [612006, 4270000, 100] }), tree(2), tree(9)]);
    expect(r.edits[1]).toBeUndefined();
    expect(r.edits[2]).toEqual(prev[2]);
    expect(r.dropped).toBe(1);
  });
});

describe('buildTreeListCsv', () => {
  it('writes one row per tree with the user entries and measured values', () => {
    const csv = buildTreeListCsv('plot A', [tree(2), tree(3, { flags: ['partial_arc', 'few_points'] })],
      { 3: { species: 'Fagus sylvatica', status: 'live', label: 'T-3' } });
    const rows = parse(csv);
    expect(rows[0]).toEqual([...TREE_LIST_CSV_HEADER]);
    expect(rows).toHaveLength(3);
    const col = (name: string) => TREE_LIST_CSV_HEADER.indexOf(name as never);
    const r3 = rows[2];
    expect(r3[col('tree_id')]).toBe('3');
    expect(r3[col('species')]).toBe('Fagus sylvatica');
    expect(r3[col('status')]).toBe('live');
    expect(r3[col('label')]).toBe('T-3');
    expect(r3[col('dbh_m')]).toBe('0.3000');
    // World coordinates keep full precision.
    expect(r3[col('stem_x')]).toBe('612003.0000');
    expect(r3[col('dbh_arc_coverage')]).toBe('0.750');
    expect(r3[col('flags')]).toBe('partial_arc;few_points');
    // No user entry -> blank cells, not "undefined".
    expect(rows[1][col('species')]).toBe('');
  });

  it('leaves unmeasured values blank and quotes awkward text', () => {
    const csv = buildTreeListCsv('a,b', [tree(1, { dbh_m: null, dbh: null, basal_area_m2: null })],
      { 1: { species: 'say "hi"', status: '', label: '' } });
    const line = csv.split('\n')[1];
    expect(line.startsWith('"a,b",1,"say ""hi""",')).toBe(true);
    const cells = line.split(',');
    expect(cells).not.toContain('NaN');
    expect(cells).not.toContain('undefined');
  });
});

describe('tree list biomass columns', () => {
  it('writes the method only where there is a value', () => {
    const csv = buildTreeListCsv('s', [tree(1), tree(2)], {}, { biomassKg: { 1: 123.4, 2: null }, biomassMethod: 'jenkins2003' });
    const rows = parse(csv);
    const col = (name: string) => TREE_LIST_CSV_HEADER.indexOf(name as never);
    expect(rows[1][col('agb_kg')]).toBe('123.40');
    expect(rows[1][col('agb_method')]).toBe('jenkins2003');
    expect(rows[2][col('agb_kg')]).toBe('');
    expect(rows[2][col('agb_method')]).toBe('');
  });
});

describe('buildStemCurveCsv', () => {
  it('orders rows by tree then axial distance', () => {
    const mk = (tree_id: number, axial_m: number): StemCurveRow => ({
      tree_id, axial_m, height_m: axial_m, x: 1, y: 2, z: 3, diameter_m: 0.3 - axial_m / 100,
      rms_m: 0.001, arc_coverage: 1, n_points: 100, ok: axial_m < 2,
    });
    const rows = parse(buildStemCurveCsv('s', [mk(2, 1), mk(1, 1.5), mk(1, 0.5), mk(2, 2.5)]));
    expect(rows[0]).toEqual([...STEM_CURVE_CSV_HEADER]);
    expect(rows.slice(1).map(r => `${r[1]}@${r[2]}`)).toEqual(['1@0.500', '1@1.500', '2@1.000', '2@2.500']);
    expect(rows[4][11]).toBe('false');
  });
});

describe('viewer geometry', () => {
  it('frames the tree in the stored frame (world minus shift)', () => {
    const f = treeFrameTarget(tree(1), [612000, 4270000, 0])!;
    expect(f.center[0]).toBeCloseTo(1);
    expect(f.center[1]).toBeCloseTo(0);
    expect(f.center[2]).toBeCloseTo(105.5);
    expect(f.size).toEqual([4, 4, 11]);
    expect(treeFrameTarget(tree(1, { bbox_min: undefined }))).toBeNull();
  });

  it('centres on the stem base, not a bbox dragged by stray points', () => {
    const t = tree(1, { bbox_min: [611990, 4269998, 100], bbox_max: [612003, 4270002, 111] });
    const f = treeFrameTarget(t, [612000, 4270000, 0])!;
    expect(f.center[0]).toBeCloseTo(1);   // stem base x, not the bbox centre (-3.5)
    expect(f.size[0]).toBe(13);
  });

  it('draws the DBH circle at its radius around its centre, in display space', () => {
    const t = tree(4);
    const segs = 32;
    const v = treeOverlaySegments(t, [612000, 4270000, 0], [0, 0, 100], segs);
    // circle: 2 verts per segment; base cross: 4 verts; axis: 2 verts.
    expect(v.length).toBe((segs * 2 + 6) * 3);
    for (let k = 0; k < segs * 2; k++) {
      const x = v[k * 3], y = v[k * 3 + 1], z = v[k * 3 + 2];
      expect(Math.hypot(x - 4, y - 0)).toBeCloseTo(0.2, 6);
      expect(z).toBeCloseTo(1.3, 6);
    }
  });

  it('draws the circle perpendicular to a leaning axis', () => {
    const a = [Math.sin(0.2), 0, Math.cos(0.2)] as [number, number, number];
    const t = tree(2, { stem_axis: a });
    const v = treeOverlaySegments(t, [0, 0, 0], [0, 0, 0], 16);
    const c = t.dbh!.center;
    for (let k = 0; k < 32; k++) {
      const d = [v[k * 3] - c[0], v[k * 3 + 1] - c[1], v[k * 3 + 2] - c[2]];
      expect(d[0] * a[0] + d[1] * a[1] + d[2] * a[2]).toBeCloseTo(0, 9);
    }
  });

  it('draws only the base marker without a DBH', () => {
    const v = treeOverlaySegments(tree(1, { dbh: null, dbh_m: null }), [0, 0, 0], [0, 0, 0]);
    expect(v.length).toBe(4 * 3);
  });
});

describe('describeFlags', () => {
  it('translates known flags and passes unknown ones through', () => {
    expect(describeFlags(['partial_arc', 'mystery'])).toBe('less than half the stem circumference seen; mystery');
  });
});
