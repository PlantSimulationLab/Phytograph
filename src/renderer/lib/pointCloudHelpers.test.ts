import { describe, it, expect } from 'vitest';
import {
  formatColorbarTick,
  computeBoundsFromPositions,
  fuzzyMatch,
  generateShapeMesh,
  octreeScalarFieldOptions,
  assembleScanScalarFields,
  fitGridToBounds,
  voxelMeshToHeliosGrid,
  computeMeshTriangleScalars,
  buildMeshTriangleColorBuffers,
  buildMeshNonIndexedPositions,
  buildMeshTriangleColors,
  buildMeshScanColors,
  buildMeshScanColorBuffers,
  meshHasScanColors,
  meshColorModeLabel,
  roundCoord,
  roundCoord3,
  resampleCloud,
  cloneFlatPointCloudData,
  computeDisplayOffset,
  recenterPositions,
  displayViewToWorldView,
  worldToDisplay,
  displayToWorld,
  buildLADRequest,
  demGridToLADRaster,
  LAD_DEM_NODATA,
  gridSnapSignature,
  gridColumnLocalOffsets,
  triangulationGridEnvelope,
  gridCropBox,
  ladReuseGrid,
  buildHeliosTriangulationRequest,
  resolveHeliosScanSource,
} from './pointCloudHelpers';
import { projectWorldToCanvasPixel } from './cropGeometry';
import type { MeshData, PointCloudData } from './pointCloudTypes';
import type { Scan } from './scan';
import { DEFAULT_SCAN_PARAMETERS } from './scanParameters';
import { parsePoseStreamCsv } from './poseStream';
import type { HeliosGrid } from '../utils/backendApi';
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

// The viewer builds positions and colors separately (positions are cached and
// reused across recolors); these must reproduce exactly what the combined
// buffer builder produces, so the fast path stays bit-identical to the old one.
describe('buildMeshNonIndexedPositions / buildMeshTriangleColors (split builders)', () => {
  const twoTri = () => makeMesh(
    [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
    [0, 1, 2, 1, 3, 2],
  );

  it('positions match the combined builder and are mode-independent', () => {
    const mesh = twoTri();
    const combined = buildMeshTriangleColorBuffers(mesh, 'area', 'viridis')!;
    const positions = buildMeshNonIndexedPositions(mesh);
    expect(Array.from(positions)).toEqual(Array.from(combined.positions));
    // Same positions regardless of which scalar mode the colors use.
    const combinedIncl = buildMeshTriangleColorBuffers(mesh, 'inclination', 'magma')!;
    expect(Array.from(positions)).toEqual(Array.from(combinedIncl.positions));
  });

  it('colors and range match the combined builder', () => {
    const mesh = twoTri();
    const combined = buildMeshTriangleColorBuffers(mesh, 'inclination', 'viridis', { min: 0, max: 90 })!;
    const split = buildMeshTriangleColors(mesh, 'inclination', 'viridis', { min: 0, max: 90 })!;
    expect(Array.from(split.colors)).toEqual(Array.from(combined.colors));
    expect(split.min).toBe(combined.min);
    expect(split.max).toBe(combined.max);
  });

  it('returns null for solid mode', () => {
    const mesh = twoTri();
    expect(buildMeshTriangleColors(mesh, 'solid', 'viridis')).toBeNull();
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

  it('buildMeshScanColors (color-only split) matches the combined builder', () => {
    const mesh = twoScanMesh();
    const combined = buildMeshScanColorBuffers(mesh)!;
    const colors = buildMeshScanColors(mesh)!;
    expect(Array.from(colors)).toEqual(Array.from(combined.colors));
    expect(buildMeshScanColors(makeMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]))).toBeNull();
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

  it('captures a non-zero z-rotation (degrees) as the grid rotation', () => {
    const grid = voxelMeshToHeliosGrid(
      { x: 0, y: 0, z: 0.5 },
      { x: 0.5, y: 0.5, z: 0.5 },
      { x: 2, y: 2, z: 2 },
      45,
    );
    expect(grid!.rotation).toBe(45); // round-trips sphere.xml's <rotation> 45
  });

  it('omits rotation when zero or negligible (axis-aligned grid)', () => {
    expect('rotation' in voxelMeshToHeliosGrid(
      { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, 0)!).toBe(false);
    // No rotation argument behaves like zero.
    expect('rotation' in voxelMeshToHeliosGrid(
      { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 })!).toBe(false);
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

  it('produces a 2-triangle quad for a plane', () => {
    const mesh = generateShapeMesh('plane');
    expect(mesh.triangleCount).toBe(2);
    expect(mesh.vertexCount).toBe(6);
    expect(mesh.indices.length).toBe(6);
    expect(mesh.normals).toBeInstanceOf(Float32Array);
    expect(mesh.vertices.length).toBe(mesh.vertexCount * 3);
    // Every coordinate is finite (no NaN from the geometry extraction).
    expect(Array.from(mesh.vertices).every(Number.isFinite)).toBe(true);
  });

  it('produces non-empty meshes for every shape type', () => {
    for (const shape of ['sphere', 'cylinder', 'cone', 'plane'] as const) {
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

  it('filters out only the geometry/colour/intensity builtins', () => {
    const ranges = {
      position: { min: [0, 0, 0], max: [1, 1, 1] },
      rgb: { min: [0], max: [255] },
      intensity: { min: [0], max: [100] },
      // classification is a real LAS dim the backend now carries as a scalar —
      // it must reach the picker, not get filtered like position/rgb/intensity.
      classification: { min: [0], max: [8] },
      Reflectance_dB: { min: [-20], max: [-5] },
    };
    const opts = octreeScalarFieldOptions(ranges, {});
    expect(opts.map(o => o.value).sort()).toEqual(['Reflectance_dB', 'classification']);
  });

  it('filters the LAS sensor/schema dims PotreeConverter emits, but keeps real scalars', () => {
    // Exact attribute names PotreeConverter writes for a plain XYZ import (the
    // octree-scalar E2E fixture): the LAS standard dims come through degenerate
    // and must not pollute the picker, while the three real columns survive.
    const ranges = {
      position: { min: [0, 0, 0], max: [1, 1, 1] },
      intensity: { min: [0], max: [1] },
      'return number': { min: [0], max: [0] },
      'number of returns': { min: [0], max: [0] },
      classification: { min: [0], max: [0] }, // real LAS dim — KEEP
      'scan angle rank': { min: [0], max: [0] },
      'user data': { min: [0], max: [0] },
      'point source id': { min: [0], max: [0] },
      'gps-time': { min: [0], max: [0] },
      rgb: { min: [0], max: [255] },
      timestamp: { min: [100], max: [247] },
      Deviation: { min: [0], max: [3] },
      target_index: { min: [0], max: [4] },
    };
    const values = octreeScalarFieldOptions(ranges, {}).map(o => o.value);
    // The three real scalars + classification reach the picker.
    expect(values.sort()).toEqual(
      ['Deviation', 'classification', 'target_index', 'timestamp'].sort(),
    );
    // None of the LAS sensor dims leak (mirrors the E2E assertion).
    for (const v of values) {
      const lv = v.toLowerCase();
      expect(lv).not.toContain('gps');
      expect(lv).not.toContain('source id');
      expect(lv).not.toContain('scan angle');
      expect(lv).not.toContain('user data');
    }
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

  it('keeps standard LAS dims (the backend carries them as scalars now)', () => {
    // The backend surfaces non-constant standard LAS dimensions under their
    // native slugs (see _read_las_into_arrays); the picker must show them. Only
    // position/colour/intensity/normal/indices/spacing are still hidden.
    const ranges = {
      position: { min: [0, 0, 0], max: [1, 1, 1] },
      rgb: { min: [0], max: [255] },
      intensity: { min: [0], max: [100] },
      classification: { min: [0], max: [8] },
      point_source_id: { min: [10], max: [12] },
      scan_angle: { min: [-15], max: [15] },
      Timestamp_s: { min: [100], max: [247] },
    };
    const opts = octreeScalarFieldOptions(ranges, { Timestamp_s: 'Timestamp [s]' });
    expect(opts.map(o => o.value).sort()).toEqual(
      ['Timestamp_s', 'classification', 'point_source_id', 'scan_angle'],
    );
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

describe('cloneFlatPointCloudData', () => {
  function makeFlat(): PointCloudData {
    return {
      positions: new Float32Array([0, 0, 0, 1, 1, 1]),
      colors: new Float32Array([1, 0, 0, 0, 1, 0]),
      intensities: new Float32Array([0.2, 0.8]),
      scalarFields: { refl: { values: new Float32Array([3, 4]), min: 3, max: 4 } },
      pointCount: 2,
      bounds: {
        min: new THREE.Vector3(0, 0, 0),
        max: new THREE.Vector3(1, 1, 1),
        center: new THREE.Vector3(0.5, 0.5, 0.5),
        size: new THREE.Vector3(1, 1, 1),
      },
      fileName: 'cloud.xyz',
    };
  }

  it('copies values faithfully', () => {
    const src = makeFlat();
    const copy = cloneFlatPointCloudData(src);
    expect(Array.from(copy.positions)).toEqual(Array.from(src.positions));
    expect(Array.from(copy.colors!)).toEqual(Array.from(src.colors!));
    expect(Array.from(copy.intensities!)).toEqual(Array.from(src.intensities!));
    expect(Array.from(copy.scalarFields!.refl.values)).toEqual([3, 4]);
    expect(copy.pointCount).toBe(2);
    expect(copy.fileName).toBe('cloud.xyz');
  });

  it('uses distinct buffers so mutating the copy never touches the source', () => {
    const src = makeFlat();
    const copy = cloneFlatPointCloudData(src);
    expect(copy.positions).not.toBe(src.positions);
    expect(copy.scalarFields!.refl.values).not.toBe(src.scalarFields!.refl.values);
    copy.positions[0] = 99;
    copy.scalarFields!.refl.values[0] = 99;
    copy.bounds.min.x = 99;
    expect(src.positions[0]).toBe(0);
    expect(src.scalarFields!.refl.values[0]).toBe(3);
    expect(src.bounds.min.x).toBe(0);
  });

  it('omits optional arrays that are absent on the source', () => {
    const src = makeFlat();
    delete src.colors;
    delete src.intensities;
    delete src.scalarFields;
    const copy = cloneFlatPointCloudData(src);
    expect(copy.colors).toBeUndefined();
    expect(copy.intensities).toBeUndefined();
    expect(copy.scalarFields).toBeUndefined();
  });
});

describe('computeDisplayOffset', () => {
  it('returns zero per-axis when the center magnitude is below the threshold', () => {
    expect(computeDisplayOffset({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    expect(computeDisplayOffset({ x: 9999, y: -5000, z: 100 })).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('rounds to the nearest integer for large axes (exact in float)', () => {
    expect(computeDisplayOffset({ x: 545123.6, y: 4183000.4, z: 50 })).toEqual({
      x: 545124,
      y: 4183000,
      z: 0, // below threshold
    });
  });

  it('treats each axis independently and honors a custom threshold', () => {
    expect(computeDisplayOffset({ x: 2e6, y: 3, z: -1.5e6 }, 1e4)).toEqual({
      x: 2000000,
      y: 0,
      z: -1500000,
    });
    expect(computeDisplayOffset({ x: 500, y: 0, z: 0 }, 100)).toEqual({ x: 500, y: 0, z: 0 });
  });

  it('returns zero for non-finite centers (empty/degenerate scenes)', () => {
    expect(computeDisplayOffset({ x: Infinity, y: NaN, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('recenterPositions', () => {
  it('returns the SAME array reference (zero copy) when offset is all-zero', () => {
    const src = new Float32Array([1, 2, 3, 4, 5, 6]);
    const out = recenterPositions(src, 2, { x: 0, y: 0, z: 0 });
    expect(out).toBe(src); // identity — no allocation
  });

  it('subtracts the offset per axis into a fresh array', () => {
    const src = new Float32Array([10, 20, 30, 40, 50, 60]);
    const out = recenterPositions(src, 2, { x: 1, y: 2, z: 3 });
    expect(out).not.toBe(src);
    expect(Array.from(out)).toEqual([9, 18, 27, 39, 48, 57]);
    expect(Array.from(src)).toEqual([10, 20, 30, 40, 50, 60]); // source untouched
  });

  it('recovers full precision when fed a FLOAT64 source (the QSM/skeleton builder path)', () => {
    // The renderer builds QSM/skeleton vertices from float64 JSON node values
    // into a JS number[] before the single float32 cast. Subtracting the offset
    // on those float64 values (then casting once) lands the vertex in float32
    // already small — recovering precision. recenterPositions models that when
    // its input still carries the full-precision value (here we mimic the
    // float64 source by subtracting before the float32 store).
    const trueX = 512345.678901;
    const recenteredF64 = trueX - 512000; // float64 subtraction (what the builder does)
    const stored = new Float32Array([recenteredF64])[0]; // single float32 cast
    const recovered = stored + 512000;
    expect(Math.abs(recovered - trueX)).toBeLessThan(1e-3); // sub-mm
  });

  it('does NOT recover precision already lost in a float32 source (documents the limit)', () => {
    // Flat-cloud positions arrive from the backend ALREADY float32-quantized.
    // Re-centering such an array only fixes the SECONDARY error (a huge
    // modelView translation / depth range), not the primary attribute
    // quantization — the low bits are already gone. This test pins that reality
    // so nobody assumes recenterPositions magically restores a float32 cloud.
    const trueX = 512345.678901;
    const f32src = new Float32Array([trueX, 0, 0]); // precision already lost here
    const out = recenterPositions(f32src, 1, { x: 512000, y: 0, z: 0 });
    const recovered = out[0] + 512000;
    expect(Math.abs(recovered - trueX)).toBeCloseTo(Math.abs(f32src[0] - trueX), 6);
  });
});

describe('worldToDisplay / displayToWorld', () => {
  it('round-trips exactly', () => {
    const offset = { x: 545000, y: 4183000, z: 0 };
    const world = { x: 545123.5, y: 4182990.25, z: 12.75 };
    const display = worldToDisplay(world, offset);
    expect(display).toEqual({ x: 123.5, y: -9.75, z: 12.75 });
    expect(displayToWorld(display, offset)).toEqual(world);
  });
});

describe('displayViewToWorldView', () => {
  // Build a world-space camera looking at a far-off UTM center, then move it
  // into display space (position − offset, target − offset) exactly as the
  // renderer does. The recovered world view matrix must reproject true-world
  // points to the SAME pixels the display camera renders the offset points to.
  const offset = { x: 545000, y: 4183000, z: 0 };
  const worldCenter = new THREE.Vector3(545100, 4183050, 5);

  function makeCameras() {
    const proj = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
    proj.updateProjectionMatrix();

    // World camera: orbiting the true world center.
    const camWorld = proj.clone() as THREE.PerspectiveCamera;
    camWorld.position.set(worldCenter.x + 200, worldCenter.y - 200, worldCenter.z + 150);
    camWorld.up.set(0, 0, 1);
    camWorld.lookAt(worldCenter);
    camWorld.updateMatrixWorld(true);

    // Display camera: same orientation, position shifted by −offset.
    const camDisp = proj.clone() as THREE.PerspectiveCamera;
    camDisp.position.set(
      worldCenter.x + 200 - offset.x,
      worldCenter.y - 200 - offset.y,
      worldCenter.z + 150 - offset.z,
    );
    camDisp.up.set(0, 0, 1);
    camDisp.lookAt(worldCenter.x - offset.x, worldCenter.y - offset.y, worldCenter.z - offset.z);
    camDisp.updateMatrixWorld(true);

    return { proj, camWorld, camDisp };
  }

  it('recovers a world view that reprojects world points to the rendered pixels', () => {
    const { proj, camDisp } = makeCameras();
    const canvas = { width: 1920, height: 1080 };
    const projArr = proj.projectionMatrix.toArray();

    const vWorldRecovered = displayViewToWorldView(camDisp.matrixWorldInverse, offset).toArray();

    // Sample several true-world points around the center.
    const samples = [
      { x: 545100, y: 4183050, z: 5 },
      { x: 545130, y: 4183020, z: 18 },
      { x: 545070, y: 4183090, z: -4 },
    ];
    for (const w of samples) {
      // What the BACKEND will compute with the recovered world view:
      const backendPix = projectWorldToCanvasPixel(w, projArr, vWorldRecovered, canvas);
      // What the user actually SAW: the display camera projecting the offset point.
      const seenPix = projectWorldToCanvasPixel(
        worldToDisplay(w, offset),
        projArr,
        camDisp.matrixWorldInverse.toArray(),
        canvas,
      );
      expect(backendPix).not.toBeNull();
      expect(seenPix).not.toBeNull();
      expect(backendPix!.x).toBeCloseTo(seenPix!.x, 2);
      expect(backendPix!.y).toBeCloseTo(seenPix!.y, 2);
    }
  });

  it('equals the independently-derived world camera view matrix', () => {
    const { camWorld, camDisp } = makeCameras();
    const recovered = displayViewToWorldView(camDisp.matrixWorldInverse, offset).toArray();
    const expected = camWorld.matrixWorldInverse.toArray();
    for (let i = 0; i < 16; i++) expect(recovered[i]).toBeCloseTo(expected[i], 4);
  });

  it('a wrong-sign offset does NOT reproject correctly (locks the sign in)', () => {
    const { proj, camDisp } = makeCameras();
    const canvas = { width: 1920, height: 1080 };
    const projArr = proj.projectionMatrix.toArray();
    // Negate the offset → wrong direction.
    const wrong = displayViewToWorldView(camDisp.matrixWorldInverse, {
      x: -offset.x,
      y: -offset.y,
      z: -offset.z,
    }).toArray();
    const w = { x: 545100, y: 4183050, z: 5 };
    const backendPix = projectWorldToCanvasPixel(w, projArr, wrong, canvas);
    const seenPix = projectWorldToCanvasPixel(
      worldToDisplay(w, offset),
      projArr,
      camDisp.matrixWorldInverse.toArray(),
      canvas,
    );
    // With the wrong sign the reprojection is off by ~2·offset in world →
    // either way it must not match the rendered pixel.
    const matches =
      backendPix != null &&
      seenPix != null &&
      Math.abs(backendPix.x - seenPix.x) < 1 &&
      Math.abs(backendPix.y - seenPix.y) < 1;
    expect(matches).toBe(false);
  });
});

describe('buildLADRequest — moving-platform scans', () => {
  const GRID: HeliosGrid = { center: [0, 0, 0], size: [2, 2, 1], nx: 2, ny: 1, nz: 1 };

  // An inline cloud carrying timestamp + is_miss columns (what a moving scan needs).
  function makeMovingCloud(): PointCloudData {
    const positions = new Float32Array([0, 0, 0, 0.5, 0, 0, 1, 0, 5]);
    return {
      positions,
      colors: new Float32Array(9),
      intensities: null as unknown as Float32Array,
      scalarFields: {
        timestamp: { values: new Float32Array([0, 1, 2]), min: 0, max: 2 },
        is_miss: { values: new Float32Array([0, 0, 1]), min: 0, max: 1 },
      },
      pointCount: 3,
      bounds: {
        min: new THREE.Vector3(0, 0, 0),
        max: new THREE.Vector3(1, 0, 5),
        center: new THREE.Vector3(0.5, 0, 2.5),
        size: new THREE.Vector3(1, 0, 5),
      },
    };
  }

  function makeMovingScan(): Scan {
    const trajectory = parsePoseStreamCsv(
      ['0 0 0 5 0 0 0 1', '1 1 0 5 0 0 0 1', '2 2 0 5 0 0 0 1'].join('\n'),
    );
    return {
      id: 's1',
      label: 'moving',
      visible: true,
      color: '#fff',
      data: makeMovingCloud(),
      params: { ...DEFAULT_SCAN_PARAMETERS, trajectory },
    };
  }

  it('forwards the trajectory (wire shape) and gtheta', () => {
    const req = buildLADRequest([makeMovingScan()], GRID, {
      lmax: 0.1, maxAspectRatio: 4, minVoxelHits: 1, gtheta: 0.42,
    });
    expect(req.gtheta).toBe(0.42);
    const traj = req.scans[0].trajectory as Record<string, unknown>;
    expect(traj).toBeDefined();
    expect(traj).toHaveProperty('source_format', 'pose_csv');
    expect((traj.poses as unknown[]).length).toBe(3);
  });

  it('carries the timestamp + is_miss columns for the inline moving cloud', () => {
    const req = buildLADRequest([makeMovingScan()], GRID, {
      lmax: 0.1, maxAspectRatio: 4, minVoxelHits: 1,
    });
    const cols = req.scans[0].scalar_columns!;
    expect(cols.timestamp).toEqual([0, 1, 2]);
    expect(cols.is_miss).toEqual([0, 0, 1]);
  });

  it('omits trajectory and gtheta for a static scan', () => {
    const scan: Scan = {
      id: 's2', label: 'static', visible: true, color: '#fff',
      data: makeMovingCloud(),
      params: { ...DEFAULT_SCAN_PARAMETERS },  // no trajectory
    };
    const req = buildLADRequest([scan], GRID, {
      lmax: 0.1, maxAspectRatio: 4, minVoxelHits: 1,
    });
    expect(req.scans[0].trajectory).toBeUndefined();
    expect(req.gtheta).toBeUndefined();
  });

  it('omits terrain fields when no DEM is supplied', () => {
    const scan: Scan = {
      id: 's3', label: 'static', visible: true, color: '#fff',
      data: makeMovingCloud(), params: { ...DEFAULT_SCAN_PARAMETERS },
    };
    const req = buildLADRequest([scan], GRID, {
      lmax: 0.1, maxAspectRatio: 4, minVoxelHits: 1,
    });
    expect(req.terrain_follow).toBeUndefined();
    expect(req.dem).toBeUndefined();
  });

  it('sets terrain_follow + dem + safety_fraction when a DEM is supplied', () => {
    const scan: Scan = {
      id: 's4', label: 'static', visible: true, color: '#fff',
      data: makeMovingCloud(), params: { ...DEFAULT_SCAN_PARAMETERS },
    };
    const dem = demGridToLADRaster({
      z: new Float32Array([1, 2, 3, 4]), nx: 2, ny: 2, cellSize: 1,
      origin: [10, 20], worldShift: [100, 200, 0],
    });
    const req = buildLADRequest([scan], GRID, {
      lmax: 0.1, maxAspectRatio: 4, minVoxelHits: 1, dem, safetyFraction: 0.25,
    });
    expect(req.terrain_follow).toBe(true);
    expect(req.safety_fraction).toBe(0.25);
    expect(req.dem).toBe(dem);
  });
});

describe('demGridToLADRaster', () => {
  it('shifts origin to world coords and copies grid shape', () => {
    const raster = demGridToLADRaster({
      z: new Float32Array([1, 2, 3, 4]), nx: 2, ny: 2, cellSize: 0.5,
      origin: [10, 20], worldShift: [100, 200, 7],
    });
    // display origin [10,20] + worldShift [100,200] -> world [110, 220].
    expect(raster.origin).toEqual([110, 220]);
    expect(raster.nx).toBe(2);
    expect(raster.ny).toBe(2);
    expect(raster.cell).toBe(0.5);
    expect(raster.grid_z).toEqual([1, 2, 3, 4]);
  });

  it('encodes NaN voids as the NODATA sentinel', () => {
    const raster = demGridToLADRaster({
      z: new Float32Array([1, NaN, 3, NaN]), nx: 2, ny: 2, cellSize: 1,
      origin: [0, 0], worldShift: [0, 0, 0],
    });
    expect(raster.nodata).toBe(LAD_DEM_NODATA);
    expect(raster.grid_z[1]).toBe(LAD_DEM_NODATA);
    expect(raster.grid_z[3]).toBe(LAD_DEM_NODATA);
    expect(raster.grid_z[0]).toBe(1);
  });
});

describe('voxelMeshToHeliosGrid — ground snap', () => {
  it('rides snap offsets + kept mask into the HeliosGrid', () => {
    const grid = voxelMeshToHeliosGrid(
      { x: 0, y: 0, z: 1 }, { x: 2, y: 2, z: 1 }, { x: 2, y: 1, z: 1 }, 0,
      { columnOffsets: Float32Array.from([0.1, 0.2]), keptMask: Uint8Array.from([1, 0]) },
    );
    expect(grid!.column_offsets![0]).toBeCloseTo(0.1, 5);
    expect(grid!.column_offsets![1]).toBeCloseTo(0.2, 5);
    expect(grid!.kept_columns).toEqual([true, false]);
  });

  it('ignores a snap whose length mismatches nx*ny', () => {
    const grid = voxelMeshToHeliosGrid(
      { x: 0, y: 0, z: 1 }, { x: 2, y: 2, z: 1 }, { x: 2, y: 2, z: 1 }, 0,
      { columnOffsets: Float32Array.from([0.1, 0.2]), keptMask: Uint8Array.from([1, 1]) },
    );
    expect(grid!.column_offsets).toBeUndefined();  // need 4, got 2
  });

  it('omits snap fields for a flat grid', () => {
    const grid = voxelMeshToHeliosGrid(
      { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, 0);
    expect(grid!.column_offsets).toBeUndefined();
    expect(grid!.kept_columns).toBeUndefined();
  });
});

describe('gridSnapSignature', () => {
  it('changes when any transform or subdivision changes', () => {
    const base = gridSnapSignature({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 1 }, 0);
    expect(gridSnapSignature({ x: 0.5, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 1 }, 0)).not.toBe(base);
    expect(gridSnapSignature({ x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 1 }, { x: 2, y: 2, z: 1 }, 0)).not.toBe(base);
    expect(gridSnapSignature({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 3, y: 2, z: 1 }, 0)).not.toBe(base);
    expect(gridSnapSignature({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 1 }, 20)).not.toBe(base);
  });

  it('is stable for identical inputs', () => {
    const a = gridSnapSignature({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, { x: 2, y: 3, z: 4 }, 12.5);
    const b = gridSnapSignature({ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, { x: 2, y: 3, z: 4 }, 12.5);
    expect(a).toBe(b);
  });
});

describe('gridColumnLocalOffsets', () => {
  it('divides world-z offsets by size.z (local-space units)', () => {
    const local = gridColumnLocalOffsets(Float32Array.from([0.5, 1.0, 2.0]), 2);
    expect(Array.from(local)).toEqual([0.25, 0.5, 1.0]);
  });

  it('handles size.z = 0 without dividing by zero', () => {
    const local = gridColumnLocalOffsets(Float32Array.from([1, 2]), 0);
    expect(Array.from(local)).toEqual([0, 0]);
  });
});

describe('triangulationGridEnvelope', () => {
  it('returns a flat grid unchanged (no offsets)', () => {
    const grid = { center: [0, 0, 1] as [number, number, number], size: [2, 2, 1] as [number, number, number], nx: 2, ny: 2, nz: 1 };
    expect(triangulationGridEnvelope(grid)).toBe(grid);
  });

  it('grows the z-extent to bound every displaced column, dropping offsets', () => {
    // center.z=1, size.z=1 => flat box z in [0.5, 1.5]. Offsets [0, 0.5, 1, 2]
    // lift the bottom to [0.5, 2.5] and the top to [1.5, 3.5], so the envelope is
    // z in [0.5+0, 1.5+2] = [0.5, 3.5] -> center.z 2, size.z 3.
    const grid = {
      center: [0, 0, 1] as [number, number, number],
      size: [2, 2, 1] as [number, number, number],
      nx: 2, ny: 2, nz: 1,
      column_offsets: [0, 0.5, 1, 2],
    };
    const env = triangulationGridEnvelope(grid);
    expect(env.column_offsets).toBeUndefined();
    expect(env.center[2]).toBeCloseTo(2, 6);
    expect(env.size[2]).toBeCloseTo(3, 6);
    // x/y untouched.
    expect(env.center[0]).toBe(0);
    expect(env.size[0]).toBe(2);
  });

  it('only bounds KEPT columns', () => {
    const grid = {
      center: [0, 0, 1] as [number, number, number],
      size: [2, 2, 1] as [number, number, number],
      nx: 2, ny: 2, nz: 1,
      column_offsets: [0, 0.5, 1, 99],   // col 3 dropped
      kept_columns: [true, true, true, false],
    };
    const env = triangulationGridEnvelope(grid);
    // max kept offset is 1 -> top = 1.5 + 1 = 2.5, bottom = 0.5 + 0 = 0.5.
    expect(env.center[2]).toBeCloseTo(1.5, 6);
    expect(env.size[2]).toBeCloseTo(2, 6);
  });
});

describe('gridCropBox', () => {
  it('crops a flat grid to its plain center ± size/2', () => {
    const grid = { center: [0, 0, 1] as [number, number, number], size: [2, 2, 1] as [number, number, number], nx: 2, ny: 2, nz: 1 };
    const cb = gridCropBox(grid);
    expect(cb.min).toEqual([-1, -1, 0.5]);
    expect(cb.max).toEqual([1, 1, 1.5]);
    expect(cb.rotationDeg).toBeUndefined();
  });

  it('widens the z-crop to the snapped envelope so the uphill canopy is NOT clipped', () => {
    // This is the ball-pivot regression: the base box is z in [0.5, 1.5], but the
    // columns are lifted up to +2, so the actual canopy reaches z=3.5. Cropping to
    // the base box would discard everything above 1.5 (the clear-cut line + empty
    // uphill voxels). The crop must span [0.5, 3.5].
    const snapped = {
      center: [0, 0, 1] as [number, number, number],
      size: [2, 2, 1] as [number, number, number],
      nx: 2, ny: 2, nz: 1,
      column_offsets: [0, 0.5, 1, 2],
    };
    const cb = gridCropBox(snapped);
    expect(cb.min[2]).toBeCloseTo(0.5, 6);   // base bottom + min offset (0)
    expect(cb.max[2]).toBeCloseTo(3.5, 6);   // base top + max offset (2)
    // x/y crop unchanged by the offsets.
    expect(cb.min[0]).toBe(-1);
    expect(cb.max[0]).toBe(1);
  });

  it('carries the grid azimuthal rotation through', () => {
    const grid = { center: [0, 0, 0] as [number, number, number], size: [2, 2, 2] as [number, number, number], nx: 1, ny: 1, nz: 1, rotation: 30 };
    expect(gridCropBox(grid).rotationDeg).toBe(30);
  });
});

describe('ladReuseGrid', () => {
  // The snapped grid the user dialled in: per-column offsets ride the terrain.
  const snapped = {
    center: [0, 0, 1] as [number, number, number],
    size: [2, 2, 1] as [number, number, number],
    nx: 2, ny: 2, nz: 1,
    column_offsets: [0, 0.5, 1, 2],
    kept_columns: [true, true, true, true],
  };

  it('recovers the snapped grid from the live box, NOT the flat stored grid', () => {
    // A reused Helios mesh stores the FLAT triangulation envelope (offsets gone).
    const stored = triangulationGridEnvelope(snapped);
    expect(stored.column_offsets).toBeUndefined();      // the regression: flat

    // With the source voxel box still in the scene, its live grid carries the
    // current offsets — that's what the inversion must run on so it follows the
    // terrain, exactly like the first new-triangulation run did.
    const chosen = ladReuseGrid(stored, snapped);
    expect(chosen).toBe(snapped);
    expect(chosen.column_offsets).toEqual([0, 0.5, 1, 2]);
  });

  it('falls back to the stored grid when the source box was deleted', () => {
    const stored = triangulationGridEnvelope(snapped);
    expect(ladReuseGrid(stored, null)).toBe(stored);
    expect(ladReuseGrid(stored, undefined)).toBe(stored);
  });

  it('uses the live grid even for a non-snapped box (keeps one source of truth)', () => {
    const stored = { center: [0, 0, 1] as [number, number, number], size: [2, 2, 1] as [number, number, number], nx: 2, ny: 2, nz: 1 };
    const live = { ...stored, nx: 4, ny: 4 };   // user re-subdivided the box
    expect(ladReuseGrid(stored, live)).toBe(live);
  });
});

describe('assembleScanScalarFields', () => {
  const STANDARD = ['intensity', 'distance', 'timestamp', 'target_index', 'target_count'];

  it('keeps a retained CONSTANT standard field (bypasses the variance filter)', () => {
    // timestamp constant across a single static sweep — must still surface.
    const { scalarFields } = assembleScanScalarFields(
      { timestamp: new Float32Array([5, 5, 5]) }, 3, ['timestamp'], STANDARD);
    expect(scalarFields.timestamp).toBeDefined();
    expect(scalarFields.timestamp.min).toBe(5);
    expect(scalarFields.timestamp.max).toBe(5);
  });

  it('prunes an unchecked standard field even when it varies', () => {
    const { scalarFields } = assembleScanScalarFields(
      { target_count: new Float32Array([1, 2, 3]) }, 3, [], STANDARD);
    expect(scalarFields.target_count).toBeUndefined();
  });

  it('pulls intensity out separately and never as a scalar field', () => {
    const intensity = new Float32Array([0.1, 0.9, 0.5]);
    const { scalarFields, intensities } = assembleScanScalarFields(
      { intensity }, 3, ['intensity'], STANDARD);
    expect(intensities).toBe(intensity);
    expect(scalarFields.intensity).toBeUndefined();
  });

  it('drops all-NaN fields', () => {
    const { scalarFields } = assembleScanScalarFields(
      { deviation: new Float32Array([NaN, NaN]) }, 2, ['deviation'], STANDARD);
    expect(scalarFields.deviation).toBeUndefined();
  });

  it('keeps a non-standard (extra) field that resolved, even if constant', () => {
    const { scalarFields } = assembleScanScalarFields(
      { deviation: new Float32Array([0.02, 0.02]) }, 2, ['deviation'], STANDARD);
    expect(scalarFields.deviation).toBeDefined();
  });

  it('falls back to varies-only for a returned field not in the retained set', () => {
    // A varying non-retained field is still shown (legacy rule); a constant one isn't.
    const varying = assembleScanScalarFields(
      { distance: new Float32Array([1, 2, 3]) }, 3, [], STANDARD);
    expect(varying.scalarFields.distance).toBeUndefined(); // standard + unchecked → pruned

    const extraVarying = assembleScanScalarFields(
      { reflectance: new Float32Array([1, 2, 3]) }, 3, [], STANDARD);
    expect(extraVarying.scalarFields.reflectance).toBeDefined(); // non-standard, varies → kept
    const extraConstant = assembleScanScalarFields(
      { reflectance: new Float32Array([2, 2, 2]) }, 3, [], STANDARD);
    expect(extraConstant.scalarFields.reflectance).toBeUndefined(); // non-standard, constant, unretained → dropped
  });

  it('ignores length-mismatched arrays', () => {
    const { scalarFields } = assembleScanScalarFields(
      { timestamp: new Float32Array([1, 2]) }, 3, ['timestamp'], STANDARD);
    expect(scalarFields.timestamp).toBeUndefined();
  });
});

describe('buildHeliosTriangulationRequest / resolveHeliosScanSource', () => {
  const GRID: HeliosGrid = {
    center: [0, 0, 0], size: [4, 4, 4], nx: 2, ny: 2, nz: 3,
  };

  // An octree/session-backed cloud: positions are EMPTY (geometry lives in the
  // backend session), pointCount is the full count. This is the shape that, with
  // a cleared sourcePath, drove the 40 GB pydantic OOM before the fix.
  function octreeCloud(sessionId: string, pointCount = 13_000_000): PointCloudData {
    return {
      positions: new Float32Array(0),
      pointCount,
      bounds: {
        min: new THREE.Vector3(-1, -1, -1),
        max: new THREE.Vector3(1, 1, 1),
        center: new THREE.Vector3(0, 0, 0),
        size: new THREE.Vector3(2, 2, 2),
      },
      fileName: 'scan.xyz',
      octree: { cacheId: 'abc', sourceXyzPath: '/data/scan.xyz', sessionId },
    };
  }

  // A flat in-RAM cloud (e.g. synthetic scan): positions populated, no octree.
  function flatCloud(positions: number[]): PointCloudData {
    return {
      positions: new Float32Array(positions),
      pointCount: positions.length / 3,
      bounds: {
        min: new THREE.Vector3(0, 0, 0),
        max: new THREE.Vector3(1, 1, 1),
        center: new THREE.Vector3(0.5, 0.5, 0.5),
        size: new THREE.Vector3(1, 1, 1),
      },
      fileName: 'synthetic',
    };
  }

  function scanOf(data: PointCloudData | undefined, extra: Partial<Scan> = {}): Scan {
    return {
      id: 's1', label: 'Scan 1', visible: true, color: '#fff',
      params: { ...DEFAULT_SCAN_PARAMETERS },
      ...(data ? { data } : {}),
      ...extra,
    };
  }

  it('sends session_id (NOT serialized points) for a session-backed cloud with a cleared sourcePath', () => {
    // The exact post-Backfill-Misses state: octree cloud, sourcePath dropped by
    // handleUpdateScanData. Must NOT iterate the empty positions × full pointCount.
    const scan = scanOf(octreeCloud('sess-1', 28_000_000), { sourcePath: undefined });
    const req = buildHeliosTriangulationRequest([scan], GRID);
    expect(req.scans[0].session_id).toBe('sess-1');
    expect(req.scans[0].points).toBeUndefined();
    expect(req.scans[0].file_path).toBeUndefined();
    // Sanity: the serialized request is tiny, not hundreds of MB.
    expect(JSON.stringify(req).length).toBeLessThan(2_000);
  });

  it('sends both session_id and file_path when the cloud still has its source path (restart fallback)', () => {
    const scan = scanOf(octreeCloud('sess-2'), { sourcePath: '/data/scan.xyz', asciiFormat: 'x y z' });
    const req = buildHeliosTriangulationRequest([scan], GRID);
    expect(req.scans[0].session_id).toBe('sess-2');
    expect(req.scans[0].file_path).toBe('/data/scan.xyz');
    expect(req.scans[0].points).toBeUndefined();
  });

  it('sends file_path for a file-backed cloud with no session', () => {
    const scan = scanOf(flatCloud([0, 0, 0]), { sourcePath: '/data/scan.xyz', asciiFormat: 'x y z' });
    // flat cloud here only to satisfy hasData; sourcePath wins over inline points.
    const req = buildHeliosTriangulationRequest([scan], GRID);
    expect(req.scans[0].file_path).toBe('/data/scan.xyz');
    expect(req.scans[0].session_id).toBeUndefined();
    expect(req.scans[0].points).toBeUndefined();
  });

  it('serializes inline points only for a flat in-RAM cloud (no session, no file)', () => {
    const scan = scanOf(flatCloud([0, 0, 0, 1, 1, 1]), { sourcePath: undefined });
    const req = buildHeliosTriangulationRequest([scan], GRID);
    expect(req.scans[0].points).toEqual([[0, 0, 0], [1, 1, 1]]);
    expect(req.scans[0].session_id).toBeUndefined();
    expect(req.scans[0].file_path).toBeUndefined();
  });

  it('throws (rather than serializing empty positions) when a cloud has no resolvable source', () => {
    // Octree cloud with NO session and NO sourcePath: positions are empty, so the
    // old code would have looped pointCount times pushing [undefined,…]. Now it errors.
    const data = octreeCloud('x');
    delete data.octree!.sessionId;
    const scan = scanOf(data, { sourcePath: undefined });
    expect(() => buildHeliosTriangulationRequest([scan], GRID)).toThrow(/no triangulation source/);
  });

  it('runs unfiltered (huge lmax/aspect) and attaches the grid', () => {
    const scan = scanOf(octreeCloud('sess-3'), { sourcePath: undefined });
    const req = buildHeliosTriangulationRequest([scan], GRID);
    expect(req.lmax).toBeGreaterThan(1e8);
    expect(req.max_aspect_ratio).toBeGreaterThan(1e8);
    expect(req.grid).toEqual(GRID);
  });

  it('omits the grid when none is supplied (backend auto-fits a bounding box)', () => {
    const scan = scanOf(octreeCloud('sess-4'), { sourcePath: undefined });
    const req = buildHeliosTriangulationRequest([scan], null);
    expect(req.grid).toBeUndefined();
  });

  it('carries each scan its own angular geometry from its params', () => {
    const scan = scanOf(octreeCloud('sess-5'), { sourcePath: undefined });
    scan.params = { ...DEFAULT_SCAN_PARAMETERS, zenithPoints: 3415, azimuthPoints: 8122 };
    const req = buildHeliosTriangulationRequest([scan], GRID);
    expect(req.scans[0].n_theta).toBe(3415);
    expect(req.scans[0].n_phi).toBe(8122);
  });

  it('resolveHeliosScanSource returns false (no mutation of points/file) for an unsourced scan', () => {
    const data = octreeCloud('x');
    delete data.octree!.sessionId;
    const scan = scanOf(data, { sourcePath: undefined });
    const entry = { origin: [0, 0, 0] } as Parameters<typeof resolveHeliosScanSource>[1];
    expect(resolveHeliosScanSource(scan, entry)).toBe(false);
    expect(entry.points).toBeUndefined();
    expect(entry.session_id).toBeUndefined();
  });
});
