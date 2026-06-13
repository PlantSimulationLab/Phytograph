import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ladColorT, ladRange, buildLADRequest } from './pointCloudHelpers';
import type { LADVoxel, PointCloudData } from './pointCloudTypes';
import type { Scan } from './scan';
import { DEFAULT_SCAN_PARAMETERS } from './scanParameters';
import type { HeliosGrid } from '../utils/backendApi';

describe('ladColorT', () => {
  it('maps min to 0 and max to 1', () => {
    expect(ladColorT(0, 0, 4)).toBe(0);
    expect(ladColorT(4, 0, 4)).toBe(1);
    expect(ladColorT(2, 0, 4)).toBe(0.5);
  });

  it('clamps values outside the domain', () => {
    expect(ladColorT(-1, 0, 4)).toBe(0);
    expect(ladColorT(10, 0, 4)).toBe(1);
  });

  it('returns 0 for a degenerate or non-finite domain', () => {
    expect(ladColorT(5, 3, 3)).toBe(0);       // min == max
    expect(ladColorT(5, 4, 2)).toBe(0);       // max < min
    expect(ladColorT(NaN, 0, 4)).toBe(0);
    expect(ladColorT(2, NaN, 4)).toBe(0);
  });
});

function voxel(lad: number, hitCount: number): LADVoxel {
  return {
    index: 0,
    center: [0, 0, 0],
    size: [1, 1, 1],
    leafArea: lad,
    lad,
    gtheta: 0.5,
    hitCount,
  };
}

describe('ladRange', () => {
  it('ignores empty cells by default', () => {
    const r = ladRange([voxel(2, 10), voxel(0, 0), voxel(5, 3)]);
    expect(r.min).toBe(2);
    expect(r.max).toBe(5);
  });

  it('includes empty cells when asked', () => {
    const r = ladRange([voxel(2, 10), voxel(0, 0)], false);
    expect(r.min).toBe(0);
    expect(r.max).toBe(2);
  });

  it('returns [0,0] when nothing qualifies', () => {
    expect(ladRange([voxel(0, 0)])).toEqual({ min: 0, max: 0 });
    expect(ladRange([])).toEqual({ min: 0, max: 0 });
  });
});

function makeScan(over: Partial<Scan> = {}): Scan {
  const data: PointCloudData = {
    positions: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
    pointCount: 2,
    bounds: {
      min: new THREE.Vector3(),
      max: new THREE.Vector3(),
      center: new THREE.Vector3(),
      size: new THREE.Vector3(),
    },
  };
  return {
    id: 's1',
    label: 'Scan 1',
    visible: true,
    color: '#abcdef',
    data,
    params: { ...DEFAULT_SCAN_PARAMETERS, origin: { x: 1, y: 2, z: 3 } },
    ...over,
  };
}

const GRID: HeliosGrid = { center: [0, 0, 0.5], size: [1, 1, 1], nx: 2, ny: 2, nz: 2 };
const PARAMS = { lmax: 0.05, maxAspectRatio: 8, minVoxelHits: 4 };

describe('buildLADRequest', () => {
  it('carries the grid and algorithm params', () => {
    const req = buildLADRequest([makeScan()], GRID, PARAMS);
    expect(req.grid).toEqual(GRID);
    expect(req.lmax).toBe(0.05);
    expect(req.max_aspect_ratio).toBe(8);
    expect(req.min_voxel_hits).toBe(4);
  });

  it('threads element_width when provided, omits it otherwise', () => {
    expect(buildLADRequest([makeScan()], GRID, PARAMS).element_width).toBeUndefined();
    const withWidth = buildLADRequest([makeScan()], GRID, { ...PARAMS, elementWidth: 0.05 });
    expect(withWidth.element_width).toBe(0.05);
  });

  it('uses the file path when available, omitting inline points', () => {
    const req = buildLADRequest([makeScan({ sourcePath: '/data/a.xyz', asciiFormat: 'x y z' })], GRID, PARAMS);
    const s = req.scans[0];
    expect(s.file_path).toBe('/data/a.xyz');
    expect(s.ascii_format).toBe('x y z');
    expect(s.points).toBeUndefined();
    expect(s.origin).toEqual([1, 2, 3]);
  });

  it('serialises points when there is no file path', () => {
    const req = buildLADRequest([makeScan({ sourcePath: undefined })], GRID, PARAMS);
    const s = req.scans[0];
    expect(s.file_path).toBeUndefined();
    expect(s.points).toHaveLength(2);
    // Float32 round-trip, so compare with tolerance.
    const flat = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    s.points!.flat().forEach((v, i) => expect(v).toBeCloseTo(flat[i], 5));
  });

  it('attaches multi-return beam fields only for multi-return scans', () => {
    const single = buildLADRequest([makeScan()], GRID, PARAMS).scans[0];
    expect(single.return_type).toBe('single');
    expect(single.beam_exit_diameter).toBeUndefined();
    expect(single.beam_divergence).toBeUndefined();

    const multiScan = makeScan({
      params: {
        ...DEFAULT_SCAN_PARAMETERS,
        origin: { x: 0, y: 0, z: 0 },
        returnType: 'multi',
        beamExitDiameterM: 0.02,
        beamDivergenceMrad: 0.7,
      },
    });
    const multi = buildLADRequest([multiScan], GRID, PARAMS).scans[0];
    expect(multi.return_type).toBe('multi');
    expect(multi.beam_exit_diameter).toBe(0.02);
    expect(multi.beam_divergence).toBe(0.7);
  });

  it('sends both session_id and file_path when a cloud has both (fallback)', () => {
    // The backend prefers the session but falls back to the file if the session
    // is gone (e.g. after a backend restart), so we send both.
    const scan = makeScan({ sourcePath: '/data/a.xyz', asciiFormat: 'x y z' });
    scan.data!.octree = {
      cacheId: 'c1',
      sessionId: 'sess-123',
      metadataUrl: '',
      pointCount: 2,
    } as any;
    const s = buildLADRequest([scan], GRID, PARAMS).scans[0];
    expect(s.session_id).toBe('sess-123');
    expect(s.file_path).toBe('/data/a.xyz');
    expect(s.ascii_format).toBe('x y z');
    expect(s.points).toBeUndefined();
  });

  it('sends session_id alone when there is no source file', () => {
    const scan = makeScan({ sourcePath: undefined });
    scan.data!.octree = {
      cacheId: 'c1',
      sessionId: 'sess-xyz',
      metadataUrl: '',
      pointCount: 2,
    } as any;
    const s = buildLADRequest([scan], GRID, PARAMS).scans[0];
    expect(s.session_id).toBe('sess-xyz');
    expect(s.file_path).toBeUndefined();
    expect(s.points).toBeUndefined();
  });

  it('attaches multi-return scalar columns for a synthetic full-waveform cloud', () => {
    // Flat in-memory cloud: no sourcePath, no octree, carries the three
    // per-pulse scalar fields aligned with its 2 points.
    const mkField = (vals: number[]) => ({
      values: new Float32Array(vals),
      min: Math.min(...vals),
      max: Math.max(...vals),
    });
    const scan = makeScan({ sourcePath: undefined });
    scan.data!.scalarFields = {
      timestamp: mkField([1.0, 2.0]),
      target_index: mkField([0, 1]),
      target_count: mkField([1, 3]),
    };
    const s = buildLADRequest([scan], GRID, PARAMS).scans[0];
    expect(s.points).toHaveLength(2);
    expect(s.scalar_columns).toBeDefined();
    expect(s.scalar_columns!.target_count).toEqual([1, 3]);
    expect(s.scalar_columns!.target_index).toEqual([0, 1]);
    expect(s.scalar_columns!.timestamp).toEqual([1, 2]);
  });

  it('omits scalar columns when the per-pulse fields are incomplete', () => {
    const mkField = (vals: number[]) => ({
      values: new Float32Array(vals),
      min: Math.min(...vals),
      max: Math.max(...vals),
    });
    const scan = makeScan({ sourcePath: undefined });
    // Only target_count present — not the full set.
    scan.data!.scalarFields = { target_count: mkField([1, 3]) };
    const s = buildLADRequest([scan], GRID, PARAMS).scans[0];
    expect(s.points).toHaveLength(2);
    expect(s.scalar_columns).toBeUndefined();
  });
});
