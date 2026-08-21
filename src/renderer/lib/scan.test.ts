import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  duplicateScanName, derivedScanName, hasData, hasParams, scanDisplayName,
  columnSlugs, missColumnsAvailable, isBackfillEligible, scanHasKnownOrigin, missReconSources, type Scan,
} from './scan';
import { DEFAULT_SCAN_PARAMETERS } from './scanParameters';
import type { PointCloudData, OctreeRef, ScalarField } from './pointCloudTypes';

function makeData(fileName?: string): PointCloudData {
  return {
    positions: new Float32Array([0, 0, 0]),
    pointCount: 1,
    bounds: {
      min: new THREE.Vector3(0, 0, 0),
      max: new THREE.Vector3(0, 0, 0),
      center: new THREE.Vector3(0, 0, 0),
      size: new THREE.Vector3(0, 0, 0),
    },
    fileName,
  };
}

// Build a scan whose cloud carries the given column slugs (as octree attribute
// labels) and an optional hasMisses flag — the surface isBackfillEligible reads.
function makeScanWithColumns(
  slugs: string[],
  opts: { hasMisses?: boolean; flat?: boolean } = {},
): Scan {
  const data = makeData('scan.las');
  if (opts.flat) {
    const fields: Record<string, ScalarField> = {};
    for (const s of slugs) fields[s] = { values: new Float32Array([0]), min: 0, max: 0 };
    data.scalarFields = fields;
  } else {
    const octree: OctreeRef = {
      cacheId: 'c', sourceXyzPath: '', sessionId: 'sess',
      hasMisses: opts.hasMisses,
      attributeLabels: Object.fromEntries(slugs.map((s) => [s, s])),
    };
    data.octree = octree;
  }
  return { id: '1', label: 'a', visible: true, color: '#000', data };
}

describe('hasData / hasParams predicates', () => {
  it('hasData is true only when data is set', () => {
    const dataOnly: Scan = { id: '1', label: 'a', visible: true, color: '#000', data: makeData('a.las') };
    const paramsOnly: Scan = { id: '2', label: 'b', visible: true, color: '#000', params: DEFAULT_SCAN_PARAMETERS };
    expect(hasData(dataOnly)).toBe(true);
    expect(hasData(paramsOnly)).toBe(false);
  });

  it('hasParams is true only when params are set', () => {
    const dataOnly: Scan = { id: '1', label: 'a', visible: true, color: '#000', data: makeData('a.las') };
    const paramsOnly: Scan = { id: '2', label: 'b', visible: true, color: '#000', params: DEFAULT_SCAN_PARAMETERS };
    expect(hasParams(dataOnly)).toBe(false);
    expect(hasParams(paramsOnly)).toBe(true);
  });
});

describe('scanDisplayName', () => {
  it('uses an explicit label first', () => {
    const scan: Scan = { id: '1', label: 'North Tripod', visible: true, color: '#000' };
    expect(scanDisplayName(scan)).toBe('North Tripod');
  });

  it('falls back to data.fileName when label is empty', () => {
    const scan: Scan = { id: '1', label: '', visible: true, color: '#000', data: makeData('scan0.las') };
    expect(scanDisplayName(scan)).toBe('scan0.las');
  });

  it('falls back to "Untitled scan" when both are missing', () => {
    const scan: Scan = { id: '1', label: '', visible: true, color: '#000' };
    expect(scanDisplayName(scan)).toBe('Untitled scan');
  });
});

describe('duplicateScanName', () => {
  it('appends "(copy)" to a fresh base name', () => {
    expect(duplicateScanName('MyScan', [])).toBe('MyScan (copy)');
  });

  it('promotes "(copy)" to "(copy 2)" when duplicating a copy', () => {
    expect(duplicateScanName('MyScan (copy)', ['MyScan', 'MyScan (copy)']))
      .toBe('MyScan (copy 2)');
  });

  it('strips an existing "(copy N)" suffix before re-enumerating', () => {
    // Duplicating "MyScan (copy 2)" re-bases on "MyScan" rather than stacking
    // suffixes, then picks the first free copy slot.
    expect(duplicateScanName('MyScan (copy 2)', ['MyScan', 'MyScan (copy)']))
      .toBe('MyScan (copy 2)');
  });

  it('skips taken names to find the first free slot', () => {
    expect(
      duplicateScanName('MyScan', ['MyScan', 'MyScan (copy)', 'MyScan (copy 2)']),
    ).toBe('MyScan (copy 3)');
  });

  it('handles filename-style labels with extensions', () => {
    expect(duplicateScanName('tree.xyz', ['tree.xyz'])).toBe('tree.xyz (copy)');
  });

  it('treats the base independently of unrelated names in the set', () => {
    expect(duplicateScanName('Scan A', ['Scan B', 'Scan B (copy)']))
      .toBe('Scan A (copy)');
  });
});

// derivedScanName generalises the "(copy)" enumeration to any suffix, so a
// retained crop can produce "… (cropped)". duplicateScanName is now a thin
// wrapper over it — the suite above doubles as the regression guard.
describe('derivedScanName', () => {
  it('appends the given suffix to a fresh base name', () => {
    expect(derivedScanName('tree.xyz', [], 'cropped')).toBe('tree.xyz (cropped)');
  });

  it('enumerates when the first slot is taken', () => {
    expect(derivedScanName('tree.xyz', ['tree.xyz (cropped)'], 'cropped'))
      .toBe('tree.xyz (cropped 2)');
  });

  it('strips its own suffix so cropping a crop does not stack', () => {
    expect(
      derivedScanName('tree.xyz (cropped)', ['tree.xyz', 'tree.xyz (cropped)'], 'cropped'),
    ).toBe('tree.xyz (cropped 2)');
  });

  it('only strips the MATCHING suffix, leaving other derivations intact', () => {
    // A crop of a duplicate keeps the "(copy)" part of its lineage.
    expect(derivedScanName('tree.xyz (copy)', [], 'cropped'))
      .toBe('tree.xyz (copy) (cropped)');
  });

  it('is independent per suffix — a taken "(copy)" never blocks "(cropped)"', () => {
    expect(derivedScanName('tree.xyz', ['tree.xyz (copy)'], 'cropped'))
      .toBe('tree.xyz (cropped)');
  });
});

describe('missColumnsAvailable', () => {
  it('is true when a timestamp column is present', () => {
    expect(missColumnsAvailable(makeScanWithColumns(['timestamp']))).toBe(true);
  });

  it('is true when BOTH grid indices are present', () => {
    expect(missColumnsAvailable(makeScanWithColumns(['row_index', 'column_index']))).toBe(true);
  });

  it('is false when only ONE grid index is present (need both)', () => {
    expect(missColumnsAvailable(makeScanWithColumns(['row_index']))).toBe(false);
    expect(missColumnsAvailable(makeScanWithColumns(['column_index']))).toBe(false);
  });

  it('is false for a plain xyz cloud (no reconstructable columns)', () => {
    expect(missColumnsAvailable(makeScanWithColumns(['intensity']))).toBe(false);
  });

  it('reads columns from a flat cloud scalarFields too', () => {
    expect(missColumnsAvailable(makeScanWithColumns(['timestamp'], { flat: true }))).toBe(true);
    expect(missColumnsAvailable(makeScanWithColumns(['intensity'], { flat: true }))).toBe(false);
  });
});

describe('missReconSources', () => {
  it('reports timestamp only, preferred = timestamp', () => {
    expect(missReconSources(makeScanWithColumns(['timestamp']))).toEqual({
      hasTimestamp: true, hasGrid: false, preferred: 'timestamp',
    });
  });

  it('reports grid only, preferred = grid', () => {
    expect(missReconSources(makeScanWithColumns(['row_index', 'column_index']))).toEqual({
      hasTimestamp: false, hasGrid: true, preferred: 'grid',
    });
  });

  it('reports both, but PREFERS timestamp (matches backend path choice)', () => {
    expect(missReconSources(makeScanWithColumns(['timestamp', 'row_index', 'column_index']))).toEqual({
      hasTimestamp: true, hasGrid: true, preferred: 'timestamp',
    });
  });

  it('one grid index alone is not a usable grid', () => {
    expect(missReconSources(makeScanWithColumns(['row_index']))).toEqual({
      hasTimestamp: false, hasGrid: false, preferred: null,
    });
  });

  it('reports no sources for a plain cloud (preferred null)', () => {
    expect(missReconSources(makeScanWithColumns(['intensity']))).toEqual({
      hasTimestamp: false, hasGrid: false, preferred: null,
    });
  });
});

describe('isBackfillEligible', () => {
  it('is true: has data, no misses yet, reconstructable columns', () => {
    expect(isBackfillEligible(makeScanWithColumns(['timestamp']))).toBe(true);
    expect(isBackfillEligible(makeScanWithColumns(['row_index', 'column_index']))).toBe(true);
  });

  it('is false when the scan already has misses (E57 / structured PLY)', () => {
    expect(isBackfillEligible(makeScanWithColumns(['timestamp'], { hasMisses: true }))).toBe(false);
  });

  it('is false when no column lets misses be reconstructed', () => {
    expect(isBackfillEligible(makeScanWithColumns(['intensity']))).toBe(false);
  });

  it('is false when the scan has no data at all', () => {
    const scan: Scan = { id: '1', label: 'a', visible: true, color: '#000' };
    expect(isBackfillEligible(scan)).toBe(false);
  });
});

describe('scanHasKnownOrigin', () => {
  it('is true when the octree records a scanOrigin (e.g. E57 pose)', () => {
    const scan = makeScanWithColumns(['timestamp']);
    scan.data!.octree!.scanOrigin = [0, 0, 127];
    expect(scanHasKnownOrigin(scan)).toBe(true);
  });

  it('is true when the scan carries scan parameters (XML / file header)', () => {
    const scan = makeScanWithColumns(['timestamp']);
    scan.params = DEFAULT_SCAN_PARAMETERS;  // params present => a real origin
    expect(scanHasKnownOrigin(scan)).toBe(true);
  });

  it('is false when no scanOrigin and no params (plain XYZ import)', () => {
    const scan = makeScanWithColumns(['timestamp']);  // octree present, no scanOrigin, no params
    expect(scanHasKnownOrigin(scan)).toBe(false);
  });

  it('is false when the scan has no data', () => {
    const scan: Scan = { id: '1', label: 'a', visible: true, color: '#000' };
    expect(scanHasKnownOrigin(scan)).toBe(false);
  });
});

describe('the time column is recognised under either octree spelling', () => {
  // A cloud whose timestamps round-tripped through the LAS `gps_time` field
  // carries the octree attribute under PotreeConverter's own name, `gps-time`.
  // The buffer key must stay that way (it indexes the GPU buffer), so the
  // canonical-slug mapping happens in columnSlugs.
  //
  // THE REPORTED BUG: Backfill Misses refused such a scan with "no column
  // 'timestamp'" while the Color-by picker listed `gps-time` — the same column,
  // two names, one of which no predicate recognised.
  const gpsTimeScan = {
    data: {
      octree: {
        cacheId: 'c', sessionId: 's', sourceXyzPath: '', hasMisses: false,
        attributeRanges: { 'gps-time': { min: [85.15], max: [233.57] } },
      },
    },
  } as never;

  it('reports the canonical slug for a `gps-time` octree', () => {
    expect([...columnSlugs(gpsTimeScan)]).toContain('timestamp');
  });

  it('allows Backfill Misses on a `gps-time` cloud', () => {
    expect(missColumnsAvailable(gpsTimeScan)).toBe(true);
    expect(isBackfillEligible(gpsTimeScan)).toBe(true);
    expect(missReconSources(gpsTimeScan).preferred).toBe('timestamp');
  });

  it('still works for a cloud that names the column `timestamp` itself', () => {
    // The old-export shape: a float32 extra dim named `timestamp`.
    const s = {
      data: { octree: { cacheId: 'c', sessionId: 's', sourceXyzPath: '', hasMisses: false,
        attributeRanges: { timestamp: { min: [85.15], max: [233.57] } } } },
    } as never;
    expect(isBackfillEligible(s)).toBe(true);
  });

  it('does not invent a timestamp for a cloud that has none', () => {
    const s = {
      data: { octree: { cacheId: 'c', sessionId: 's', sourceXyzPath: '', hasMisses: false,
        attributeRanges: { reflectance: { min: [0], max: [1] } } } },
    } as never;
    expect(missColumnsAvailable(s)).toBe(false);
    expect(isBackfillEligible(s)).toBe(false);
  });
});
