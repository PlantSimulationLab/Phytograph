import { describe, expect, it } from 'vitest';
import { buildPointCloudFromOctree } from './pointCloudParsers';
import { octreeScalarFieldOptions, importedColumnsFor } from './pointCloudHelpers';
import { defaultExportColumns } from './exportColumns';

// Attributes exactly as the backend reports them for a RIEGL scan: the time
// column arrives under PotreeConverter's LAS name, `gps-time`.
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
    '/p.riproject', 'ScanPos001', { sessionId: 's1' },
  );
}

describe('gps-time is normalised to the timestamp slug', () => {
  it('exposes the octree column as `timestamp`, not `gps-time`', () => {
    // The scan dropdown listed "gps-time" because the raw LAS dimension name
    // reached the renderer unchanged.
    const ranges = build().octree?.attributeRanges ?? {};
    expect(Object.keys(ranges)).toContain('timestamp');
    expect(Object.keys(ranges)).not.toContain('gps-time');
  });

  it('offers it in the colour-by picker', () => {
    const data = build();
    const opts = octreeScalarFieldOptions(
      data.octree?.attributeRanges, data.octree?.attributeLabels,
    ).map(o => o.value);
    expect(opts).toContain('timestamp');
  });

  it('offers it in the export picker', () => {
    // THE REPORTED BUG: neither "Timestamp" nor "gps-time" could be selected
    // for export, because `gps-time` sat on the export blocklist and the
    // canonical `timestamp` slug never existed on the cloud.
    const data = build();
    const ranges = data.octree?.attributeRanges ?? {};
    const cols = defaultExportColumns(data, {
      octreeAttributes: Object.keys(ranges),
      octreeAttributeRanges: ranges,
    } as never).map(c => c.slug);
    expect(cols).toContain('timestamp');
    expect(cols).not.toContain('gps-time');
  });

  it('lists it among the imported columns', () => {
    // importedColumnsFor takes a SCAN ({data}), not the PointCloudData itself.
    expect(importedColumnsFor({ data: build() } as never)).toContain('timestamp');
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
    expect(Object.keys(data.octree?.attributeRanges ?? {})).not.toContain('timestamp');
  });
});
