import { describe, it, expect } from 'vitest';
import {
  formatColorbarTick,
  computeBoundsFromPositions,
  fuzzyMatch,
  generateShapeMesh,
  octreeScalarFieldOptions,
  voxelMeshToHeliosGrid,
  computeMeshTriangleScalars,
  buildMeshTriangleColorBuffers,
  buildMeshScanColorBuffers,
  meshHasScanColors,
  meshColorModeLabel,
} from './pointCloudHelpers';
import type { MeshData } from './pointCloudTypes';

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
