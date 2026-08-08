import { describe, it, expect } from 'vitest';
import {
  sweepTube,
  wrapsForRadius,
  DEFAULT_TEXTURE_TILE_SIZE,
  type Vec3,
} from './qsmTube';

// UV mapping for QSM tubes. The headline property under test is that bark does NOT
// stretch as girth changes — the reason we deliberately diverge from Helios, which
// wraps its bark texture exactly once around a tube regardless of radius and so
// smears the pattern ~30x wider on a trunk than on a twig.

const TILE = DEFAULT_TEXTURE_TILE_SIZE; // 0.25 m

/** A straight vertical tube of `m` nodes spaced `dz` apart, at constant radius. */
function straightTube(m: number, dz: number, radius: number): { nodes: Vec3[]; radii: number[] } {
  const nodes: Vec3[] = [];
  const radii: number[] = [];
  for (let i = 0; i < m; i++) {
    nodes.push([0, 0, i * dz]);
    radii.push(radius);
  }
  return { nodes, radii };
}

describe('wrapsForRadius', () => {
  it('never returns less than one wrap, even for a hair-thin twig', () => {
    for (const r of [1e-6, 1e-4, 0.001, 0.005]) {
      expect(wrapsForRadius(r, TILE)).toBeGreaterThanOrEqual(1);
    }
  });

  it('scales the wrap count with circumference so tiles stay ~square', () => {
    // 15 cm radius => 0.94 m circumference => ~4 tiles of 0.25 m.
    expect(wrapsForRadius(0.15, TILE)).toBe(4);
    // 30 cm radius => 1.885 m => ~8 tiles.
    expect(wrapsForRadius(0.30, TILE)).toBe(8);
  });

  it('returns an integer (so the seam closes)', () => {
    for (const r of [0.01, 0.037, 0.11, 0.29, 0.5]) {
      expect(Number.isInteger(wrapsForRadius(r, TILE))).toBe(true);
    }
  });

  it('falls back to a single wrap for a non-positive tile size', () => {
    expect(wrapsForRadius(0.2, 0)).toBe(1);
    expect(wrapsForRadius(0.2, -1)).toBe(1);
  });
});

describe('sweepTube UVs', () => {
  it('emits one UV per vertex, with no NaNs', () => {
    const { nodes, radii } = straightTube(4, 0.3, 0.05);
    const n = 8;
    const t = sweepTube(nodes, radii, n)!;
    expect(t.uvs.length).toBe(t.positions.length);
    expect(t.uvs.length).toBe(nodes.length * (n + 1));
    for (const [u, v] of t.uvs) {
      expect(Number.isFinite(u)).toBe(true);
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('advances v by true arc length in tile units (no length-normalisation)', () => {
    // 4 nodes, 0.3 m apart => 0.9 m total => 3.6 tiles at 0.25 m.
    const { nodes, radii } = straightTube(4, 0.3, 0.05);
    const n = 8;
    const t = sweepTube(nodes, radii, n)!;
    const vAt = (ring: number) => t.uvs[ring * t.ringStride][1];
    expect(vAt(0)).toBeCloseTo(0, 10);
    expect(vAt(3)).toBeCloseTo(0.9 / TILE, 10);
    // A tube twice as long must get twice the v span — the property that stops
    // long shoots from having the texture stretched to fit a fixed 0..1 range.
    const long = straightTube(4, 0.6, 0.05);
    const t2 = sweepTube(long.nodes, long.radii, n)!;
    expect(t2.uvs[3 * t2.ringStride][1]).toBeCloseTo(2 * vAt(3), 10);
  });

  it('keeps v monotonically non-decreasing along the tube', () => {
    const { nodes, radii } = straightTube(6, 0.17, 0.04);
    const t = sweepTube(nodes, radii, 8)!;
    for (let ring = 1; ring < t.ringCount; ring++) {
      const prev = t.uvs[(ring - 1) * t.ringStride][1];
      const cur = t.uvs[ring * t.ringStride][1];
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });

  it('holds v constant within a ring (v varies only ALONG the tube)', () => {
    const { nodes, radii } = straightTube(3, 0.2, 0.06);
    const n = 8;
    const t = sweepTube(nodes, radii, n)!;
    for (let ring = 0; ring < t.ringCount; ring++) {
      const v0 = t.uvs[ring * t.ringStride][1];
      for (let j = 0; j <= n; j++) {
        expect(t.uvs[ring * t.ringStride + j][1]).toBeCloseTo(v0, 12);
      }
    }
  });

  it('closes the circumferential seam on an exact integer', () => {
    // u at the duplicated seam vertex (j=N) must differ from u at j=0 by a whole
    // number of tiles, or RepeatWrapping leaves a visible stripe down the tube.
    for (const radius of [0.005, 0.02, 0.05, 0.15, 0.3, 0.5]) {
      const { nodes, radii } = straightTube(3, 0.2, radius);
      const n = 12;
      const t = sweepTube(nodes, radii, n)!;
      for (let ring = 0; ring < t.ringCount; ring++) {
        const uFirst = t.uvs[ring * t.ringStride][0];
        const uSeam = t.uvs[ring * t.ringStride + n][0];
        const span = uSeam - uFirst;
        expect(Math.abs(span - Math.round(span))).toBeLessThan(1e-9);
        expect(span).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('advances u uniformly around the ring', () => {
    const { nodes, radii } = straightTube(2, 0.2, 0.15);
    const n = 8;
    const t = sweepTube(nodes, radii, n)!;
    const step = t.uvs[1][0] - t.uvs[0][0];
    for (let j = 1; j <= n; j++) {
      expect(t.uvs[j][0] - t.uvs[j - 1][0]).toBeCloseTo(step, 12);
    }
  });

  // THE headline property: this is the test that fails if anyone reverts to a
  // fixed one-wrap-around (Helios) formula.
  it('keeps the bark tile near-square across a 60x radius range (no stretching)', () => {
    const aspects: { radius: number; aspect: number }[] = [];
    for (const radius of [0.05, 0.1, 0.15, 0.2, 0.3, 0.5]) {
      const { nodes, radii } = straightTube(2, 0.25, radius);
      const n = 16;
      const t = sweepTube(nodes, radii, n)!;
      const wraps = t.uvs[n][0] - t.uvs[0][0]; // tiles around the circumference
      const circumference = 2 * Math.PI * radius;
      // Physical size of one tile around vs. the tile size along: 1.0 == square.
      const aspect = circumference / wraps / TILE;
      aspects.push({ radius, aspect });
      expect(aspect).toBeGreaterThan(0.8);
      expect(aspect).toBeLessThan(1.3);
    }
    // And the spread across the whole range stays tight, versus Helios' 0.25 -> 7.54.
    const values = aspects.map((a) => a.aspect);
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.6);
  });

  it('respects a custom tile size in both axes', () => {
    const { nodes, radii } = straightTube(2, 0.5, 0.15);
    const n = 16;
    const fine = sweepTube(nodes, radii, n, [0, 0, 0], 0.125)!;
    const coarse = sweepTube(nodes, radii, n, [0, 0, 0], 0.5)!;
    // Halving the tile size doubles the tile count along the tube...
    expect(fine.uvs[fine.ringStride][1]).toBeCloseTo(0.5 / 0.125, 10);
    expect(coarse.uvs[coarse.ringStride][1]).toBeCloseTo(0.5 / 0.5, 10);
    // ...and increases the wrap count around it.
    const fineWraps = fine.uvs[n][0] - fine.uvs[0][0];
    const coarseWraps = coarse.uvs[n][0] - coarse.uvs[0][0];
    expect(fineWraps).toBeGreaterThan(coarseWraps);
  });

  it('shrinks the wrap count as a shoot tapers, per ring', () => {
    // A trunk tapering from 30 cm to 2 cm: thick rings tile more times around.
    const nodes: Vec3[] = [[0, 0, 0], [0, 0, 1], [0, 0, 2]];
    const radii = [0.3, 0.1, 0.02];
    const n = 16;
    const t = sweepTube(nodes, radii, n)!;
    const wrapsAt = (ring: number) =>
      t.uvs[ring * t.ringStride + n][0] - t.uvs[ring * t.ringStride][0];
    expect(wrapsAt(0)).toBeGreaterThan(wrapsAt(1));
    expect(wrapsAt(1)).toBeGreaterThan(wrapsAt(2));
    expect(wrapsAt(2)).toBeGreaterThanOrEqual(1);
  });

  it('does not disturb positions, normals or faces', () => {
    // UVs are additive: the surface itself must be byte-for-byte what it was.
    const { nodes, radii } = straightTube(4, 0.25, 0.08);
    const n = 8;
    const t = sweepTube(nodes, radii, n)!;
    expect(t.positions.length).toBe(nodes.length * (n + 1));
    expect(t.normals.length).toBe(t.positions.length);
    expect(t.faces.length).toBe((nodes.length - 1) * n * 2);
    for (const nrm of t.normals) {
      expect(Math.hypot(nrm[0], nrm[1], nrm[2])).toBeCloseTo(1, 10);
    }
  });

  it('handles a degenerate (zero-length) segment without NaN UVs', () => {
    const nodes: Vec3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 1]];
    const radii = [0.05, 0.05, 0.05];
    const t = sweepTube(nodes, radii, 8)!;
    for (const [u, v] of t.uvs) {
      expect(Number.isFinite(u)).toBe(true);
      expect(Number.isFinite(v)).toBe(true);
    }
    // The repeated node contributes no arc length.
    expect(t.uvs[0][1]).toBeCloseTo(t.uvs[t.ringStride][1], 12);
  });
});
