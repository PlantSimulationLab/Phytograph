import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  duplicateScanName, derivedScanName, hasData, hasParams, scanDisplayName,
  columnSlugs, missColumnsAvailable, isBackfillEligible, scanHasKnownOrigin, scanOriginOf,
  meanScanOrigin, missReconSources, type Scan,
  composeRegistration, invertRigid4x4, multiply4x4, registeredScans, referenceScanIds,
  allocateScanColor, createScanColorAllocator,
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

describe('scanOriginOf', () => {
  it('prefers params.origin over the octree fallback copy', () => {
    // The two can legitimately disagree: params.origin is what a scan-position
    // gesture writes, while octree.scanOrigin is the copy stamped at import.
    const scan = makeScanWithColumns(['timestamp']);
    scan.data!.octree!.scanOrigin = [9, 9, 9];
    scan.params = { ...DEFAULT_SCAN_PARAMETERS, origin: { x: 1, y: 2, z: 3 } };
    expect(scanOriginOf(scan)).toEqual([1, 2, 3]);
  });

  it('falls back to the octree copy when there are no params (E57 pose)', () => {
    const scan = makeScanWithColumns(['timestamp']);
    scan.data!.octree!.scanOrigin = [4, 5, 6];
    expect(scanOriginOf(scan)).toEqual([4, 5, 6]);
  });

  it('is null for a plain XYZ import, and for a scan with no data at all', () => {
    expect(scanOriginOf(makeScanWithColumns(['intensity']))).toBeNull();
    const bare: Scan = { id: '1', label: 'a', visible: true, color: '#000' };
    expect(scanOriginOf(bare)).toBeNull();
  });
});

describe('meanScanOrigin', () => {
  function scanAt(x: number, y: number, z: number): Scan {
    const scan = makeScanWithColumns(['timestamp']);
    scan.params = { ...DEFAULT_SCAN_PARAMETERS, origin: { x, y, z } };
    return scan;
  }

  it('averages the stations of a multi-position project', () => {
    expect(meanScanOrigin([scanAt(0, 0, 2), scanAt(4, 0, 2), scanAt(2, 6, 8)]))
      .toEqual([2, 2, 4]);
  });

  it('skips originless scans rather than counting them as (0,0,0)', () => {
    // The failure this guards: a plain XYZ dropped alongside a scan project
    // would otherwise halve the centroid toward the world origin.
    const plain = makeScanWithColumns(['intensity']);
    expect(meanScanOrigin([scanAt(10, 10, 10), plain])).toEqual([10, 10, 10]);
  });

  it('is null when nothing in the scene records a position', () => {
    expect(meanScanOrigin([makeScanWithColumns(['intensity'])])).toBeNull();
    expect(meanScanOrigin([])).toBeNull();
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

// ── Auto-Register bookkeeping ───────────────────────────────────────────────
//
// The matrices below are exercised as TRANSFORMS applied to points, not
// compared entry-by-entry: what "Reset Registration" has to get right is that a
// registered cloud lands back on the coordinates it occupied before, and an
// entrywise expectation on a 16-float matrix passes just as happily on a
// transposed or column-major convention that puts the cloud somewhere else.

/** Apply a row-major 4x4 to a point — the same convention the backend's
 *  `/session/{id}/transform` uses on the geometry it bakes. */
function applyRowMajor(m: number[], p: [number, number, number]): [number, number, number] {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

/** Rotation about Z by `deg`, then translation — a rigid pose in the shape
 *  Auto-Register actually returns (the E2E fixture pair is 90° + a shift). */
function rigidZ(deg: number, t: [number, number, number]): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [
    c, -s, 0, t[0],
    s, c, 0, t[1],
    0, 0, 1, t[2],
    0, 0, 0, 1,
  ];
}

function expectClose(a: number[], b: number[], eps = 1e-9) {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(eps));
}

describe('invertRigid4x4', () => {
  it('returns a point to where it started', () => {
    const m = rigidZ(90, [2, -1.5, 0]);
    const p: [number, number, number] = [3, 7, 1.25];
    const moved = applyRowMajor(m, p);
    // Sanity: the transform actually moved it, so the round trip below is not
    // trivially satisfied by an identity matrix.
    expect(Math.hypot(moved[0] - p[0], moved[1] - p[1], moved[2] - p[2])).toBeGreaterThan(1);
    expectClose(applyRowMajor(invertRigid4x4(m), moved), p);
  });

  it('inverts a rotation about a non-principal axis', () => {
    // A registration matrix is rarely a clean single-axis spin; a tilted axis
    // catches an inverse that transposes only part of the rotation block.
    const axis = new THREE.Vector3(0.3, -0.6, 0.74).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(axis, 1.1);
    const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements; // column-major
    const m = [
      e[0], e[4], e[8], -4.2,
      e[1], e[5], e[9], 0.75,
      e[2], e[6], e[10], 11.5,
      0, 0, 0, 1,
    ];
    const p: [number, number, number] = [-2, 5, 0.5];
    expectClose(applyRowMajor(invertRigid4x4(m), applyRowMajor(m, p)), p, 1e-9);
  });

  it('inverts the identity to the identity', () => {
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expectClose(invertRigid4x4(id), id);
  });
});

describe('multiply4x4', () => {
  it('composes in APPLY order — multiply4x4(second, first)', () => {
    // The order is the whole point: a·b must mean "b first, then a", matching
    // how composeRegistration folds a new pass onto an older one. Reversed, a
    // second registration pass would reset the cloud to the wrong place.
    const first = rigidZ(30, [1, 0, 0]);
    const second = rigidZ(45, [0, 2, -1]);
    const p: [number, number, number] = [4, 1, 3];
    expectClose(
      applyRowMajor(multiply4x4(second, first), p),
      applyRowMajor(second, applyRowMajor(first, p)),
    );
  });
});

describe('composeRegistration', () => {
  it('records the first pass verbatim', () => {
    const m = rigidZ(90, [2, -1.5, 0]);
    const reg = composeRegistration(undefined, m, 't1', 'Target');
    expect(reg.matrix).toEqual(m);
    expect(reg.passes).toBe(1);
    expect(reg.targetId).toBe('t1');
    expect(reg.targetLabel).toBe('Target');
  });

  it('does not alias the matrix it was handed', () => {
    // The caller's array is the live ICP response; keeping a reference would
    // let a later mutation silently rewrite history.
    const m = rigidZ(10, [1, 1, 1]);
    const reg = composeRegistration(undefined, m, 't1', 'Target');
    m[3] = 999;
    expect(reg.matrix[3]).toBe(1);
  });

  it('folds a second pass so the inverse undoes BOTH', () => {
    const first = rigidZ(90, [2, -1.5, 0]);
    const second = rigidZ(-12, [0.4, 0.1, 0]);
    const p: [number, number, number] = [3, 7, 1.25];

    const afterFirst = applyRowMajor(first, p);
    const afterSecond = applyRowMajor(second, afterFirst);

    const reg1 = composeRegistration(undefined, first, 't1', 'Target');
    const reg2 = composeRegistration(reg1, second, 't1', 'Target');
    expect(reg2.passes).toBe(2);

    // The accumulated matrix must reproduce both passes...
    expectClose(applyRowMajor(reg2.matrix, p), afterSecond);
    // ...and its inverse must return the cloud to the ORIGINAL pose, not to
    // where the first pass left it.
    expectClose(applyRowMajor(invertRigid4x4(reg2.matrix), afterSecond), p);
  });

  it('updates the target when a scan is re-registered onto a different one', () => {
    const reg1 = composeRegistration(undefined, rigidZ(5, [0, 0, 0]), 't1', 'First');
    const reg2 = composeRegistration(reg1, rigidZ(5, [0, 0, 0]), 't2', 'Second');
    expect(reg2.targetId).toBe('t2');
    expect(reg2.targetLabel).toBe('Second');
  });
});

describe('registeredScans', () => {
  const reg = composeRegistration(undefined, rigidZ(90, [1, 0, 0]), 't', 'T');

  it('picks out only the scans carrying a record', () => {
    const scans: Scan[] = [
      { id: 'a', label: 'A', visible: true, color: '#fff' },
      { id: 'b', label: 'B', visible: true, color: '#fff', registration: reg },
      { id: 'c', label: 'C', visible: true, color: '#fff' },
    ];
    expect(registeredScans(scans).map(s => s.id)).toEqual(['b']);
  });

  it('is empty on an unregistered project', () => {
    expect(registeredScans([
      { id: 'a', label: 'A', visible: true, color: '#fff' },
    ])).toEqual([]);
  });
});

describe('referenceScanIds', () => {
  const regOnto = (targetId: string) =>
    composeRegistration(undefined, rigidZ(90, [1, 0, 0]), targetId, targetId);

  const scan = (id: string, registration?: ReturnType<typeof regOnto>): Scan =>
    ({ id, label: id, visible: true, color: '#fff', ...(registration ? { registration } : {}) });

  it('names the scan others were registered onto', () => {
    const ids = referenceScanIds([scan('a'), scan('b', regOnto('a'))]);
    expect([...ids]).toEqual(['a']);
  });

  it('is empty when nothing has been registered', () => {
    expect(referenceScanIds([scan('a'), scan('b')]).size).toBe(0);
  });

  it('does not mark a mover as a reference', () => {
    // The distinction is the whole point of the separate badge: a mover is
    // reset by Reset Registration, a reference is not.
    const ids = referenceScanIds([scan('a'), scan('b', regOnto('a'))]);
    expect(ids.has('b')).toBe(false);
  });

  it('reports one reference once when several scans register onto it', () => {
    const ids = referenceScanIds([
      scan('a'), scan('b', regOnto('a')), scan('c', regOnto('a')),
    ]);
    expect([...ids]).toEqual(['a']);
  });

  it('handles two independent pairs', () => {
    const ids = referenceScanIds([
      scan('a'), scan('b', regOnto('a')), scan('c'), scan('d', regOnto('c')),
    ]);
    expect([...ids].sort()).toEqual(['a', 'c']);
  });

  it('stops naming a reference once its mover is reset', () => {
    // Reset clears the mover's record, and with it the only thing that made
    // the other scan a reference — the badge must vanish on its own.
    const after = referenceScanIds([scan('a'), scan('b')]);
    expect(after.size).toBe(0);
  });

  it('stops naming a reference once its mover is deleted', () => {
    expect(referenceScanIds([scan('a')]).size).toBe(0);
  });

  it('ignores a target that no longer exists', () => {
    // The reference was deleted but the mover kept its record: there is no row
    // to badge, and the dangling id must not leak out as a phantom reference.
    const ids = referenceScanIds([scan('b', regOnto('deleted-scan'))]);
    expect(ids.size).toBe(0);
  });
});

describe('allocateScanColor / createScanColorAllocator', () => {
  const BLUE = '#3b82f6';
  const GREEN = '#22c55e';
  const AMBER = '#f59e0b';
  const RED = '#ef4444';
  const PALETTE_SIZE = 8;

  it('picks the first palette colour not already on the scene', () => {
    expect(allocateScanColor(new Set())).toBe(BLUE);
    expect(allocateScanColor(new Set([BLUE]))).toBe(GREEN);
    expect(allocateScanColor(new Set([BLUE, GREEN]))).toBe(AMBER);
  });

  // The reported bug: importing ONE file holding several scanner setups (a
  // multi-block PTX, a multi-scan E57) gave every resulting scan the same
  // swatch, because the colour picker read the committed scan list — which does
  // not change until the whole import commits. A generator has to remember what
  // it just handed out.
  it('hands out a DIFFERENT colour on each successive call', () => {
    const next = createScanColorAllocator([]);
    const three = [next(), next(), next()];
    expect(three).toEqual([BLUE, GREEN, AMBER]);
    expect(new Set(three).size).toBe(3);
  });

  it('skips colours already used by existing scans', () => {
    const next = createScanColorAllocator([BLUE, AMBER]);
    expect([next(), next()]).toEqual([GREEN, RED]);
  });

  // Guards the trap that makes the obvious implementation wrong. Accumulating
  // into a `used` set and re-asking for "the first free colour" falls back to
  // `used.size % 8` once every entry is taken — and the set cannot grow past 8,
  // so every allocation from the 9th on returns the SAME colour, reproducing the
  // original bug for any source with more than 8 positions.
  it('keeps cycling past palette exhaustion instead of repeating one colour', () => {
    const next = createScanColorAllocator([]);
    const twelve = Array.from({ length: 12 }, next);

    // First pass: all 8 distinct entries.
    expect(new Set(twelve.slice(0, PALETTE_SIZE)).size).toBe(PALETTE_SIZE);

    // Past exhaustion the colours must still VARY call to call.
    expect(twelve[8]).not.toBe(twelve[9]);
    expect(twelve[9]).not.toBe(twelve[10]);
    expect(twelve[10]).not.toBe(twelve[11]);

    // Concretely: it wraps to the head of the palette rather than freezing.
    expect(twelve.slice(8, 12)).toEqual([BLUE, GREEN, AMBER, RED]);
  });

  // Each import creates its own allocator, so one import's cursor never leaks
  // into the next.
  it('gives independent instances the same sequence from the same seed', () => {
    const a = createScanColorAllocator([BLUE]);
    const b = createScanColorAllocator([BLUE]);
    expect([a(), a()]).toEqual([b(), b()]);
  });
});
