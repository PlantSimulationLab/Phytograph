import { describe, it, expect } from 'vitest';
import { ladRange } from './pointCloudHelpers';
import { ladVoxelValue } from '../components/viewer/renderers/LADVoxelGrid';
import { ladExportVariables, LAD_EXPORT_VARIABLES } from './ladExport';
import { computeLadProfile, ladProfileCsv } from './ladProfile';
import type { LADVoxel, LADResultEntry } from './pointCloudTypes';

// The leaf/wood split reaches the screen through three pure pieces that must
// agree: the value a voxel contributes for the selected field, the colorbar
// domain built from that same value, and the export picker's variable list.
// A disagreement between the first two is invisible in a screenshot but paints
// the grid with one field's ramp over another field's numbers.

function voxel(over: Partial<LADVoxel> = {}): LADVoxel {
  return {
    index: 0,
    center: [0, 0, 0],
    size: [1, 1, 1],
    leafArea: 1,
    lad: 1,
    gtheta: 0.5,
    hitCount: 10,
    ...over,
  };
}

describe('ladVoxelValue', () => {
  it('defaults to LAD, which is the pre-wood behaviour', () => {
    const v = voxel({ lad: 2.5 });
    expect(ladVoxelValue(v)).toBe(2.5);
    expect(ladVoxelValue(v, 'lad')).toBe(2.5);
  });

  it('reads wood and plant densities off the split', () => {
    const v = voxel({ lad: 2, wad: 0.5, pad: 2.5 });
    expect(ladVoxelValue(v, 'wad')).toBe(0.5);
    expect(ladVoxelValue(v, 'pad')).toBe(2.5);
  });

  it('treats an unclassified voxel as having no wood, not unknown wood', () => {
    // A result computed before the split (or from a cloud with no wood_class)
    // carries no wood fields. Reading 0 is correct: no wood was attributed here.
    const v = voxel({ lad: 2 });
    expect(ladVoxelValue(v, 'wad')).toBe(0);
    expect(ladVoxelValue(v, 'pad')).toBe(2);
  });

  it('derives PAD when the backend did not send it', () => {
    expect(ladVoxelValue(voxel({ lad: 2, wad: 0.75 }), 'pad')).toBe(2.75);
  });
});

describe('ladRange follows the displayed field', () => {
  it('scales to WAD, not LAD, when showing wood', () => {
    const voxels = [
      voxel({ lad: 5, wad: 0.2, pad: 5.2 }),
      voxel({ lad: 9, wad: 0.6, pad: 9.6 }),
    ];
    expect(ladRange(voxels, true, 'lad')).toEqual({ min: 5, max: 9 });
    expect(ladRange(voxels, true, 'wad')).toEqual({ min: 0.2, max: 0.6 });
    expect(ladRange(voxels, true, 'pad')).toEqual({ min: 5.2, max: 9.6 });
  });

  it('agrees with ladVoxelValue on every field', () => {
    // The invariant that matters: the domain is built from exactly the numbers
    // the renderer paints. If these ever diverge the ramp is wrong.
    const voxels = [
      voxel({ lad: 1, wad: 0.1, pad: 1.1 }),
      voxel({ lad: 4, wad: 0.9, pad: 4.9 }),
      voxel({ lad: 2, wad: 0.4, pad: 2.4 }),
    ];
    for (const field of ['lad', 'wad', 'pad'] as const) {
      const vals = voxels.map(v => ladVoxelValue(v, field));
      const r = ladRange(voxels, true, field);
      expect(r.min).toBe(Math.min(...vals));
      expect(r.max).toBe(Math.max(...vals));
    }
  });

  it('hides a voxel with no wood when showing WAD', () => {
    // hideEmpty and the domain must use the same emptiness test, or a hidden
    // cell still stretches the colorbar.
    const voxels = [voxel({ lad: 3, wad: 0 }), voxel({ lad: 2, wad: 0.5 })];
    expect(ladRange(voxels, true, 'wad')).toEqual({ min: 0.5, max: 0.5 });
  });

  it('keeps the legacy signature working unchanged', () => {
    const voxels = [voxel({ lad: 2 }), voxel({ lad: 6 })];
    expect(ladRange(voxels)).toEqual({ min: 2, max: 6 });
  });
});

describe('ladExportVariables', () => {
  it('offers only leaf variables without a split', () => {
    const vars = ladExportVariables(false);
    expect(vars).toEqual(LAD_EXPORT_VARIABLES);
    expect(vars.some(v => v.key === 'wad')).toBe(false);
  });

  it('adds the wood variables when the result has a split', () => {
    const keys = ladExportVariables(true).map(v => v.key);
    for (const k of ['wad', 'wood_area', 'pad', 'wood_fraction', 'wood_gtheta']) {
      expect(keys).toContain(k);
    }
    // The leaf set is preserved, not replaced.
    for (const v of LAD_EXPORT_VARIABLES) expect(keys).toContain(v.key);
  });

  it('never offers a duplicate key', () => {
    const keys = ladExportVariables(true).map(v => v.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});


function ladResult(voxels: LADVoxel[]): LADResultEntry {
  return {
    id: 'r', sourceScanIds: [], voxels,
    nx: 2, ny: 1, nz: 1,
    bounds: { min: [0, 0, 0], max: [2, 1, 1] },
    returnMode: 'single', visible: true, color: '#fff',
    hideEmpty: true, opacity: 1,
    gridSize: [2, 1, 1],
  } as LADResultEntry;
}

describe('computeLadProfile wood totals', () => {
  const measured = (over: Partial<LADVoxel>): LADVoxel => voxel({ index: 0, ...over });

  it('reports no wood aggregates without a split', () => {
    const p = computeLadProfile(ladResult([
      measured({ index: 0, lad: 2, leafArea: 2 }),
      measured({ index: 1, lad: 4, leafArea: 4 }),
    ]));
    expect(p.wai).toBeUndefined();
    expect(p.pai).toBeUndefined();
    expect(p.woodArea).toBeUndefined();
    expect(p.lai).toBeGreaterThan(0);
  });

  it('sums wood over measured voxels and keeps LAI + WAI = PAI', () => {
    const p = computeLadProfile(ladResult([
      measured({ index: 0, lad: 2, leafArea: 2, wad: 0.5, woodArea: 0.5, pad: 2.5 }),
      measured({ index: 1, lad: 4, leafArea: 4, wad: 1.5, woodArea: 1.5, pad: 5.5 }),
    ]));
    expect(p.woodArea).toBeCloseTo(2.0, 9);
    expect(p.pai!).toBeCloseTo(p.lai + p.wai!, 9);
  });

  it('excludes an occluded voxel from WOOD too, not just leaf', () => {
    // The whole point of the occlusion rule: an unmeasured voxel is an absence
    // of measurement for BOTH media. Counting its wood would bias WAI exactly
    // the way counting its leaf biases LAI.
    const p = computeLadProfile(ladResult([
      measured({ index: 0, lad: 2, leafArea: 2, wad: 0.5, woodArea: 0.5 }),
      measured({ index: 1, lad: 9, leafArea: 9, wad: 9, woodArea: 9,
                 underSampled: true }),
    ]));
    expect(p.woodArea).toBeCloseTo(0.5, 9);
    expect(p.leafArea).toBeCloseTo(2, 9);
  });

  it('writes the wood totals into the profile CSV only when present', () => {
    const withWood = ladProfileCsv(computeLadProfile(ladResult([
      measured({ index: 0, lad: 2, leafArea: 2, wad: 0.5, woodArea: 0.5 }),
    ])));
    expect(withWood).toContain('# bulk WAI');
    expect(withWood).toContain('# bulk PAI');

    const without = ladProfileCsv(computeLadProfile(ladResult([
      measured({ index: 0, lad: 2, leafArea: 2 }),
    ])));
    expect(without).not.toContain('WAI');
    expect(without).not.toContain('PAI');
  });
});
