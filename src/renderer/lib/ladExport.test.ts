import { describe, it, expect } from 'vitest';
import type { LADResultEntry, LADVoxel } from './pointCloudTypes';
import {
  buildLadExportRequest, rasterBlockedReason, ladCellSize, ladWorldOrigin,
  base64ToBytes, LAD_EXPORT_VARIABLES,
} from './ladExport';

// The two things here that fail silently if broken: the STORED -> world shift
// (a dropped worldShift still writes a valid raster, just hundreds of km away)
// and the raster-eligibility gate (a rotated grid would write a confidently
// mis-georeferenced file). Both get pinned to concrete numbers.

// A large world origin, so a lost shift is unmistakable rather than a rounding
// difference — this is what a real UTM scan looks like after import.
const WORLD_SHIFT: [number, number, number] = [412300, 4512100, 0];

function voxel(over: Partial<LADVoxel> = {}): LADVoxel {
  return {
    index: 0,
    center: [0.25, 0.25, 0.25],
    size: [0.5, 0.5, 0.5],
    leafArea: 0.25,
    lad: 2,
    gtheta: 0.5,
    hitCount: 10,
    ...over,
  };
}

function result(over: Partial<LADResultEntry> = {}): LADResultEntry {
  return {
    id: 'lad-1',
    sourceScanIds: ['scan-1'],
    voxels: [voxel()],
    nx: 2, ny: 2, nz: 4,
    bounds: { min: [0, 0, 0], max: [1, 1, 2] },
    gridSize: [1, 1, 2],
    returnMode: 'single',
    visible: true,
    color: '#22c55e',
    hideEmpty: true,
    opacity: 1,
    worldShift: WORLD_SHIFT,
    crsEpsg: 32610,
    ...over,
  };
}

describe('ladWorldOrigin', () => {
  it('adds worldShift back to the stored bounds', () => {
    // Voxel centers and bounds live in the STORED frame because buildLADRequest
    // subtracts the shift on the way in; the export has to undo that.
    expect(ladWorldOrigin(result())).toEqual([412300, 4512100, 0]);
  });

  it('is a no-op for a cloud that kept its original coordinates', () => {
    expect(ladWorldOrigin(result({ worldShift: undefined }))).toEqual([0, 0, 0]);
  });
});

describe('ladCellSize', () => {
  it('divides the grid extents by the subdivisions', () => {
    expect(ladCellSize(result())).toEqual([0.5, 0.5, 0.5]);
  });

  it('falls back to a voxel own size when a legacy result has no gridSize', () => {
    // Cells are uniform within a grid, so any voxel answers for all of them.
    expect(ladCellSize(result({ gridSize: undefined }))).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('rasterBlockedReason', () => {
  it('permits an axis-aligned flat grid', () => {
    expect(rasterBlockedReason(result())).toBeNull();
    expect(rasterBlockedReason(result({ gridRotationDeg: 0, terrainFollow: false }))).toBeNull();
  });

  it('blocks a rotated grid and names a format that works', () => {
    const reason = rasterBlockedReason(result({ gridRotationDeg: 23.5 }));
    expect(reason).toContain('23.5');
    expect(reason).toContain('CSV');
  });

  it('blocks a terrain-following grid', () => {
    const reason = rasterBlockedReason(result({ terrainFollow: true }));
    expect(reason).toContain('terrain');
    expect(reason).toContain('CSV');
  });
});

describe('buildLadExportRequest', () => {
  it('shifts every voxel center from stored into world coordinates', () => {
    const req = buildLadExportRequest(result(), 'csv', ['lad']);
    expect(req.cells[0].center).toEqual([412300.25, 4512100.25, 0.25]);
    expect(req.origin).toEqual([412300, 4512100, 0]);
  });

  it('carries the grid geometry and CRS the backend needs to georeference', () => {
    const req = buildLadExportRequest(result(), 'tif', ['lad', 'gtheta']);
    expect(req.nx).toBe(2);
    expect(req.nz).toBe(4);
    expect(req.cell_size).toEqual([0.5, 0.5, 0.5]);
    expect(req.crs_epsg).toBe(32610);
    expect(req.variables).toEqual(['lad', 'gtheta']);
  });

  it('passes rotation and terrain-follow through so the backend can refuse a raster', () => {
    const req = buildLadExportRequest(
      result({ gridRotationDeg: 23.5, terrainFollow: true }), 'csv', ['lad']);
    expect(req.grid_rotation).toBe(23.5);
    expect(req.terrain_follow).toBe(true);
  });

  it('marks an occluded voxel unsolved and an empty one solved', () => {
    // This is the distinction the whole flag exists for: an occluded voxel must
    // become NoData downstream, never a zero that biases mean LAD and LAI low.
    const req = buildLadExportRequest(result({
      voxels: [
        voxel({ solved: false, lad: 0, leafArea: 0 }),   // occluded
        voxel({ solved: true, lad: 0, leafArea: 0 }),    // genuinely empty air
      ],
    }), 'csv', ['lad']);
    expect(req.cells[0].solved).toBe(false);
    expect(req.cells[1].solved).toBe(true);
  });

  it('treats a legacy voxel with no flag as solved', () => {
    // Absent flag means the result predates it — defaulting to unsolved would
    // silently void an entire grid.
    const req = buildLadExportRequest(result({ voxels: [voxel()] }), 'csv', ['lad']);
    expect(req.cells[0].solved).toBe(true);
  });

  it('maps the optional Pimont fields, using null for absent ones', () => {
    const req = buildLadExportRequest(result({
      voxels: [voxel({ beamCount: 100, ladStd: 0.3, meanPathLength: 0.4 })],
    }), 'csv', ['lad']);
    expect(req.cells[0].beam_count).toBe(100);
    expect(req.cells[0].lad_std).toBe(0.3);
    expect(req.cells[0].mean_path_length).toBe(0.4);
    expect(req.cells[0].relative_density_index).toBeNull();
    expect(req.cells[0].lad_variance).toBeNull();
  });

  it('only sets dest_dir when one was chosen', () => {
    expect(buildLadExportRequest(result(), 'csv', ['lad']).dest_dir).toBeUndefined();
    expect(buildLadExportRequest(result(), 'csv', ['lad'], '/tmp/out').dest_dir).toBe('/tmp/out');
  });
});

describe('LAD_EXPORT_VARIABLES', () => {
  it('leads with lad and names only fields a voxel carries', () => {
    expect(LAD_EXPORT_VARIABLES[0].key).toBe('lad');
    // Every offered key must exist on the wire cell, or the backend rejects it.
    const wireKeys = new Set(Object.keys(
      buildLadExportRequest(result(), 'tif', ['lad']).cells[0]));
    for (const v of LAD_EXPORT_VARIABLES) {
      expect(wireKeys.has(v.key)).toBe(true);
    }
  });
});

describe('base64ToBytes', () => {
  it('round-trips binary bytes', () => {
    const bytes = base64ToBytes(btoa('II*\0'));
    expect(Array.from(bytes)).toEqual([0x49, 0x49, 0x2a, 0x00]);
  });
});
