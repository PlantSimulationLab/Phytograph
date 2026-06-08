import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildShootPolylines,
  appendTube,
  type MeshArrays,
} from './QSM3D';
import type { QSMCylinder, QSMShoot } from '../../../utils/backendApi';

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
