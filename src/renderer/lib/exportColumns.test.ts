import { describe, it, expect } from 'vitest';
import {
  defaultExportColumns,
  lockGeometryForScanXml,
  selectedSlugs,
  reorderColumns,
  supportsColumnSelection,
  usesFixedColumnOrder,
  lockFixedDimsForLas,
  cellValue,
  buildAsciiExport,
  type ExportColumn,
} from './exportColumns';

function field(values: number[]) {
  return { values: new Float32Array(values), min: Math.min(...values), max: Math.max(...values) };
}

describe('supportsColumnSelection', () => {
  it('is true for every format that can carry a chosen field', () => {
    // PLY names each column as a `property`; LAS/LAZ declare each scalar as a
    // named extra dimension. Both can therefore honor a subset. Treating LAS as
    // "fixed schema, nothing to choose" conflated its fixed STANDARD dimensions
    // with its freely-declared extra dimensions.
    for (const f of ['xyz', 'txt', 'csv', 'ply', 'las', 'laz', 'scan']) {
      expect(supportsColumnSelection(f)).toBe(true);
    }
  });

  it('is false only for OBJ, where a `v` line takes exactly x/y/z', () => {
    expect(supportsColumnSelection('obj')).toBe(false);
    // E57 is not in the set either — the scan writer gives it a fixed schema.
    expect(supportsColumnSelection('e57')).toBe(false);
  });
});

describe('usesFixedColumnOrder', () => {
  it('is true for LAS/LAZ, which identify dimensions by name not position', () => {
    for (const f of ['las', 'laz']) expect(usesFixedColumnOrder(f)).toBe(true);
  });

  it('is false for the positional formats, whose column order is the file order', () => {
    for (const f of ['xyz', 'txt', 'csv', 'ply', 'scan']) {
      expect(usesFixedColumnOrder(f)).toBe(false);
    }
  });
});

describe('lockFixedDimsForLas', () => {
  // LAS cannot omit x/y/z (they ARE the point record) or intensity (present in
  // the core record of every point format 0-3, so deselecting could only write
  // zeros). Colour is deliberately NOT locked: dropping r/g/b selects point
  // format 1, which has no RGB dimension — a real omission.
  const sample = (): ExportColumn[] => [
    { slug: 'x', label: 'X', kind: 'geometry', selected: true },
    { slug: 'y', label: 'Y', kind: 'geometry', selected: false },
    { slug: 'z', label: 'Z', kind: 'geometry', selected: true },
    { slug: 'r', label: 'R', kind: 'color', selected: false },
    { slug: 'intensity', label: 'Intensity', kind: 'intensity', selected: false },
    { slug: 'refl', label: 'Refl', kind: 'scalar', selected: false },
    { slug: 'cls', label: 'Class', kind: 'label', selected: true },
  ];

  it('forces geometry and intensity on and marks them required', () => {
    const locked = lockFixedDimsForLas(sample());
    const by = Object.fromEntries(locked.map(c => [c.slug, c]));
    for (const slug of ['x', 'y', 'z', 'intensity']) {
      expect(by[slug].selected).toBe(true);
      expect(by[slug].required).toBe(true);
    }
  });

  it('leaves colour selectable — dropping RGB is a real omission in LAS', () => {
    const by = Object.fromEntries(lockFixedDimsForLas(sample()).map(c => [c.slug, c]));
    expect(by['r'].selected).toBe(false);
    expect(by['r'].required).toBeUndefined();
  });

  it('leaves scalars and labels exactly as the user set them', () => {
    const by = Object.fromEntries(lockFixedDimsForLas(sample()).map(c => [c.slug, c]));
    expect(by['refl'].selected).toBe(false);
    expect(by['refl'].required).toBeUndefined();
    expect(by['cls'].selected).toBe(true);
    expect(by['cls'].required).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const input = sample();
    lockFixedDimsForLas(input);
    expect(input[1].selected).toBe(false);
    expect(input[4].selected).toBe(false);
  });

  it('selectedSlugs after locking always includes geometry and intensity', () => {
    const slugs = selectedSlugs(lockFixedDimsForLas(sample()));
    expect(slugs).toEqual(expect.arrayContaining(['x', 'y', 'z', 'intensity']));
    expect(slugs).not.toContain('r');
    expect(slugs).not.toContain('refl');
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

  // The regression these guard: an octree/session-backed cloud (i.e. EVERY
  // normal import — xyz/txt/csv/ply/pcd/las/laz/e57) keeps no flat arrays at all,
  // and `asciiFormat` is set only by the Helios-XML importer. So the picker saw
  // no colours, no intensity and no scalarFields, and degenerated to bare x/y/z.
  // `attributeRanges` keys are the authoritative field list for those clouds.
  describe('octree attributes (the normal import path)', () => {
    it('surfaces scalars from octree attributes with no asciiFormat and no flat arrays', () => {
      const cols = defaultExportColumns(
        { scalarFields: {} } as never,
        { octreeAttributes: ['position', 'rgb', 'intensity', 'reflectance', 'ground_class'] },
      );
      const slugs = cols.map(c => c.slug);
      expect(slugs.slice(0, 3)).toEqual(['x', 'y', 'z']);
      // rgb maps to the three colour slugs...
      expect(slugs).toContain('r');
      expect(slugs).toContain('g');
      expect(slugs).toContain('b');
      // ...intensity keeps its own slug and kind...
      expect(cols.find(c => c.slug === 'intensity')?.kind).toBe('intensity');
      // ...and the real scalars come through.
      expect(slugs).toContain('reflectance');
      expect(slugs).toContain('ground_class');
      // 'position' is geometry plumbing, never its own column.
      expect(slugs).not.toContain('position');
      expect(slugs).not.toContain('rgb');
    });

    it('drops PotreeConverter schema plumbing that is not user-meaningful', () => {
      const cols = defaultExportColumns(
        { scalarFields: {} } as never,
        {
          octreeAttributes: [
            'position', 'rgb', 'normal', 'indices', 'spacing',
            'return number', 'number of returns', 'scan angle rank',
            'user data', 'point source id', 'gps-time',
            'reflectance',
          ],
        },
      );
      // Only geometry, colour, and the one real scalar survive.
      expect(cols.map(c => c.slug)).toEqual(['x', 'y', 'z', 'r', 'g', 'b', 'reflectance']);
    });

    it('keeps classification, which a user may have segmented', () => {
      const cols = defaultExportColumns(
        { scalarFields: {} } as never,
        { octreeAttributes: ['position', 'classification'] },
      );
      expect(cols.map(c => c.slug)).toContain('classification');
    });

    it('applies display labels to octree attribute slugs', () => {
      const cols = defaultExportColumns(
        { scalarFields: {} } as never,
        {
          octreeAttributes: ['Reflectance_dB'],
          labelFor: (s) => (s === 'Reflectance_dB' ? 'Reflectance [dB]' : s),
        },
      );
      expect(cols.find(c => c.slug === 'Reflectance_dB')?.label).toBe('Reflectance [dB]');
    });

    it('classifies a categorical octree attribute as a label', () => {
      const cols = defaultExportColumns(
        { scalarFields: {} } as never,
        { octreeAttributes: ['ground_class'], isLabel: (s) => s === 'ground_class' },
      );
      expect(cols.find(c => c.slug === 'ground_class')?.kind).toBe('label');
    });

    it('does not duplicate a field present in both octree attributes and scalarFields', () => {
      // A synthetic scan populates BOTH flat scalarFields and octree attributes.
      const cols = defaultExportColumns(
        { scalarFields: { reflectance: field([1, 2]) } } as never,
        { octreeAttributes: ['reflectance', 'ground_class'] },
      );
      expect(cols.filter(c => c.slug === 'reflectance')).toHaveLength(1);
      expect(cols.map(c => c.slug)).toContain('ground_class');
    });

    it('unions octree attributes with ASCII_format tokens without duplicating', () => {
      const cols = defaultExportColumns(
        { scalarFields: {} } as never,
        {
          octreeAttributes: ['reflectance'],
          asciiFormat: 'x y z reflectance target_index',
        },
      );
      const slugs = cols.map(c => c.slug);
      expect(slugs.filter(s => s === 'reflectance')).toHaveLength(1);
      expect(slugs).toContain('target_index');
    });

    // PotreeConverter writes the full LAS schema even for a bare `x y z` source,
    // so a plain XYZ import reports intensity/classification/gps-time as all-zero
    // attributes. Offering those as export columns invents fields the cloud never
    // had. A name blocklist can't decide it (classification and intensity are
    // real on a LAS import) — the all-zero range is the discriminator.
    it('drops all-zero schema dimensions but keeps ones with real range', () => {
      const cols = defaultExportColumns(
        { scalarFields: {} } as never,
        {
          octreeAttributes: ['position', 'intensity', 'classification', 'reflectance', 'rgb'],
          octreeAttributeRanges: {
            position: { min: [0, 0, 0], max: [1, 1, 1] },
            intensity: { min: [0], max: [0] },        // degenerate → dropped
            classification: { min: [0], max: [0] },   // degenerate → dropped
            reflectance: { min: [-20], max: [3] },    // real → kept
            rgb: { min: [0, 0, 0], max: [255, 255, 255] },
          },
        },
      );
      const slugs = cols.map(c => c.slug);
      expect(slugs).not.toContain('intensity');
      expect(slugs).not.toContain('classification');
      expect(slugs).toContain('reflectance');
      // Colour survives: its range is real.
      expect(slugs).toContain('r');
    });

    it('keeps classification when it carries real class values (a LAS import)', () => {
      const cols = defaultExportColumns(
        { scalarFields: {} } as never,
        {
          octreeAttributes: ['position', 'classification'],
          octreeAttributeRanges: {
            position: { min: [0, 0, 0], max: [1, 1, 1] },
            classification: { min: [1], max: [5] },
          },
        },
      );
      expect(cols.map(c => c.slug)).toContain('classification');
    });

    it('drops a degenerate rgb so no phantom colour columns appear', () => {
      const cols = defaultExportColumns(
        { scalarFields: {} } as never,
        {
          octreeAttributes: ['position', 'rgb'],
          octreeAttributeRanges: {
            position: { min: [0, 0, 0], max: [1, 1, 1] },
            rgb: { min: [0, 0, 0], max: [0, 0, 0] },
          },
        },
      );
      expect(cols.map(c => c.slug)).toEqual(['x', 'y', 'z']);
    });

    it('keeps an attribute that has no range entry at all', () => {
      // Absence of evidence isn't evidence of absence — an attribute the octree
      // metadata didn't report a range for must not be silently dropped.
      const cols = defaultExportColumns(
        { scalarFields: {} } as never,
        {
          octreeAttributes: ['reflectance'],
          octreeAttributeRanges: { position: { min: [0], max: [1] } },
        },
      );
      expect(cols.map(c => c.slug)).toContain('reflectance');
    });

    it('adds no colour columns when the octree has no rgb attribute', () => {
      const cols = defaultExportColumns(
        { scalarFields: {} } as never,
        { octreeAttributes: ['position', 'reflectance'] },
      );
      expect(cols.map(c => c.slug)).toEqual(['x', 'y', 'z', 'reflectance']);
    });
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
