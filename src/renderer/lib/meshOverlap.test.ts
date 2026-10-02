import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import { mergeMeshData } from './meshMerge';
import { analyzeMeshOverlap, matchOverlapColors } from './meshOverlap';
import type { MeshData, PlantMaterialDef } from './pointCloudTypes';

const IDENTITY = new THREE.Matrix4();

// A flat sheet in z = `z`, x from x0 to x1 and y from 0 to `ny`, on a unit
// grid, facing +z (or -z when `flip`). `shade(x, y)` gives each vertex a gray.
function sheet(x0: number, x1: number, opts: {
  z?: number; ny?: number; flip?: boolean; shade?: (x: number, y: number) => number | [number, number, number];
} = {}): MeshData {
  const { z = 0, ny = 6, flip = false, shade } = opts;
  const nx = x1 - x0;
  const vertices: number[] = [], colors: number[] = [], indices: number[] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      vertices.push(x0 + i, j, z);
      if (shade) {
        const s = shade(x0 + i, j);
        colors.push(...(Array.isArray(s) ? s : [s, s, s]));
      }
    }
  }
  const at = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const quad = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1)];
      indices.push(...(flip ? [quad[0], quad[2], quad[1], quad[3], quad[5], quad[4]] : quad));
    }
  }
  return {
    vertices: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    ...(shade ? { vertexColors: new Float32Array(colors) } : {}),
    vertexCount: vertices.length / 3,
    triangleCount: indices.length / 3,
  };
}

const part = (data: MeshData, color = '#808080') => ({ data, matrix: IDENTITY, color });

// Merged vertices by position → the red values found there (one per surface).
function redsByPosition(data: MeshData): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (let v = 0; v < data.vertexCount; v++) {
    const key = `${data.vertices[v * 3]},${data.vertices[v * 3 + 1]}`;
    out.set(key, [...(out.get(key) ?? []), data.vertexColors![v * 3]]);
  }
  return out;
}

// Two scans of one flat surface: A covers x 0..12, B covers x 6..18, so they
// share x 6..12. B was lit at half A's brightness.
const A = () => sheet(0, 12, { shade: () => 0.6 });
const B = () => sheet(6, 18, { shade: () => 0.3 });

describe('analyzeMeshOverlap', () => {
  it('finds exactly the shared band, from both sides', () => {
    // Columns x = 6..12 (7 of them) × 7 rows, on each mesh.
    expect(analyzeMeshOverlap([A(), B()], undefined, 1).overlapVertices).toBe(2 * 7 * 7);
    // Grown, each mesh also pairs the few columns just past the other's border
    // with that border — which has the lowest weight, so it changes nothing.
    const grown = analyzeMeshOverlap([A(), B()]);
    expect(grown.overlapVertices).toBe(2 * 10 * 7);   // x = 3..5, within the grown reach of 3
    for (let w = 0; w < grown.parts[0].weldCount; w++) {
      const u = grown.match[0][1]![w];
      if (u >= 0 && grown.parts[0].positions[w * 3] < 6) expect(grown.parts[1].positions[u * 3]).toBe(6);
    }
  });

  it('grows the overlap into a flap that peels away from the shared surface', () => {
    // B lies on A at x = 6 and lifts steadily to 2.4 above it at x = 12: far
    // more than the overlap distance (0.75) at its outer end, but attached to
    // surface that does agree.
    const peel = (): MeshData => {
      const d = sheet(6, 18);
      for (let v = 0; v < d.vertexCount; v++) d.vertices[v * 3 + 2] = 0.4 * Math.max(0, 12 - d.vertices[v * 3]);
      return d;
    };
    const lifted = (o: ReturnType<typeof analyzeMeshOverlap>) => {
      let n = 0;
      for (let w = 0; w < o.parts[1].weldCount; w++) if (o.match[1][0]![w] >= 0 && o.parts[1].positions[w * 3 + 2] > 0.75) n++;
      return n;
    };
    expect(lifted(analyzeMeshOverlap([A(), peel()], 0.75, 1))).toBe(0);
    // z = 0.8 … 2.4 at x = 10 … 6: all five columns of the flap, 7 rows each.
    expect(lifted(analyzeMeshOverlap([A(), peel()], 0.75))).toBe(5 * 7);
  });

  it('never grows an overlap between surfaces that agree nowhere', () => {
    // Parallel, 2 apart: inside the grown reach (3), but with nothing to grow from.
    expect(analyzeMeshOverlap([A(), sheet(6, 18, { z: 2 })], 0.75).overlapVertices).toBe(0);
  });

  it('finds none between meshes that are apart', () => {
    expect(analyzeMeshOverlap([A(), sheet(20, 30)]).overlapVertices).toBe(0);
    expect(analyzeMeshOverlap([A(), sheet(6, 18, { z: 5 })]).overlapVertices).toBe(0);
  });

  it('does not pair surfaces that face opposite ways (the two sides of a thin leaf)', () => {
    expect(analyzeMeshOverlap([A(), sheet(6, 18, { z: 0.01, flip: true })]).overlapVertices).toBe(0);
    expect(analyzeMeshOverlap([A(), sheet(6, 18, { z: 0.01 })], undefined, 1).overlapVertices).toBe(2 * 7 * 7);
  });

  it('reads a triangle-soup mesh by its welded surface, not as all border', () => {
    // The same sheet with every triangle given its own three vertices.
    const soup = (d: MeshData): MeshData => {
      const vertices = new Float32Array(d.triangleCount * 9);
      for (let k = 0; k < d.triangleCount * 3; k++) vertices.set(d.vertices.subarray(d.indices[k] * 3, d.indices[k] * 3 + 3), k * 3);
      return { vertices, indices: Uint32Array.from({ length: d.triangleCount * 3 }, (_, k) => k), vertexCount: d.triangleCount * 3, triangleCount: d.triangleCount };
    };
    const indexed = analyzeMeshOverlap([sheet(0, 12), sheet(6, 18)]);
    const souped = analyzeMeshOverlap([soup(sheet(0, 12)), soup(sheet(6, 18))]);
    expect(souped.overlapVertices).toBe(indexed.overlapVertices);
    expect(Array.from(souped.parts[0].weight).sort()).toEqual(Array.from(indexed.parts[0].weight).sort());
  });

  it('widens the overlap distance to the gap registration left between two scans', () => {
    // The same surface, but B sits 1.2 units (more than an edge) off A — off the
    // grid in x and y, and lifted in z — as two registered scans do. The
    // edge-based distance alone (0.75) pairs nothing here.
    const shifted = sheet(6, 18, { ny: 12 });
    for (let v = 0; v < shifted.vertexCount; v++) {
      shifted.vertices[v * 3] += 0.5; shifted.vertices[v * 3 + 1] += 0.5; shifted.vertices[v * 3 + 2] += 1.2;
    }
    const a = sheet(0, 12, { ny: 12 });
    expect(analyzeMeshOverlap([a, shifted], 0.75).overlapVertices).toBe(0);
    const overlap = analyzeMeshOverlap([a, shifted]);
    expect(overlap.tolerance).toBeGreaterThan(1.39);   // the nearest partner is sqrt(0.5² + 0.5² + 1.2²) = 1.39 away
    // All of A's shared band (x 7..12, 13 rows) is paired.
    let paired = 0;
    for (let w = 0; w < overlap.parts[0].weldCount; w++) {
      if (overlap.match[0][1]![w] >= 0 && overlap.parts[0].positions[w * 3] >= 7) paired++;
    }
    expect(paired).toBe(6 * 13);
  });
});

describe('matchOverlapColors', () => {
  it('solves one gain per mesh that meets in the middle, with no reference mesh', () => {
    const parts = [A(), B()];
    const { gains } = matchOverlapColors(parts, analyzeMeshOverlap(parts), [true, true]);
    // 0.6 vs 0.3 is a factor of 2: A comes down by ~sqrt(2), B goes up by ~sqrt(2).
    expect(gains[0][0]).toBeCloseTo(Math.SQRT1_2, 1);
    expect(gains[1][0]).toBeCloseTo(Math.SQRT2, 1);
    expect(gains[0][0] * 0.6).toBeCloseTo(gains[1][0] * 0.3, 2);
  });

  it('solves the gain per channel, so a white-balance difference is removed too', () => {
    const parts = [sheet(0, 12, { shade: () => [0.5, 0.5, 0.5] }), sheet(6, 18, { shade: () => [0.5, 0.25, 0.5] })];
    const { gains } = matchOverlapColors(parts, analyzeMeshOverlap(parts), [true, true]);
    expect(gains[0][0]).toBeCloseTo(1, 5);
    expect(gains[1][0]).toBeCloseTo(1, 5);
    expect(gains[1][1] / gains[0][1]).toBeCloseTo(2, 1);
  });

  it('leaves alone a part that is not flagged as colored', () => {
    const parts = [A(), B()];
    const { colors, gains } = matchOverlapColors(parts, analyzeMeshOverlap(parts), [true, false]);
    expect(colors[1]).toBeNull();
    expect(gains).toEqual([[1, 1, 1], [1, 1, 1]]);
    expect(Array.from(colors[0]!)).toEqual(Array.from(parts[0].vertexColors!));
  });
});

describe('mergeMeshData overlap options', () => {
  it('changes nothing unless asked', () => {
    const { data, overlap } = mergeMeshData([part(A()), part(B())]);
    expect(overlap).toBeUndefined();
    expect(data.triangleCount).toBe(2 * 144);
    expect(Math.fround(0.6)).toBe(data.vertexColors![0]);
    expect(Math.fround(0.3)).toBe(data.vertexColors![data.vertexCount * 3 - 1]);
  });

  it('matchColors brings the two surfaces to one color wherever both exist', () => {
    const { data, overlap } = mergeMeshData([part(A()), part(B())], { matchColors: true });
    expect(overlap).toEqual({ tolerance: 0.75, overlapVertices: 140, colorMatchedParts: 2, removedTriangles: 0 });
    expect(data.triangleCount).toBe(2 * 144);
    let doubled = 0;
    for (const reds of redsByPosition(data).values()) {
      if (reds.length < 2) continue;
      doubled++;
      expect(Math.abs(reds[0] - reds[1])).toBeLessThan(0.01);   // was 0.3 apart
    }
    expect(doubled).toBe(49);
  });

  it('matchColors removes a spatially varying lighting difference, which one gain cannot', () => {
    // B is lit by a gradient along y relative to A: same at y = 0, 40 % darker at y = 6.
    const a = sheet(0, 12, { shade: () => 0.5 });
    const b = sheet(6, 18, { shade: (_x, y) => 0.5 * (1 - 0.4 * y / 6) });
    const { data } = mergeMeshData([part(a), part(b)], { matchColors: true });
    let worst = 0;
    for (const reds of redsByPosition(data).values()) {
      if (reds.length === 2) worst = Math.max(worst, Math.abs(reds[0] - reds[1]));
    }
    // Unblended (gain only) the two would still differ by ~0.1 at the ends.
    expect(worst).toBeLessThan(0.03);
  });

  it('matchColors fades each mesh out toward its own border, leaving no step', () => {
    // B darkens along y relative to A, so one gain cannot line them up at y = 5:
    // without the blend, each mesh's border there is a step of ~0.075 (blended: ~0.04).
    const a = sheet(0, 12, { shade: () => 0.5 });
    const b = sheet(6, 18, { shade: (_x, y) => 0.5 * (1 - 0.4 * y / 6) });
    const { data } = mergeMeshData([part(a), part(b)], { matchColors: true });
    // Walk the row across the whole merged span, x = 0..18, on every surface.
    const reds = redsByPosition(data);
    let worst = 0;
    for (let x = 1; x <= 18; x++) {
      for (const here of reds.get(`${x},5`)!) for (const before of reds.get(`${x - 1},5`)!) worst = Math.max(worst, Math.abs(here - before));
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('matchColors keeps each mesh\'s own detail rather than averaging it away', () => {
    // A carries a checker pattern; B is flat. After matching, A's checker contrast survives.
    const a = sheet(0, 12, { shade: (x, y) => ((x + y) % 2 ? 0.6 : 0.4) });
    const b = sheet(6, 18, { shade: () => 0.5 });
    const { data } = mergeMeshData([part(a), part(b)], { matchColors: true });
    const red = (x: number, y: number) => data.vertexColors![(y * 13 + x) * 3];
    expect(Math.abs(red(8, 3) - red(9, 3))).toBeGreaterThan(0.17);   // 0.2 before; ~0.1 if blended per vertex
  });

  it('matchColors ignores solid-colored parts: a different object is not a lighting difference', () => {
    const { data, overlap } = mergeMeshData([part(A()), part(sheet(6, 18), '#0000ff')], { matchColors: true });
    expect(overlap!.overlapVertices).toBe(140);
    expect(overlap!.colorMatchedParts).toBe(0);
    for (let v = 0; v < 91; v++) expect(data.vertexColors![v * 3]).toBe(Math.fround(0.6));
    expect(Array.from(data.vertexColors!.subarray(91 * 3, 91 * 3 + 3))).toEqual([0, 0, 1]);
  });

  it('removeOverlap keeps one copy of the shared surface and still covers everything', () => {
    const { data, overlap } = mergeMeshData([part(A()), part(B())], { removeOverlap: true });
    // Union is 18 × 6 unit quads = 216 triangles; a plain merge has 288. Trimming
    // leaves a strip about one quad wide doubled along the seam, and no gap.
    expect(overlap!.removedTriangles).toBe(288 - data.triangleCount);
    expect(data.triangleCount).toBeGreaterThanOrEqual(216);
    expect(data.triangleCount).toBeLessThanOrEqual(216 + 2 * 12);
    const covered = new Set<string>();
    for (let t = 0; t < data.triangleCount; t++) {
      const [a, b, c] = [0, 1, 2].map(e => data.indices[t * 3 + e]);
      const x = Math.min(data.vertices[a * 3], data.vertices[b * 3], data.vertices[c * 3]);
      const y = Math.min(data.vertices[a * 3 + 1], data.vertices[b * 3 + 1], data.vertices[c * 3 + 1]);
      covered.add(`${x},${y}`);
    }
    expect(covered.size).toBe(18 * 6);
    // No vertex is left that no triangle uses, and every index is in range.
    expect(new Set(data.indices).size).toBe(data.vertexCount);
    expect(Math.max(...data.indices)).toBe(data.vertexCount - 1);
    expect(data.vertexColors!.length).toBe(data.vertexCount * 3);
  });

  it('removeOverlap draws the two surfaces together, so the cut leaves no overhang', () => {
    // B is the same surface as A but sits 0.3 above it, as a registered scan does.
    const { data } = mergeMeshData([part(A()), part(sheet(6, 18, { z: 0.3, shade: () => 0.3 }))], { removeOverlap: true });
    const z = new Map<string, number[]>();
    for (let v = 0; v < data.vertexCount; v++) {
      const key = `${data.vertices[v * 3]},${data.vertices[v * 3 + 1]}`;
      z.set(key, [...(z.get(key) ?? []), data.vertices[v * 3 + 2]]);
    }
    // Where both surfaces survive (the seam strip) they now coincide; unmoved
    // they would be 0.3 apart there.
    let doubled = 0;
    for (const zs of z.values()) {
      if (zs.length < 2) continue;
      doubled++;
      expect(Math.abs(zs[0] - zs[1])).toBeLessThan(0.05);
    }
    expect(doubled).toBeGreaterThan(0);
    // Height changes gradually across the merged span, from A's 0 to B's 0.3 …
    let worst = 0;
    for (let x = 1; x <= 18; x++) {
      for (const here of z.get(`${x},3`)!) for (const before of z.get(`${x - 1},3`)!) worst = Math.max(worst, Math.abs(here - before));
    }
    expect(worst).toBeLessThan(0.1);
    // … and away from the overlap neither mesh moved.
    expect(z.get('0,3')).toEqual([0]);
    expect(z.get('18,3')).toEqual([Math.fround(0.3)]);
    // x and y never move: the pull is along the normal only.
    expect(z.size).toBe(19 * 7);
  });

  it('removeOverlap drops a patch that lies wholly inside a larger mesh, and keeps colors aligned', () => {
    const big = sheet(0, 12, { ny: 12, shade: () => 0.6 });
    const patch = sheet(4, 8, { ny: 4, shade: () => 0.3 });
    const { data } = mergeMeshData([part(big), part(patch)], { removeOverlap: true });
    expect(data.triangleCount).toBeLessThan(big.triangleCount + patch.triangleCount);
    // Every surviving vertex still carries the color it had at that position.
    for (let v = 0; v < data.vertexCount; v++) {
      expect([Math.fround(0.6), Math.fround(0.3)]).toContain(data.vertexColors![v * 3]);
    }
  });

  it('removeOverlap leaves back-to-back and non-overlapping meshes untouched', () => {
    const back = mergeMeshData([part(A()), part(sheet(6, 18, { z: 0.01, flip: true, shade: () => 0.3 }))], { removeOverlap: true });
    expect(back.overlap).toEqual({ tolerance: 0.75, overlapVertices: 0, colorMatchedParts: 0, removedTriangles: 0 });
    expect(back.data.triangleCount).toBe(288);
    const apart = mergeMeshData([part(A()), part(sheet(20, 30, { shade: () => 0.3 }))], { removeOverlap: true });
    expect(apart.data.triangleCount).toBe(144 + 120);
  });

  it('removeOverlap renumbers a textured mesh\'s material triangles and keeps it triangle-expanded', () => {
    const expand = (d: MeshData): MeshData => {
      const n = d.triangleCount * 3;
      const vertices = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) vertices.set(d.vertices.subarray(d.indices[k] * 3, d.indices[k] * 3 + 3), k * 3);
      return { vertices, indices: Uint32Array.from({ length: n }, (_, k) => k), uvCoordinates: new Float32Array(n * 2), vertexCount: n, triangleCount: d.triangleCount };
    };
    const material = (name: string, count: number): PlantMaterialDef =>
      ({ name, textureData: 'AAAA', hasAlpha: false, triangleIndices: Array.from({ length: count }, (_, t) => t) });
    const { data, materials } = mergeMeshData([
      { ...part(expand(sheet(0, 12))), materials: [material('a', 144)] },
      { ...part(expand(sheet(6, 18))), materials: [material('b', 144)] },
    ], { removeOverlap: true });
    expect(data.triangleCount).toBeLessThan(288);
    expect(data.vertexCount).toBe(data.triangleCount * 3);
    expect(Array.from(data.indices)).toEqual(Array.from({ length: data.vertexCount }, (_, k) => k));
    expect(data.uvCoordinates!.length).toBe(data.vertexCount * 2);
    const all = materials!.flatMap(m => m.triangleIndices);
    expect(all.slice().sort((p, q) => p - q)).toEqual(Array.from({ length: data.triangleCount }, (_, t) => t));
  });

  it('both options together: one surface left, and it is continuous in color', () => {
    const { data, overlap } = mergeMeshData([part(A()), part(B())], { matchColors: true, removeOverlap: true });
    expect(overlap!.colorMatchedParts).toBe(2);
    expect(overlap!.removedTriangles).toBeGreaterThan(40);
    const reds = redsByPosition(data);
    const row = Array.from({ length: 19 }, (_, x) => reds.get(`${x},3`)![0]);
    for (let x = 1; x < row.length; x++) expect(Math.abs(row[x] - row[x - 1])).toBeLessThan(0.02);
  });
});
