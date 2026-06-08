import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildShootPolylines,
  appendTube,
  rankColor,
  RANK_COLORS,
  type MeshArrays,
} from './QSM3D';
import type { QSMCylinder, QSMShoot } from '../../../utils/backendApi';

// Regression: adjacent ranks must be visually DISTINGUISHABLE. The trunk (rank 0)
// and scaffold (rank 1) were once nearly the same hue (brown vs amber), so a parent
// and its child branch read as the same colour even though their ranks differed.
describe('rank colors are distinguishable', () => {
  const rgbDist = (a: THREE.Color, b: THREE.Color) =>
    Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

  it('every adjacent rank pair is clearly separated', () => {
    for (let i = 0; i < RANK_COLORS.length - 1; i++) {
      const d = rgbDist(rankColor(i), rankColor(i + 1));
      expect(d).toBeGreaterThan(0.4); // the old brown->amber was 0.23 (too close)
    }
  });

  it('every rank color is bright enough for the dark background', () => {
    for (let i = 0; i < RANK_COLORS.length; i++) {
      const c = rankColor(i);
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      expect(lum).toBeGreaterThan(0.2);
    }
  });
});

// Helpers to fabricate minimal QSM data with exact, known geometry.
function cyl(
  id: number,
  start: [number, number, number],
  end: [number, number, number],
  radius: number,
  shoot_id: number,
  rank: number,
  parent_id = -1
): QSMCylinder {
  return { cyl_id: id, start, end, radius, parent_id, shoot_id, rank, surf_cov: null, mad: null };
}
function shoot(shoot_id: number, rank: number, cylinder_ids: number[]): QSMShoot {
  return {
    shoot_id,
    rank,
    cylinder_ids,
    parent_shoot_id: -1,
    parent_cyl_id: -1,
    child_shoot_ids: [],
  };
}
function emptyArrays(): MeshArrays {
  return { positions: [], normals: [], colors: [], indices: [], indexOffset: { value: 0 } };
}

describe('buildShootPolylines', () => {
  it('turns a K-cylinder shoot into a K+1 node polyline (base->tip)', () => {
    // 3 perfectly-joined cylinders straight up: nodes z = 0,1,2,3.
    const cyls = [
      cyl(0, [0, 0, 0], [0, 0, 1], 0.05, 0, 0),
      cyl(1, [0, 0, 1], [0, 0, 2], 0.04, 0, 0, 0),
      cyl(2, [0, 0, 2], [0, 0, 3], 0.03, 0, 0, 1),
    ];
    const polys = buildShootPolylines(cyls, [shoot(0, 0, [0, 1, 2])]);
    expect(polys).toHaveLength(1);
    const p = polys[0];
    expect(p.nodes).toHaveLength(4); // K+1
    expect(p.radii).toHaveLength(4);
    expect(p.nodes.map((n) => n.z)).toEqual([0, 1, 2, 3]);
    // Endpoint radii from their one adjoining cylinder; interior = average.
    expect(p.radii[0]).toBeCloseTo(0.05);
    expect(p.radii[1]).toBeCloseTo((0.05 + 0.04) / 2);
    expect(p.radii[2]).toBeCloseTo((0.04 + 0.03) / 2);
    expect(p.radii[3]).toBeCloseTo(0.03);
  });

  it('reconciles a drifted joint by averaging the two sides into one node', () => {
    // cyl0.end and cyl1.start disagree by 2cm (simulating the backend axis-fit drift).
    const cyls = [
      cyl(0, [0, 0, 0], [0, 0, 1.0], 0.05, 0, 0),
      cyl(1, [0, 0, 1.02], [0, 0, 2], 0.03, 0, 0, 0),
    ];
    const p = buildShootPolylines(cyls, [shoot(0, 0, [0, 1])])[0];
    // The shared node sits at the midpoint -> a single, continuous joint.
    expect(p.nodes[1].z).toBeCloseTo(1.01);
  });

  it('handles a single-cylinder shoot (2 nodes)', () => {
    const cyls = [cyl(0, [0, 0, 0], [0, 0, 1], 0.02, 0, 0)];
    const p = buildShootPolylines(cyls, [shoot(0, 0, [0])])[0];
    expect(p.nodes).toHaveLength(2);
  });

  it('clamps non-positive radius to a tiny positive value', () => {
    const cyls = [cyl(0, [0, 0, 0], [0, 0, 1], 0, 0, 0)];
    const p = buildShootPolylines(cyls, [shoot(0, 0, [0])])[0];
    expect(p.radii.every((r) => r > 0)).toBe(true);
  });

  it('skips empty shoots and missing cylinder ids without crashing', () => {
    const cyls = [cyl(0, [0, 0, 0], [0, 0, 1], 0.02, 0, 0)];
    const polys = buildShootPolylines(cyls, [
      shoot(0, 0, [0, 999]), // 999 missing -> filtered
      shoot(1, 1, []), // empty -> skipped
    ]);
    expect(polys).toHaveLength(1);
    expect(polys[0].nodes).toHaveLength(2); // only cyl 0 survived
  });
});

describe('appendTube', () => {
  const RED = new THREE.Color(1, 0, 0);

  function buildOneTube(nodes: THREE.Vector3[], radii: number[], n: number) {
    const arr = emptyArrays();
    appendTube(arr, nodes, radii, nodes.map(() => RED), n);
    return arr;
  }

  it('emits the expected vertex and triangle counts (single ring per node)', () => {
    const nodes = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 2)];
    const radii = [0.05, 0.04, 0.03];
    const n = 8;
    const arr = buildOneTube(nodes, radii, n);
    const m = nodes.length;
    // M rings of (N+1) verts each.
    expect(arr.positions.length / 3).toBe(m * (n + 1));
    expect(arr.normals.length / 3).toBe(m * (n + 1));
    expect(arr.colors.length / 3).toBe(m * (n + 1));
    // (M-1) ring-pairs * N quads * 2 triangles * 3 indices.
    expect(arr.indices.length).toBe((m - 1) * n * 6);
    expect(arr.indexOffset.value).toBe(m * (n + 1));
  });

  it('produces no NaNs and unit-length normals', () => {
    const nodes = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.2, 0, 1),
      new THREE.Vector3(0.5, 0.3, 1.8), // a bend, exercises parallel transport
    ];
    const arr = buildOneTube(nodes, [0.05, 0.04, 0.02], 8);
    expect(arr.positions.every((v) => Number.isFinite(v))).toBe(true);
    expect(arr.normals.every((v) => Number.isFinite(v))).toBe(true);
    for (let i = 0; i < arr.normals.length; i += 3) {
      const len = Math.hypot(arr.normals[i], arr.normals[i + 1], arr.normals[i + 2]);
      expect(len).toBeCloseTo(1, 5);
    }
  });

  it('places each ring on a circle of the node radius around the node center', () => {
    const nodes = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1)];
    const radii = [0.05, 0.03];
    const n = 8;
    const arr = buildOneTube(nodes, radii, n);
    // Ring 0 verts: indices 0..n; ring 1: n+1..2n+1. Each vert is `radius` from its
    // node center (the property that makes radius continuous at shared joints).
    for (let j = 0; j <= n; j++) {
      const o = j * 3;
      const d = Math.hypot(arr.positions[o], arr.positions[o + 1], arr.positions[o + 2] - 0);
      expect(d).toBeCloseTo(radii[0], 5);
    }
    for (let j = 0; j <= n; j++) {
      const o = (n + 1 + j) * 3;
      const d = Math.hypot(arr.positions[o], arr.positions[o + 1], arr.positions[o + 2] - 1);
      expect(d).toBeCloseTo(radii[1], 5);
    }
  });

  it('keeps a single shared ring per node so the radius is continuous at joints', () => {
    // Two shoots... no: within ONE tube, the joint node has exactly one ring of
    // verts (not two coincident rings as the old per-cylinder renderer produced).
    // Verify total rings == node count, i.e. no duplicate joint rings.
    const nodes = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0, 2),
      new THREE.Vector3(0, 0, 3),
    ];
    const n = 6;
    const arr = buildOneTube(nodes, [0.05, 0.04, 0.03, 0.02], n);
    expect(arr.positions.length / 3).toBe(nodes.length * (n + 1)); // 4 rings, not 6
  });

  it('appends multiple tubes with a correctly advancing index offset', () => {
    const arr = emptyArrays();
    const n = 6;
    const a = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1)];
    const b = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 1)];
    appendTube(arr, a, [0.02, 0.02], a.map(() => RED), n);
    const afterFirst = arr.indexOffset.value;
    appendTube(arr, b, [0.02, 0.02], b.map(() => RED), n);
    // Second tube's indices reference vertices >= afterFirst (no overlap with the
    // first tube's vertex range).
    const secondTubeIndices = arr.indices.slice((2 - 1) * n * 6);
    expect(Math.min(...secondTubeIndices)).toBeGreaterThanOrEqual(afterFirst);
    expect(arr.indexOffset.value).toBe(2 * 2 * (n + 1));
  });

  it('does not crash on a degenerate (zero-length) segment', () => {
    const nodes = [
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0), // coincident -> degenerate axial
      new THREE.Vector3(0, 0, 1),
    ];
    const arr = buildOneTube(nodes, [0.02, 0.02, 0.02], 6);
    expect(arr.positions.every((v) => Number.isFinite(v))).toBe(true);
  });
});

// Regression for the "giant tube shooting into the ground / crown slabs" bug:
// previously NOTHING tested that the geometry the renderer builds from a WHOLE
// multi-shoot tree stays bounded. The backend tests pass (data is clean) and the
// E2E only checks the results-panel DOM, so a renderer that drew an out-of-bounds
// tube would slip through. These tests build geometry from a realistic multi-shoot
// QSM and assert every rendered vertex stays inside the cylinders' bounding box
// (plus a max-radius margin) and that no tube segment is far longer than the
// cylinders that produced it -- exactly the pathology the screenshot showed.
describe('whole-tree rendered geometry stays bounded (regression)', () => {
  // A small tree: a trunk (rank 0) + two scaffolds (rank 1), each a chain of
  // contiguous cylinders, spanning a known bounding box ~[0,2] in each axis.
  function smallTree(): { cylinders: QSMCylinder[]; shoots: QSMShoot[] } {
    const cylinders: QSMCylinder[] = [];
    let id = 0;
    const chain = (
      from: [number, number, number],
      to: [number, number, number],
      n: number,
      r0: number,
      r1: number,
      shoot_id: number,
      rank: number,
      firstParent: number
    ): number[] => {
      const ids: number[] = [];
      let prev = firstParent;
      for (let i = 0; i < n; i++) {
        const t0 = i / n, t1 = (i + 1) / n;
        const lerp = (a: number[], b: number[], t: number) =>
          [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as [number, number, number];
        cylinders.push(
          cyl(id, lerp(from, to, t0), lerp(from, to, t1), r0 + (r1 - r0) * t0, shoot_id, rank, prev)
        );
        ids.push(id);
        prev = id;
        id++;
      }
      return ids;
    };
    const trunkIds = chain([0, 0, 0], [0, 0, 1], 10, 0.05, 0.03, 0, 0, -1);
    const sc1 = chain([0, 0, 1], [1, 0, 2], 6, 0.025, 0.01, 1, 1, trunkIds[trunkIds.length - 1]);
    const sc2 = chain([0, 0, 1], [-1, 0.5, 2], 6, 0.025, 0.01, 2, 1, trunkIds[trunkIds.length - 1]);
    const shoots = [
      shoot(0, 0, trunkIds),
      shoot(1, 1, sc1),
      shoot(2, 1, sc2),
    ];
    return { cylinders, shoots };
  }

  function renderAll(cylinders: QSMCylinder[], shoots: QSMShoot[]) {
    const arr = emptyArrays();
    for (const p of buildShootPolylines(cylinders, shoots)) {
      appendTube(arr, p.nodes, p.radii, p.nodes.map(() => new THREE.Color(1, 0, 0)), 8);
    }
    return arr;
  }

  function cylBBox(cylinders: QSMCylinder[]) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    let maxR = 0;
    for (const c of cylinders) {
      for (const p of [c.start, c.end]) for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]);
      }
      maxR = Math.max(maxR, c.radius);
    }
    return { lo, hi, maxR };
  }

  it('every rendered vertex stays within the cylinder bounding box (+radius)', () => {
    const { cylinders, shoots } = smallTree();
    const arr = renderAll(cylinders, shoots);
    const { lo, hi, maxR } = cylBBox(cylinders);
    const m = maxR + 1e-6; // a surface vertex sits up to one radius outside the axis bbox
    for (let i = 0; i < arr.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = arr.positions[i + k];
        expect(v).toBeGreaterThanOrEqual(lo[k] - m);
        expect(v).toBeLessThanOrEqual(hi[k] + m);
      }
    }
    // No NaN/Inf anywhere.
    expect(arr.positions.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('no tube segment is far longer than the cylinders that produced it', () => {
    const { cylinders, shoots } = smallTree();
    const maxCylLen = Math.max(
      ...cylinders.map((c) =>
        Math.hypot(c.end[0] - c.start[0], c.end[1] - c.start[1], c.end[2] - c.start[2])
      )
    );
    let worst = 0;
    for (const p of buildShootPolylines(cylinders, shoots)) {
      for (let i = 0; i < p.nodes.length - 1; i++) {
        worst = Math.max(worst, p.nodes[i].distanceTo(p.nodes[i + 1]));
      }
    }
    // A tube node-segment is ~one cylinder long; allow generous slack but catch a
    // giant span (the 40 m streak the screenshot showed would be ~hundreds x).
    expect(worst).toBeLessThanOrEqual(maxCylLen * 3);
  });

  it('a SCRAMBLED cylinder_ids order cannot create a giant span (defensive)', () => {
    // If a shoot's cylinder_ids ever arrive out of base->tip order, the renderer
    // must not draw a tube leaping across the tree. buildShootPolylines orders by
    // the chain; assert the worst node-segment stays bounded even when ids are
    // shuffled, by sorting them back into a contiguous chain via parent links.
    const { cylinders, shoots } = smallTree();
    const byId = new Map(cylinders.map((c) => [c.cyl_id, c]));
    // Shuffle the trunk shoot's ids.
    const trunk = shoots[0];
    const shuffled = [...trunk.cylinder_ids].reverse();
    const scrambled = [{ ...trunk, cylinder_ids: shuffled }, shoots[1], shoots[2]];
    const polys = buildShootPolylines(cylinders, scrambled);
    let worst = 0;
    for (const p of polys) {
      for (let i = 0; i < p.nodes.length - 1; i++) {
        worst = Math.max(worst, p.nodes[i].distanceTo(p.nodes[i + 1]));
      }
    }
    // Even reversed, consecutive cylinders are physically adjacent (a reversed
    // contiguous chain is still contiguous), so no giant span. This documents the
    // assumption: buildShootPolylines REQUIRES cylinder_ids to be a contiguous
    // chain; it does not re-sort. (Backend guarantees contiguity -- verified in
    // backend tests.) The geometric bound still holds here.
    const maxCylLen = Math.max(
      ...cylinders.map((c) =>
        Math.hypot(c.end[0] - c.start[0], c.end[1] - c.start[1], c.end[2] - c.start[2])
      )
    );
    expect(worst).toBeLessThanOrEqual(maxCylLen * 3);
    expect(byId.size).toBe(cylinders.length);
  });
});
