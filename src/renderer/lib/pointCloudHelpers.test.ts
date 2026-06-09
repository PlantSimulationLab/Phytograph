import { describe, it, expect } from 'vitest';
import {
  formatColorbarTick,
  computeBoundsFromPositions,
  fuzzyMatch,
  generateShapeMesh,
  octreeScalarFieldOptions,
  fitGridToBounds,
  voxelMeshToHeliosGrid,
  computeMeshTriangleScalars,
  buildMeshTriangleColorBuffers,
  buildMeshScanColorBuffers,
  meshHasScanColors,
  meshColorModeLabel,
  roundCoord,
  roundCoord3,
  resampleCloud,
} from './pointCloudHelpers';
import type { MeshData, PointCloudData } from './pointCloudTypes';
import * as THREE from 'three';

// Build a minimal MeshData from a flat vertex list and triangle index list.
function makeMesh(
  vertices: number[],
  indices: number[],
  extra?: Partial<MeshData>,
): MeshData {
  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    vertexCount: vertices.length / 3,
    triangleCount: indices.length / 3,
    ...extra,
  };
}

describe('computeMeshTriangleScalars', () => {
  it('returns null for solid mode', () => {
    const mesh = makeMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    expect(computeMeshTriangleScalars(mesh, 'solid')).toBeNull();
  });

  it('reports 0deg inclination for a horizontal (XY-plane) triangle', () => {
    const mesh = makeMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    const r = computeMeshTriangleScalars(mesh, 'inclination')!;
    expect(r.values[0]).toBeCloseTo(0, 5);
  });

  it('reports 90deg inclination for a vertical triangle', () => {
    // Triangle in the XZ plane → normal points along ±Y → vertical face.
    const mesh = makeMesh([0, 0, 0, 1, 0, 0, 0, 0, 1], [0, 1, 2]);
    const r = computeMeshTriangleScalars(mesh, 'inclination')!;
    expect(r.values[0]).toBeCloseTo(90, 4);
  });

  it('folds up- and down-facing triangles to the same inclination', () => {
    const up = makeMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    const down = makeMesh([0, 0, 0, 0, 1, 0, 1, 0, 0], [0, 1, 2]); // reversed winding
    const a = computeMeshTriangleScalars(up, 'inclination')!.values[0];
    const b = computeMeshTriangleScalars(down, 'inclination')!.values[0];
    expect(a).toBeCloseTo(b, 5);
  });

  it('computes triangle area from the cross product', () => {
    // Right triangle with legs 3 and 4 → area 6.
    const mesh = makeMesh([0, 0, 0, 3, 0, 0, 0, 4, 0], [0, 1, 2]);
    const r = computeMeshTriangleScalars(mesh, 'area')!;
    expect(r.values[0]).toBeCloseTo(6, 5);
    expect(r.min).toBeCloseTo(6, 5);
    expect(r.max).toBeCloseTo(6, 5);
  });

  it('reports azimuth in [0,360) for a tilted face', () => {
    // A face tilted so its normal has a +X horizontal component → azimuth ~0deg.
    // Triangle slightly lifted along +x gives a normal leaning toward +X.
    const mesh = makeMesh([0, 0, 0, 0, 1, 0, 1, 0, 1], [0, 1, 2]);
    const r = computeMeshTriangleScalars(mesh, 'azimuth')!;
    const az = r.values[0];
    expect(Number.isFinite(az)).toBe(true);
    expect(az).toBeGreaterThanOrEqual(0);
    expect(az).toBeLessThan(360);
  });

  it('azimuth is independent of triangle winding (no random 180deg flip)', () => {
    // Same tilted facet, opposite vertex order → opposite raw cross-product
    // normal. Orienting normals to the upper hemisphere must yield the same
    // azimuth, instead of one being 180deg off the other.
    const verts = [0, 0, 0, 0, 1, 0, 1, 0, 1];
    const cw = computeMeshTriangleScalars(makeMesh(verts, [0, 1, 2]), 'azimuth')!.values[0];
    const ccw = computeMeshTriangleScalars(makeMesh(verts, [0, 2, 1]), 'azimuth')!.values[0];
    expect(cw).toBeCloseTo(ccw, 4);
  });

  it('azimuth points along +X for a facet whose oriented normal leans east', () => {
    // A facet whose upward normal has +X horizontal component → bearing 0deg
    // (atan2(0, +x)). Reversing winding must not change it.
    const verts = [0, 0, 0, 0, 1, 0, -1, 0, 1]; // normal leans toward +X when z>=0
    const a = computeMeshTriangleScalars(makeMesh(verts, [0, 1, 2]), 'azimuth')!.values[0];
    const b = computeMeshTriangleScalars(makeMesh(verts, [0, 2, 1]), 'azimuth')!.values[0];
    expect(a).toBeCloseTo(b, 4);
    expect(a).toBeCloseTo(0, 3);
  });
});

describe('computeMeshTriangleScalars — scanner-oriented azimuth', () => {
  // Two facets on the EAST side of a sphere: one on the upper hemisphere
  // (normal (1,0,1), leans up+east) and one on the lower hemisphere (normal
  // (1,0,-1), leans down+east). Both should read the SAME outward azimuth
  // (east, ~0deg) when oriented toward an eastern scanner — that's the fix for
  // the 180deg equator seam. The upper-east facet's normal cross product is
  // (1,0,1); the lower-east facet's is (1,0,-1) (verified by the winding).
  const upperEast = [0, 0, 0, 0, 1, 0, -1, 0, 1];   // n = (1,0,1)
  const lowerEast = [0, 0, 0, 0, 1, 0, 1, 0, 1];    // n = (1,0,-1)

  it('without scan origins, the two hemispheres seam 180deg apart (old fold)', () => {
    const up = computeMeshTriangleScalars(makeMesh(upperEast, [0, 1, 2]), 'azimuth')!.values[0];
    const lo = computeMeshTriangleScalars(makeMesh(lowerEast, [0, 1, 2]), 'azimuth')!.values[0];
    // Upper reads east (~0); lower folds to the upper hemisphere → west (~180).
    expect(up).toBeCloseTo(0, 2);
    expect(lo).toBeCloseTo(180, 2);
  });

  it('with an eastern scanner origin, both hemispheres read the same azimuth', () => {
    // Scanner far to the east (+X): each facet's outward normal is oriented
    // toward it, so both read east (~0deg) — continuous, no seam.
    const origins = new Float32Array([100, 0, 0]); // one scan at +X
    const up = computeMeshTriangleScalars(
      makeMesh(upperEast, [0, 1, 2], {
        triangleScanIds: new Uint32Array([0]), scanOrigins: origins,
      }), 'azimuth')!.values[0];
    const lo = computeMeshTriangleScalars(
      makeMesh(lowerEast, [0, 1, 2], {
        triangleScanIds: new Uint32Array([0]), scanOrigins: origins,
      }), 'azimuth')!.values[0];
    expect(up).toBeCloseTo(0, 2);
    expect(lo).toBeCloseTo(0, 2);
    expect(Math.abs(up - lo)).toBeLessThan(1);
  });

  it('inclination is unaffected by the scanner orientation', () => {
    // |n.z| is orientation-independent: (1,0,±1) both give 45deg.
    const origins = new Float32Array([100, 0, 0]);
    const incl = computeMeshTriangleScalars(
      makeMesh(lowerEast, [0, 1, 2], {
        triangleScanIds: new Uint32Array([0]), scanOrigins: origins,
      }), 'inclination')!.values[0];
    expect(incl).toBeCloseTo(45, 3);
  });
});

describe('buildMeshTriangleColorBuffers', () => {
  it('returns null for solid mode', () => {
    const mesh = makeMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    expect(buildMeshTriangleColorBuffers(mesh, 'solid', 'viridis')).toBeNull();
  });

  it('expands to non-indexed buffers (9 floats per triangle) with one color per face', () => {
    // Two triangles sharing an edge.
    const mesh = makeMesh(
      [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
      [0, 1, 2, 1, 3, 2],
    );
    const out = buildMeshTriangleColorBuffers(mesh, 'area', 'viridis')!;
    expect(out.positions).toHaveLength(2 * 9);
    expect(out.colors).toHaveLength(2 * 9);
    // All three vertices of triangle 0 share one color.
    const c0 = out.colors.slice(0, 3);
    const c1 = out.colors.slice(3, 6);
    const c2 = out.colors.slice(6, 9);
    expect(Array.from(c1)).toEqual(Array.from(c0));
    expect(Array.from(c2)).toEqual(Array.from(c0));
    // First expanded position matches the first vertex of the first triangle.
    expect(out.positions[0]).toBe(0);
    expect(out.positions[3]).toBe(1); // second vertex x
  });

  it('honors a range override for normalization', () => {
    const mesh = makeMesh([0, 0, 0, 3, 0, 0, 0, 4, 0], [0, 1, 2]); // area 6
    const out = buildMeshTriangleColorBuffers(mesh, 'area', 'viridis', { min: 0, max: 12 })!;
    expect(out.min).toBe(0);
    expect(out.max).toBe(12);
  });
});

describe('meshColorModeLabel', () => {
  it('labels each gradient mode and leaves solid blank', () => {
    expect(meshColorModeLabel('inclination')).toMatch(/inclination/i);
    expect(meshColorModeLabel('azimuth')).toMatch(/azimuth/i);
    expect(meshColorModeLabel('area')).toMatch(/area/i);
    expect(meshColorModeLabel('scan')).toMatch(/scan/i);
    expect(meshColorModeLabel('solid')).toBe('');
  });
});

describe('meshHasScanColors / buildMeshScanColorBuffers', () => {
  // Two triangles: triangle 0 from scan 0 (red), triangle 1 from scan 1 (blue).
  const twoScanMesh = () => makeMesh(
    [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
    [0, 1, 2, 1, 3, 2],
    {
      triangleScanIds: new Uint32Array([0, 1]),
      scanColors: ['#ff0000', '#0000ff'],
    },
  );

  it('detects scan provenance only when ids + colors are present and aligned', () => {
    expect(meshHasScanColors(twoScanMesh())).toBe(true);
    expect(meshHasScanColors(makeMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]))).toBe(false);
    // ids present but mismatched length → not usable.
    expect(meshHasScanColors(makeMesh(
      [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2],
      { triangleScanIds: new Uint32Array([0, 1]), scanColors: ['#fff'] },
    ))).toBe(false);
  });

  it('returns null when the mesh has no scan provenance', () => {
    expect(buildMeshScanColorBuffers(makeMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]))).toBeNull();
  });

  it('colors each triangle with its scan color (non-indexed, 9 floats/triangle)', () => {
    const out = buildMeshScanColorBuffers(twoScanMesh())!;
    expect(out.positions).toHaveLength(2 * 9);
    expect(out.colors).toHaveLength(2 * 9);
    // Triangle 0 → red on all three vertices.
    for (let k = 0; k < 3; k++) {
      expect(out.colors[k * 3]).toBeCloseTo(1, 5);     // R
      expect(out.colors[k * 3 + 1]).toBeCloseTo(0, 5); // G
      expect(out.colors[k * 3 + 2]).toBeCloseTo(0, 5); // B
    }
    // Triangle 1 → blue on all three vertices.
    for (let k = 3; k < 6; k++) {
      expect(out.colors[k * 3]).toBeCloseTo(0, 5);
      expect(out.colors[k * 3 + 1]).toBeCloseTo(0, 5);
      expect(out.colors[k * 3 + 2]).toBeCloseTo(1, 5);
    }
  });
});

describe('fitGridToBounds', () => {
  it('returns null for an empty box list', () => {
    expect(fitGridToBounds([])).toBeNull();
  });

  it('returns null when bounds are non-finite', () => {
    expect(fitGridToBounds([{
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    }])).toBeNull();
  });

  it('centers on a single box and pads it by 2% of the largest span', () => {
    // span = max(10, 4, 2) = 10 → eps = 0.2, added on both sides per axis.
    const fit = fitGridToBounds([{
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 4, z: 2 },
    }]);
    expect(fit).not.toBeNull();
    expect(fit!.center).toEqual({ x: 5, y: 2, z: 1 });
    expect(fit!.size.x).toBeCloseTo(10.4, 6);
    expect(fit!.size.y).toBeCloseTo(4.4, 6);
    expect(fit!.size.z).toBeCloseTo(2.4, 6);
  });

  it('takes the union AABB across multiple boxes', () => {
    const fit = fitGridToBounds([
      { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      { min: { x: -2, y: 3, z: -1 }, max: { x: 4, y: 5, z: 0 } },
    ]);
    // union min = (-2, 0, -1), max = (4, 5, 1); span = max(6, 5, 2) = 6 → eps = 0.12
    expect(fit!.center).toEqual({ x: 1, y: 2.5, z: 0 });
    expect(fit!.size.x).toBeCloseTo(6.24, 6);
    expect(fit!.size.y).toBeCloseTo(5.24, 6);
    expect(fit!.size.z).toBeCloseTo(2.24, 6);
  });

  it('floors the buffer at 1 cm for tiny clouds', () => {
    // span = 0.1 → 2% would be 0.002, floored to 0.01 → +0.02 per axis.
    const fit = fitGridToBounds([{
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0.1, y: 0.1, z: 0.1 },
    }]);
    expect(fit!.size.x).toBeCloseTo(0.12, 6);
  });

  it('still produces a non-degenerate box for a single point (zero span)', () => {
    const fit = fitGridToBounds([{
      min: { x: 5, y: 5, z: 5 },
      max: { x: 5, y: 5, z: 5 },
    }]);
    expect(fit!.center).toEqual({ x: 5, y: 5, z: 5 });
    expect(fit!.size.x).toBeCloseTo(0.02, 6); // 2 * 1cm floor
  });
});

describe('voxelMeshToHeliosGrid', () => {
  it('returns null when the mesh has no grid subdivisions (not a voxel box)', () => {
    expect(voxelMeshToHeliosGrid({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, undefined)).toBeNull();
  });

  it('maps a unit-cube voxel box to center=position, size=scale, cells=subdivisions', () => {
    const grid = voxelMeshToHeliosGrid(
      { x: 2, y: -3, z: 0.5 },
      { x: 4, y: 6, z: 1 },
      { x: 2, y: 3, z: 1 },
    );
    expect(grid).toEqual({
      center: [2, -3, 0.5],
      size: [4, 6, 1],
      nx: 2,
      ny: 3,
      nz: 1,
    });
  });

  it('defaults missing position/scale to origin / unit size', () => {
    const grid = voxelMeshToHeliosGrid(undefined, undefined, { x: 1, y: 1, z: 1 });
    expect(grid).toEqual({ center: [0, 0, 0], size: [1, 1, 1], nx: 1, ny: 1, nz: 1 });
  });

  it('rounds and clamps subdivisions to at least one cell per axis', () => {
    const grid = voxelMeshToHeliosGrid(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
      { x: 0, y: 2.6, z: -5 },
    );
    expect(grid).not.toBeNull();
    expect(grid!.nx).toBe(1); // clamped up from 0
    expect(grid!.ny).toBe(3); // rounded from 2.6
    expect(grid!.nz).toBe(1); // clamped up from -5
  });
});

describe('formatColorbarTick', () => {
  it('renders an em-dash for non-finite values', () => {
    expect(formatColorbarTick(NaN)).toBe('—');
    expect(formatColorbarTick(Infinity)).toBe('—');
    expect(formatColorbarTick(-Infinity)).toBe('—');
  });

  it('uses exponential notation for very large magnitudes', () => {
    expect(formatColorbarTick(1e5)).toBe('1.00e+5');
    expect(formatColorbarTick(123456)).toBe('1.23e+5');
  });

  it('uses exponential notation for very small non-zero magnitudes', () => {
    expect(formatColorbarTick(0.0001)).toBe('1.00e-4');
    expect(formatColorbarTick(-0.0005)).toBe('-5.00e-4');
  });

  it('renders zero as plain "0"', () => {
    expect(formatColorbarTick(0)).toBe('0');
  });

  it('rounds mid-range values to at most 3 fraction digits', () => {
    expect(formatColorbarTick(1.23456)).toBe('1.235');
    expect(formatColorbarTick(42)).toBe('42');
  });
});

describe('computeBoundsFromPositions', () => {
  it('computes center and size from interleaved positions', () => {
    // A unit cube spanning (0,0,0)..(2,2,2): 2 of its corners suffice.
    const positions = new Float32Array([0, 0, 0, 2, 2, 2]);
    const { center, size } = computeBoundsFromPositions(positions, 2);
    expect(center.x).toBe(1);
    expect(center.y).toBe(1);
    expect(center.z).toBe(1);
    expect(size.x).toBe(2);
    expect(size.y).toBe(2);
    expect(size.z).toBe(2);
  });

  it('respects the count argument and ignores trailing data', () => {
    const positions = new Float32Array([0, 0, 0, 1, 1, 1, 100, 100, 100]);
    const { center, size } = computeBoundsFromPositions(positions, 2);
    expect(center.x).toBe(0.5);
    expect(size.x).toBe(1);
  });

  it('handles negative coordinates', () => {
    const positions = new Float32Array([-4, -2, -6, 4, 2, 6]);
    const { center, size } = computeBoundsFromPositions(positions, 2);
    expect(center.x).toBe(0);
    expect(center.y).toBe(0);
    expect(center.z).toBe(0);
    expect(size.x).toBe(8);
    expect(size.y).toBe(4);
    expect(size.z).toBe(12);
  });
});

describe('roundCoord', () => {
  it('snaps noisy floating-point values to 3 decimals by default', () => {
    // The exact value the user reported from an auto-suggested origin.
    expect(roundCoord(-0.035371989011764526)).toBe(-0.035);
  });

  it('respects a custom decimal count', () => {
    expect(roundCoord(1.23456, 2)).toBe(1.23);
    expect(roundCoord(1.23456, 0)).toBe(1);
  });

  it('leaves already-clean values untouched', () => {
    expect(roundCoord(0)).toBe(0);
    expect(roundCoord(2.5)).toBe(2.5);
    expect(roundCoord(-1.25, 2)).toBe(-1.25);
  });

  it('coerces non-finite input to 0', () => {
    expect(roundCoord(NaN)).toBe(0);
    expect(roundCoord(Infinity)).toBe(0);
  });
});

describe('roundCoord3', () => {
  it('rounds every axis of an {x,y,z} coordinate', () => {
    expect(
      roundCoord3({ x: -0.035371989, y: 1.0009, z: 12.999999 }),
    ).toEqual({ x: -0.035, y: 1.001, z: 13 });
  });
});

describe('fuzzyMatch', () => {
  it('returns 1 for an empty query', () => {
    expect(fuzzyMatch('', 'anything')).toBe(1);
  });

  it('returns 2 for a case-insensitive substring match', () => {
    expect(fuzzyMatch('skel', 'Extract Skeleton')).toBe(2);
    expect(fuzzyMatch('CROP', 'crop box')).toBe(2);
  });

  it('returns 1 for an in-order subsequence that is not a substring', () => {
    expect(fuzzyMatch('etn', 'Extract Skeleton')).toBe(1);
  });

  it('returns 0 when characters do not all appear in order', () => {
    expect(fuzzyMatch('zzz', 'Extract Skeleton')).toBe(0);
    expect(fuzzyMatch('ne', 'en')).toBe(0);
  });
});

describe('generateShapeMesh', () => {
  it('produces a 12-triangle box for a voxel', () => {
    const mesh = generateShapeMesh('voxel');
    expect(mesh.triangleCount).toBe(12);
    expect(mesh.vertexCount).toBe(36);
    expect(mesh.indices.length).toBe(36);
    // Sequential indices for non-indexed geometry.
    expect(Array.from(mesh.indices.slice(0, 4))).toEqual([0, 1, 2, 3]);
    expect(mesh.normals).toBeInstanceOf(Float32Array);
    expect(mesh.vertices.length).toBe(mesh.vertexCount * 3);
  });

  it('produces non-empty meshes for every shape type', () => {
    for (const shape of ['sphere', 'cylinder', 'cone'] as const) {
      const mesh = generateShapeMesh(shape);
      expect(mesh.vertexCount).toBeGreaterThan(0);
      expect(mesh.triangleCount).toBeGreaterThan(0);
      expect(mesh.vertexCount % 3).toBe(0);
      expect(mesh.indices.length).toBe(mesh.vertexCount);
    }
  });
});

describe('octreeScalarFieldOptions', () => {
  it('returns [] when attributeRanges is undefined', () => {
    expect(octreeScalarFieldOptions(undefined, undefined)).toEqual([]);
  });

  it('filters out builtin LAS/Potree attributes', () => {
    const ranges = {
      position: { min: [0, 0, 0], max: [1, 1, 1] },
      rgb: { min: [0], max: [255] },
      intensity: { min: [0], max: [100] },
      classification: { min: [0], max: [8] },
      Reflectance_dB: { min: [-20], max: [-5] },
    };
    const opts = octreeScalarFieldOptions(ranges, {});
    expect(opts.map(o => o.value)).toEqual(['Reflectance_dB']);
  });

  it('applies labels when present, falls back to slug otherwise', () => {
    const ranges = {
      Reflectance_dB: { min: [-20], max: [-5] },
      Deviation: { min: [0], max: [3] },
    };
    const labels = { Reflectance_dB: 'Reflectance [dB]' };
    const opts = octreeScalarFieldOptions(ranges, labels);
    const byValue = Object.fromEntries(opts.map(o => [o.value, o.label]));
    expect(byValue['Reflectance_dB']).toBe('Reflectance [dB]');
    expect(byValue['Deviation']).toBe('Deviation'); // no label → slug
  });

  it('sorts options by display label', () => {
    const ranges = {
      Timestamp_s: { min: [0], max: [10] },
      Reflectance_dB: { min: [-20], max: [-5] },
    };
    const labels = { Timestamp_s: 'Timestamp [s]', Reflectance_dB: 'Reflectance [dB]' };
    const opts = octreeScalarFieldOptions(ranges, labels);
    // 'Reflectance [dB]' < 'Timestamp [s]'
    expect(opts.map(o => o.label)).toEqual(['Reflectance [dB]', 'Timestamp [s]']);
  });

  it('is case-insensitive when filtering builtins', () => {
    const ranges = {
      RGB: { min: [0], max: [255] },
      Intensity: { min: [0], max: [1] },
      MyScalar: { min: [0], max: [1] },
    };
    const opts = octreeScalarFieldOptions(ranges, {});
    expect(opts.map(o => o.value)).toEqual(['MyScalar']);
  });

  it("filters PotreeConverter's spaced/hyphenated builtin names", () => {
    // PotreeConverter 2.x writes the full LAS schema with these exact names.
    const ranges = {
      'return number': { min: [0], max: [1] },
      'number of returns': { min: [0], max: [1] },
      'scan angle rank': { min: [0], max: [0] },
      'user data': { min: [0], max: [0] },
      'point source id': { min: [0], max: [0] },
      'gps-time': { min: [0], max: [0] },
      Timestamp_s: { min: [100], max: [247] },
    };
    const opts = octreeScalarFieldOptions(ranges, { Timestamp_s: 'Timestamp [s]' });
    expect(opts.map(o => o.value)).toEqual(['Timestamp_s']);
  });
});

describe('resampleCloud', () => {
  // Build a 10-point cloud where every parallel buffer encodes the point index,
  // so we can verify the survivors keep their colors/intensities/scalars aligned.
  function makeCloud(n: number): PointCloudData {
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const intensities = new Float32Array(n);
    const scalar = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = i;
      positions[i * 3 + 1] = i * 2;
      positions[i * 3 + 2] = i * 3;
      colors[i * 3] = i / n;
      colors[i * 3 + 1] = i / n;
      colors[i * 3 + 2] = i / n;
      intensities[i] = i * 10;
      scalar[i] = i * 100;
    }
    return {
      positions,
      colors,
      intensities,
      scalarFields: { height: { values: scalar, min: 0, max: (n - 1) * 100 } },
      pointCount: n,
      bounds: {
        min: new THREE.Vector3(0, 0, 0),
        max: new THREE.Vector3(n - 1, (n - 1) * 2, (n - 1) * 3),
        center: new THREE.Vector3((n - 1) / 2, n - 1, (n - 1) * 1.5),
        size: new THREE.Vector3(n - 1, (n - 1) * 2, (n - 1) * 3),
      },
    };
  }

  it('keeps round(originalCount * fraction) points', () => {
    const out = resampleCloud(makeCloud(10), 0.5, 10);
    expect(out.pointCount).toBe(5);
    expect(out.positions.length).toBe(5 * 3);
    expect(out.colors!.length).toBe(5 * 3);
    expect(out.intensities!.length).toBe(5);
    expect(out.scalarFields!.height.values.length).toBe(5);
  });

  it('keeps at least one point even at a tiny fraction', () => {
    expect(resampleCloud(makeCloud(10), 0.001, 10).pointCount).toBe(1);
  });

  it('keeps the parallel buffers index-aligned for each survivor', () => {
    const out = resampleCloud(makeCloud(10), 0.5, 10);
    // Recover each survivor's original index from its x position, then assert the
    // other buffers carry that same index's values — i.e. no buffer got shuffled
    // independently of the positions.
    for (let i = 0; i < out.pointCount; i++) {
      const idx = out.positions[i * 3]; // x === original index
      expect(out.positions[i * 3 + 1]).toBeCloseTo(idx * 2);
      expect(out.positions[i * 3 + 2]).toBeCloseTo(idx * 3);
      expect(out.intensities![i]).toBeCloseTo(idx * 10);
      expect(out.scalarFields!.height.values[i]).toBeCloseTo(idx * 100);
    }
  });

  it('recomputes scalar-field and spatial bounds from the survivors', () => {
    const out = resampleCloud(makeCloud(10), 1.0, 10);
    // fraction 1.0 keeps every point (in shuffled-then-resorted order), so the
    // bounds must match the full original extents.
    expect(out.pointCount).toBe(10);
    expect(out.bounds.min.x).toBeCloseTo(0);
    expect(out.bounds.max.x).toBeCloseTo(9);
    expect(out.bounds.max.z).toBeCloseTo(27);
    const h = out.scalarFields!.height;
    expect(h.min).toBeCloseTo(0);
    expect(h.max).toBeCloseTo(900);
  });

  it('drops optional buffers when the source lacks them', () => {
    const base = makeCloud(8);
    const out = resampleCloud(
      { ...base, colors: undefined, intensities: undefined, scalarFields: {} },
      0.5,
      8,
    );
    expect(out.pointCount).toBe(4);
    expect(out.colors).toBeUndefined();
    expect(out.intensities).toBeUndefined();
    expect(Object.keys(out.scalarFields!)).toHaveLength(0);
  });

  it('does not mutate the source cloud', () => {
    const src = makeCloud(10);
    const before = src.positions.slice();
    resampleCloud(src, 0.3, 10);
    expect(src.pointCount).toBe(10);
    expect(Array.from(src.positions)).toEqual(Array.from(before));
  });
});
