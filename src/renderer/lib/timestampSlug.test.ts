import { describe, expect, it } from 'vitest';
import { buildPointCloudFromOctree } from './pointCloudParsers';
import {
  displayLabelFor,
  octreeScalarFieldOptions,
  importedColumnsFor,
  octreeAttributeSlug,
  slugToOctreeAttribute,
  OCTREE_GPS_TIME_ATTRIBUTE,
  TIMESTAMP_SLUG,
} from './pointCloudHelpers';
import { defaultExportColumns } from './exportColumns';

// Attributes exactly as the backend reports them for a RiSCAN-exported LAZ: the
// time column arrives under PotreeConverter's LAS name, `gps-time`.
const ATTRS = [
  { name: 'position', min: [-450, -391, -40], max: [353, 440, 115] },
  { name: 'intensity', min: [0], max: [65535] },
  { name: 'return number', min: [0], max: [0] },
  { name: 'classification', min: [0], max: [0] },
  { name: 'gps-time', min: [85.154], max: [233.568] },
  { name: 'reflectance', min: [-40.4], max: [28.4], label: 'Reflectance' },
  { name: 'target_index', min: [1], max: [3] },
  { name: 'is_miss', min: [0], max: [1], label: 'Miss' },
];

function build() {
  return buildPointCloudFromOctree(
    { cache_id: 'c', cache_dir: '/tmp', point_count: 10,
      bounds: { min: [0,0,0], max: [1,1,1] },
      tight_bounds: { min: [0,0,0], max: [1,1,1] },
      session_id: 's1', attributes: ATTRS } as never,
    '/p.laz', 'ScanPos001', { sessionId: 's1' },
  );
}

// The time column has TWO correct names, one per layer. Conflating them is the
// bug this file exists for, in both directions:
//
//   - Renaming the octree attribute to `timestamp` broke COLOUR-BY:
//     swapScalarIntoIntensity does a bare `geometry.attributes[field]` lookup
//     against PotreeConverter's own buffer key, so the lookup missed, the swap
//     silently no-opped, and the shader kept the previous buffer — points stayed
//     coloured by intensity while the legend showed the 85–233 s timestamp range.
//     ("Colour by timestamp looks like garbage.")
//
//   - Leaving it as `gps-time` in the export picker broke EXPORT: the backend
//     allowlist keys off `timestamp`, so the column was either absent or written
//     under a name the writer ignores.
describe('the time column keeps its buffer key and exports under its slug', () => {
  it('keeps PotreeConverter\'s name in the octree attribute ranges', () => {
    // Load-bearing: this key indexes the GPU buffer, not a display name.
    const ranges = build().octree?.attributeRanges ?? {};
    expect(Object.keys(ranges)).toContain('gps-time');
    expect(Object.keys(ranges)).not.toContain('timestamp');
  });

  it('offers colour-by under the BUFFER key so the swap resolves', () => {
    const data = build();
    const opts = octreeScalarFieldOptions(
      data.octree?.attributeRanges, data.octree?.attributeLabels,
    ).map(o => o.value);
    // `octreeScalarFieldOptions().value` is fed straight to
    // swapScalarIntoIntensity. A `timestamp` here is the garbage-colour bug.
    expect(opts).toContain('gps-time');
    expect(opts).not.toContain('timestamp');
  });

  it('offers export under the canonical SLUG', () => {
    const data = build();
    const ranges = data.octree?.attributeRanges ?? {};
    const cols = defaultExportColumns(data, {
      octreeAttributes: Object.keys(ranges),
      octreeAttributeRanges: ranges,
    } as never).map(c => c.slug);
    expect(cols).toContain('timestamp');
    expect(cols).not.toContain('gps-time');
  });

  it('carries every non-degenerate scalar into the export picker', () => {
    // The other half of the report: "many scalar fields are missing".
    const data = build();
    const ranges = data.octree?.attributeRanges ?? {};
    const cols = defaultExportColumns(data, {
      octreeAttributes: Object.keys(ranges),
      octreeAttributeRanges: ranges,
    } as never).map(c => c.slug);
    for (const want of ['reflectance', 'target_index', 'is_miss', 'timestamp']) {
      expect(cols).toContain(want);
    }
    // Degenerate all-zero LAS schema dims stay out.
    expect(cols).not.toContain('return number');
    expect(cols).not.toContain('classification');
  });

  it('lists the time column among the imported columns', () => {
    expect(importedColumnsFor({ data: build() } as never)).toContain('gps-time');
  });

  it('maps between the two names in both directions', () => {
    expect(octreeAttributeSlug(OCTREE_GPS_TIME_ATTRIBUTE)).toBe(TIMESTAMP_SLUG);
    expect(octreeAttributeSlug('reflectance')).toBe('reflectance');
    // Round-trip against a cloud that uses PotreeConverter's spelling.
    expect(slugToOctreeAttribute(TIMESTAMP_SLUG, ['gps-time', 'reflectance']))
      .toBe(OCTREE_GPS_TIME_ATTRIBUTE);
    // A cloud with a GENUINE `timestamp` attribute (an ASCII import naming its
    // own column) must not be redirected to `gps-time`.
    expect(slugToOctreeAttribute(TIMESTAMP_SLUG, ['timestamp', 'reflectance']))
      .toBe(TIMESTAMP_SLUG);
    // Neither present → unchanged, never an invented name.
    expect(slugToOctreeAttribute(TIMESTAMP_SLUG, ['reflectance']))
      .toBe(TIMESTAMP_SLUG);
  });

  it('leaves a cloud with no time column alone', () => {
    const data = buildPointCloudFromOctree(
      { cache_id: 'c', cache_dir: '/tmp', point_count: 10,
        bounds: { min: [0,0,0], max: [1,1,1] },
        tight_bounds: { min: [0,0,0], max: [1,1,1] },
        session_id: 's2',
        attributes: [{ name: 'position', min: [0,0,0], max: [1,1,1] }] } as never,
      '/x.las', 'x', { sessionId: 's2' },
    );
    const ranges = Object.keys(data.octree?.attributeRanges ?? {});
    expect(ranges).not.toContain('timestamp');
    expect(ranges).not.toContain('gps-time');
  });
});

describe('the Scans panel and the Color-by picker agree', () => {
  // THE BUG: the Color-by dropdown rendered the octree's LABEL ("Timestamp")
  // while the scan row's "fields:" line rendered the raw octree BUFFER KEY
  // ("gps-time"). Same column, two names, depending on which panel you looked
  // at — which is exactly what made this so hard to reason about.
  const scan = {
    data: {
      octree: {
        attributeRanges: {
          'gps-time': { min: [85.15], max: [233.57] },
          reflectance: { min: [-40], max: [28] },
          Amplitude: { min: [0.4], max: [59] },
        },
        attributeLabels: {
          'gps-time': 'Timestamp',
          reflectance: 'Reflectance',
          Amplitude: 'Amplitude',
        },
      },
    },
  } as never;

  it('lists the time column as "Timestamp" in the scan row', () => {
    const cols = importedColumnsFor(scan);
    expect(cols).toContain('Timestamp');
    expect(cols).not.toContain('gps-time');
  });

  it('offers the same display name in the Color-by picker', () => {
    const opts = octreeScalarFieldOptions(
      (scan as never as { data: { octree: { attributeRanges: Record<string, { min: number[]; max: number[] }> } } })
        .data.octree.attributeRanges,
      { 'gps-time': 'Timestamp', reflectance: 'Reflectance', Amplitude: 'Amplitude' },
    );
    const timestamp = opts.find((o) => o.label === 'Timestamp');
    expect(timestamp).toBeDefined();
    // …while still submitting the BUFFER KEY, which is what
    // swapScalarIntoIntensity looks the GPU buffer up by.
    expect(timestamp!.value).toBe('gps-time');
  });

  it('the two panels show the same set of names', () => {
    const panel = new Set(importedColumnsFor(scan));
    const picker = octreeScalarFieldOptions(
      (scan as never as { data: { octree: { attributeRanges: Record<string, { min: number[]; max: number[] }> } } })
        .data.octree.attributeRanges,
      { 'gps-time': 'Timestamp', reflectance: 'Reflectance', Amplitude: 'Amplitude' },
    ).map((o) => o.label);
    // The panel is deliberately BROADER (it also lists constants and LAS
    // builtins), but every name the picker offers must appear there under the
    // SAME spelling — a name in one and not the other is the bug.
    for (const label of picker) expect(panel.has(label)).toBe(true);
  });

  it('shows the same display name in the EXPORT picker', () => {
    // The fourth surface. `defaultExportColumns` keys its columns by the
    // CANONICAL slug (`gps-time` → `timestamp`), but attributeLabels is keyed by
    // the BUFFER name — so a direct lookup missed for exactly that column and
    // the picker fell back to the bare lowercase slug while every other panel
    // said "Timestamp".
    const labels = {
      'gps-time': 'Timestamp', reflectance: 'Reflectance', Amplitude: 'Amplitude',
    };
    const ranges = {
      position: { min: [0], max: [1] },
      'gps-time': { min: [85.15], max: [233.57] },
      reflectance: { min: [-40], max: [28] },
      Amplitude: { min: [0.4], max: [59] },
    };
    const labelFor = (slug: string) => displayLabelFor(slug, labels);
    const cols = defaultExportColumns(
      { colors: null, intensities: null, scalarFields: undefined } as never,
      { labelFor, octreeAttributes: Object.keys(ranges), octreeAttributeRanges: ranges } as never,
    );
    const ts = cols.find((c) => c.slug === 'timestamp');
    expect(ts).toBeDefined();
    expect(ts!.label).toBe('Timestamp');
  });

  it('falls back to the raw name when no label exists', () => {
    const s = {
      data: { octree: { attributeRanges: { weird_col: { min: [0], max: [1] } }, attributeLabels: {} } },
    } as never;
    expect(importedColumnsFor(s)).toContain('weird_col');
  });
});

describe('a degenerate gps-time never reaches the Color-by picker', () => {
  // PotreeConverter writes the full LAS point schema even for an ASCII source,
  // so a cloud carrying a real `timestamp` column ALSO reports an all-zero
  // `gps-time`. Offering both showed the same quantity twice — once empty —
  // and the empty one is indistinguishable in the menu.
  //
  // Not fixable with a name blocklist: `gps-time` IS the real column on a
  // LAS/LAZ or .riproject import. An all-zero range is the discriminator.
  it('hides the schema artifact when a real timestamp column exists', () => {
    const opts = octreeScalarFieldOptions(
      {
        timestamp: { min: [100], max: [105] },
        Deviation: { min: [0], max: [3] },
        'gps-time': { min: [0], max: [0] },
      },
      { timestamp: 'Timestamp' },
    ).map((o) => o.value);
    expect(opts).toContain('timestamp');
    expect(opts).not.toContain('gps-time');
  });

  it('keeps gps-time when it IS the real column', () => {
    const opts = octreeScalarFieldOptions(
      {
        'gps-time': { min: [85.15], max: [233.57] },
        reflectance: { min: [-40], max: [28] },
      },
      { 'gps-time': 'Timestamp' },
    );
    const ts = opts.find((o) => o.value === 'gps-time');
    expect(ts).toBeDefined();
    expect(ts!.label).toBe('Timestamp');
  });

  it('keeps an attribute with no range entry', () => {
    // Absence of evidence isn't evidence of absence — never drop a column we
    // simply have no range for.
    const opts = octreeScalarFieldOptions(
      { 'gps-time': { min: [], max: [] } }, {},
    ).map((o) => o.value);
    expect(opts).toContain('gps-time');
  });

  it('does NOT hide other degenerate columns', () => {
    // The filter is scoped to the time column. An all-zero `classification` is
    // deliberately kept — a user may have segmented into it, and an empty class
    // column is meaningful in a way an empty duplicate of an existing column is
    // not. A blanket degenerate filter broke this.
    const opts = octreeScalarFieldOptions(
      { classification: { min: [0], max: [0] }, Deviation: { min: [0], max: [3] } },
      {},
    ).map((o) => o.value);
    expect(opts).toContain('classification');
  });
});
