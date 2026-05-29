import { describe, it, expect } from 'vitest';
import {
  formatColorbarTick,
  computeBoundsFromPositions,
  fuzzyMatch,
  generateShapeMesh,
} from './pointCloudHelpers';

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
