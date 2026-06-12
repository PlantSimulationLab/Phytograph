import { describe, it, expect } from 'vitest';
import {
  defaultExportColumns,
  lockGeometryForScanXml,
  selectedSlugs,
  reorderColumns,
  isAsciiExportFormat,
  cellValue,
  buildAsciiExport,
} from './exportColumns';

function field(values: number[]) {
  return { values: new Float32Array(values), min: Math.min(...values), max: Math.max(...values) };
}

describe('isAsciiExportFormat', () => {
  it('is true for text formats and the scan format, false otherwise', () => {
    for (const f of ['xyz', 'txt', 'csv', 'scan']) expect(isAsciiExportFormat(f)).toBe(true);
    for (const f of ['las', 'laz', 'ply', 'obj']) expect(isAsciiExportFormat(f)).toBe(false);
  });
});

describe('defaultExportColumns', () => {
  it('xyz only for a bare cloud, all selected', () => {
    const cols = defaultExportColumns({ scalarFields: {} } as never);
    expect(cols.map(c => c.slug)).toEqual(['x', 'y', 'z']);
    expect(cols.every(c => c.selected)).toBe(true);
  });

  it('adds r/g/b after xyz when the cloud has colours', () => {
    const cols = defaultExportColumns({
      colors: new Float32Array([0, 0, 0]), scalarFields: {},
    } as never);
    expect(cols.map(c => c.slug)).toEqual(['x', 'y', 'z', 'r', 'g', 'b']);
  });

  it('surfaces intensity and other scalars, classifying labels', () => {
    const cols = defaultExportColumns(
      { scalarFields: { intensity: field([1, 2]), is_miss: field([0, 1]), ground_class: field([1, 2]) } } as never,
      { isLabel: (s) => s === 'ground_class', labelFor: (s) => s },
    );
    const bySlug = Object.fromEntries(cols.map(c => [c.slug, c]));
    expect(bySlug['intensity'].kind).toBe('intensity');
    expect(bySlug['is_miss'].kind).toBe('scalar');
    expect(bySlug['ground_class'].kind).toBe('label');
    // Geometry first, then the scalar fields.
    expect(cols.slice(0, 3).map(c => c.slug)).toEqual(['x', 'y', 'z']);
  });

  it('never duplicates an x/y/z scalar field as a column', () => {
    const cols = defaultExportColumns({ scalarFields: { x: field([1]) } } as never);
    expect(cols.filter(c => c.slug === 'x')).toHaveLength(1);
  });

  it('recovers columns from an ASCII_format hint for octree clouds (no in-RAM fields)', () => {
    // An octree cloud has no in-RAM colors/scalarFields; columns come from the
    // Helios ASCII_format. 'row'/'column' become scalars; r/g/b become colour.
    const cols = defaultExportColumns(
      { scalarFields: {} } as never,
      { asciiFormat: 'row column x y z r g b reflectance' },
    );
    const slugs = cols.map(c => c.slug);
    expect(slugs).toContain('r');
    expect(slugs).toContain('reflectance');
    expect(slugs).toContain('row');
    expect(slugs.slice(0, 3)).toEqual(['x', 'y', 'z']);
    // No duplicate geometry even though the format lists x y z.
    expect(slugs.filter(s => s === 'x')).toHaveLength(1);
  });
});

describe('lockGeometryForScanXml', () => {
  it('forces x/y/z selected + required, leaves others alone', () => {
    const base = defaultExportColumns({
      colors: new Float32Array([0, 0, 0]), scalarFields: { is_miss: field([0]) },
    } as never).map(c => ({ ...c, selected: false }));  // user deselected everything
    const locked = lockGeometryForScanXml(base);
    const geo = locked.filter(c => c.kind === 'geometry');
    expect(geo.every(c => c.selected && c.required)).toBe(true);
    // Non-geometry stays as the user left it (deselected here).
    expect(locked.find(c => c.slug === 'is_miss')!.selected).toBe(false);
  });
});

describe('selectedSlugs', () => {
  it('returns the ordered slugs of selected columns only', () => {
    const cols = defaultExportColumns({
      colors: new Float32Array([0, 0, 0]), scalarFields: {},
    } as never);
    cols[3].selected = false;  // drop R
    expect(selectedSlugs(cols)).toEqual(['x', 'y', 'z', 'g', 'b']);
  });
});

describe('cellValue', () => {
  const data = {
    positions: new Float32Array([1.5, 2.5, 3.5]),
    colors: new Float32Array([1, 0.5, 0]),
    intensities: new Float32Array([0.25]),
    scalarFields: { is_miss: field([1]) },
  };
  it('formats geometry to 6 dp and colour to 0-255 ints', () => {
    expect(cellValue(data as never, 'x', 0)).toBe('1.500000');
    expect(cellValue(data as never, 'r', 0)).toBe('255');
    expect(cellValue(data as never, 'g', 0)).toBe('128');
    expect(cellValue(data as never, 'b', 0)).toBe('0');
  });
  it('reads intensity and scalar fields', () => {
    expect(cellValue(data as never, 'intensity', 0)).toBe('0.2500');
    expect(cellValue(data as never, 'is_miss', 0)).toBe('1');
  });
  it('emits 0 for an absent slug', () => {
    expect(cellValue({ positions: new Float32Array([0, 0, 0]), scalarFields: {} } as never, 'r', 0)).toBe('0');
  });
});

describe('buildAsciiExport', () => {
  const data = {
    pointCount: 2,
    positions: new Float32Array([0, 0, 0, 1, 1, 1]),
    colors: new Float32Array([1, 1, 1, 0, 0, 0]),
    scalarFields: { is_miss: field([0, 1]) },
  };
  it('writes a # header and rows in the chosen column order', () => {
    const txt = buildAsciiExport(data as never, ['x', 'y', 'z', 'is_miss'], ' ', '# ');
    const lines = txt.split('\n');
    expect(lines[0]).toBe('# x y z is_miss');
    expect(lines[1]).toBe('0.000000 0.000000 0.000000 0');
    expect(lines[2]).toBe('1.000000 1.000000 1.000000 1');
  });
  it('honors a reordered/subset column list and csv delimiter', () => {
    const csv = buildAsciiExport(data as never, ['is_miss', 'z', 'x'], ',', '');
    const lines = csv.split('\n');
    expect(lines[0]).toBe('is_miss,z,x');
    expect(lines[1]).toBe('0,0.000000,0.000000');
  });
});

describe('reorderColumns', () => {
  it('moves a column to a new position', () => {
    const cols = defaultExportColumns({ scalarFields: { intensity: field([1]) } } as never);
    // x y z intensity → move intensity (idx 3) to front (idx 0)
    const moved = reorderColumns(cols, 3, 0);
    expect(moved.map(c => c.slug)).toEqual(['intensity', 'x', 'y', 'z']);
    // Original is untouched (pure).
    expect(cols.map(c => c.slug)).toEqual(['x', 'y', 'z', 'intensity']);
  });

  it('clamps out-of-range targets and ignores bad source', () => {
    const cols = defaultExportColumns({ scalarFields: {} } as never);
    expect(reorderColumns(cols, 0, 99).map(c => c.slug)).toEqual(['y', 'z', 'x']);
    expect(reorderColumns(cols, -1, 0).map(c => c.slug)).toEqual(['x', 'y', 'z']);
  });
});
