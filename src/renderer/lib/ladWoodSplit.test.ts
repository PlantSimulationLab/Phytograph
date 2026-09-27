import { describe, it, expect } from 'vitest';
import {
  WOOD_SPLIT_OFF, woodSplitColumns, defaultWoodSplitChoice, parseClassValues, buildWoodSplit,
} from './ladWoodSplit';

// An octree scan carrying the named columns (each with a non-degenerate range,
// which is what columnSlugs counts as "carries data").
function scanWith(cols: Record<string, string>) {
  const ranges: Record<string, { min: number[]; max: number[] }> = {};
  for (const k of Object.keys(cols)) ranges[k] = { min: [0], max: [5] };
  return {
    data: {
      octree: {
        cacheId: 'c', sessionId: 's', sourceXyzPath: '', hasMisses: false,
        attributeLabels: cols,
        attributeRanges: ranges,
      },
    },
  } as never;
}

describe('woodSplitColumns', () => {
  it('lists only columns every selected scan carries, wood_class first', () => {
    const a = scanWith({ wood_class: 'Wood Class', las_classification: 'LAS classification', timestamp: 'Timestamp' });
    const b = scanWith({ wood_class: 'Wood Class', las_classification: 'LAS classification', my_leafwood: 'Leaf/Wood' });
    expect(woodSplitColumns([a, b])).toEqual([
      { slug: 'wood_class', label: 'Wood Class' },
      { slug: 'las_classification', label: 'LAS classification' },
    ]);
  });

  it('leaves out per-pulse bookkeeping columns', () => {
    const a = scanWith({ target_index: 'Target Index', target_count: 'Target Count', is_miss: 'Miss', 'gps-time': 'GPS time', classes: 'classes' });
    expect(woodSplitColumns([a]).map(c => c.slug)).toEqual(['classes']);
  });

  it('is empty with nothing selected', () => {
    expect(woodSplitColumns([])).toEqual([]);
  });
});

describe('defaultWoodSplitChoice', () => {
  it('uses Phytograph segmentation when present, otherwise no split', () => {
    expect(defaultWoodSplitChoice([{ slug: 'wood_class', label: 'w' }])).toBe('wood_class');
    expect(defaultWoodSplitChoice([{ slug: 'las_classification', label: 'c' }])).toBe(WOOD_SPLIT_OFF);
  });
});

describe('parseClassValues', () => {
  it('reads lists and ranges, deduplicated', () => {
    expect(parseClassValues('1, 3 5-7;3')).toEqual([1, 3, 5, 6, 7]);
    expect(parseClassValues('')).toEqual([]);
  });

  it('refuses anything that is not a whole number', () => {
    expect(parseClassValues('1.5')).toBeNull();
    expect(parseClassValues('leaf')).toBeNull();
    expect(parseClassValues('7-2')).toBeNull();
  });
});

describe('buildWoodSplit', () => {
  it('turns the split off explicitly', () => {
    expect(buildWoodSplit(WOOD_SPLIT_OFF, '', '')).toEqual({ split: { slug: null } });
  });

  it('leaves wood_class to the backend default', () => {
    expect(buildWoodSplit('wood_class', '', '')).toEqual({});
  });

  it('maps another column with the user values', () => {
    expect(buildWoodSplit('las_classification', '4', '1-2')).toEqual({
      split: { slug: 'las_classification', wood_values: [4], leaf_values: [1, 2] },
    });
  });

  it('requires values, and refuses a value in both lists', () => {
    expect(buildWoodSplit('las_classification', '', '').error).toMatch(/which values/);
    expect(buildWoodSplit('las_classification', '1, 2', '2').error).toMatch(/2 listed as both/);
    expect(buildWoodSplit('las_classification', 'x', '1').error).toMatch(/whole numbers/);
  });
});
