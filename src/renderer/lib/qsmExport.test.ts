import { describe, it, expect } from 'vitest';
import {
  qsmToCylinderCsv,
  qsmToCylinderMeshObj,
  qsmToCylinderMeshPly,
  sanitizeQsmFilename,
  qsmExtForFormat,
  buildQsmTubes,
  cylinderAxis,
  serializeQsm,
} from './qsmExport';
import { buildShootPolylines, buildTubeFrame, sweepTube } from './qsmTube';
import type { QSMEntry } from './pointCloudTypes';
import type { QSMCylinder } from '../utils/backendApi';

const TUBE_SEGMENTS = 12;
const RING_STRIDE = TUBE_SEGMENTS + 1; // duplicated seam vertex per ring

// The fixture below has two shoots: shoot 0 with 2 cylinders (3 nodes) and shoot 1
// with 1 cylinder (2 nodes) -> 5 rings total.
const TOTAL_RINGS = 3 + 2;
const TOTAL_VERTS = TOTAL_RINGS * RING_STRIDE;
// (M-1) ring pairs per shoot * segments quads * 2 triangles.
const TOTAL_FACES = ((3 - 1) + (2 - 1)) * TUBE_SEGMENTS * 2;

function cyl(over: Partial<QSMCylinder>): QSMCylinder {
  return {
    cyl_id: 0,
    start: [0, 0, 0],
    end: [0, 0, 1],
    radius: 0.05,
    parent_id: -1,
    shoot_id: 0,
    rank: 0,
    surf_cov: 0.8,
    mad: 0.001,
    ...over,
  };
}

// A tiny tree: trunk root + one child branch.
function fixtureQsm(): QSMEntry {
  const cylinders: QSMCylinder[] = [
    cyl({ cyl_id: 0, start: [0, 0, 0], end: [0, 0, 1], radius: 0.1, parent_id: -1, shoot_id: 0, rank: 0 }),
    cyl({ cyl_id: 1, start: [0, 0, 1], end: [0, 0, 2], radius: 0.05, parent_id: 0, shoot_id: 0, rank: 0 }),
    cyl({ cyl_id: 2, start: [0, 0, 1], end: [1, 0, 1], radius: 0.03, parent_id: 0, shoot_id: 1, rank: 1, surf_cov: null, mad: null }),
  ];
  return {
    id: 'qsm-test',
    sourceCloudId: 'cloud-1',
    cylinders,
    shoots: [
      { shoot_id: 0, rank: 0, cylinder_ids: [0, 1], parent_shoot_id: -1, parent_cyl_id: -1, child_shoot_ids: [1] },
      { shoot_id: 1, rank: 1, cylinder_ids: [2], parent_shoot_id: 0, parent_cyl_id: 0, child_shoot_ids: [] },
    ],
    metrics: null,
    visible: true,
  };
}

describe('cylinderAxis', () => {
  it('returns a unit axis for a non-degenerate cylinder', () => {
    const a = cylinderAxis(cyl({ start: [0, 0, 0], end: [0, 0, 2] }))!;
    expect(a).not.toBeNull();
    const len = Math.hypot(a[0], a[1], a[2]);
    expect(len).toBeCloseTo(1, 10);
    expect(a).toEqual([0, 0, 1]);
  });

  it('returns null for a zero-length cylinder', () => {
    expect(cylinderAxis(cyl({ start: [1, 1, 1], end: [1, 1, 1] }))).toBeNull();
  });
});

describe('buildQsmTubes', () => {
  it('builds ONE continuous tube per shoot, not one per cylinder', () => {
    const tubes = buildQsmTubes(fixtureQsm());
    // 3 cylinders, but only 2 shoots.
    expect(tubes).toHaveLength(2);
    expect(tubes.map((t) => t.shootId).sort()).toEqual([0, 1]);
    // Shoot 0 chains 2 cylinders -> 3 rings; shoot 1 has 1 cylinder -> 2 rings.
    expect(tubes[0].positions).toHaveLength(3 * RING_STRIDE);
    expect(tubes[1].positions).toHaveLength(2 * RING_STRIDE);
  });

  it('emits no cap geometry, so joints are not sealed off inside the tube', () => {
    // A capped build would add 2 cap-center vertices + 2*segments cap triangles per
    // cylinder. Exactly (M-1)*segments*2 side triangles means side quads only.
    const t = buildQsmTubes(fixtureQsm())[0];
    expect(t.faces).toHaveLength((3 - 1) * TUBE_SEGMENTS * 2);
  });

  it('varies the radius continuously across a joint instead of stepping', () => {
    // Fixture shoot 0: cyl radii 0.1 then 0.05. The shared interior node must take
    // the MEAN (0.075) -- the old per-cylinder export jumped 0.1 -> 0.05.
    const t = buildQsmTubes(fixtureQsm())[0];
    expect(t.radii).toHaveLength(3);
    expect(t.radii[0]).toBeCloseTo(0.1, 9);
    expect(t.radii[1]).toBeCloseTo(0.075, 9);
    expect(t.radii[2]).toBeCloseTo(0.05, 9);
  });

  it('places every ring vertex exactly its node radius from the node center', () => {
    const poly = buildShootPolylines(fixtureQsm().cylinders, fixtureQsm().shoots)[0];
    const t = buildQsmTubes(fixtureQsm())[0];
    for (let ring = 0; ring < poly.nodes.length; ring++) {
      const center = poly.nodes[ring];
      for (let j = 0; j < RING_STRIDE; j++) {
        const p = t.positions[ring * RING_STRIDE + j];
        const d = Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]);
        expect(d).toBeCloseTo(poly.radii[ring], 6);
      }
    }
  });

  it('transports the ring frame with zero twist about the axis', () => {
    // THE defect that made the old export read as disjointed cylinders: each
    // cylinder derived its ring basis from a FIXED WORLD REFERENCE, so consecutive
    // rings were rotated arbitrarily about the axis relative to each other and the
    // side quads sheared. A rotation-minimizing frame instead carries the previous
    // radial forward, rotating it ONLY by the bend itself -- zero twist.
    //
    // The path must be NON-PLANAR: for a bend confined to one plane the rotation
    // axis is constant and a world-referenced pick coincidentally agrees, so a
    // planar fixture cannot detect the bug.
    const nodes: [number, number, number][] = [
      [0, 0, 0], [0, 0, 1], [1, 0, 1.6], [1, 1, 2.2], [0.3, 1.6, 2.8],
    ];
    const { axial, radial } = buildTubeFrame(nodes);

    for (let i = 0; i + 1 < nodes.length; i++) {
      // Transport radial[i] across the bend axial[i] -> axial[i+1] by hand, then
      // compare with the frame's own radial[i+1]. Equal => no twist was introduced.
      const ax = axial[i], nx = axial[i + 1];
      const rot: [number, number, number] = [
        ax[1] * nx[2] - ax[2] * nx[1],
        ax[2] * nx[0] - ax[0] * nx[2],
        ax[0] * nx[1] - ax[1] * nx[0],
      ];
      const rotLen = Math.hypot(rot[0], rot[1], rot[2]);
      let expected = radial[i];
      if (rotLen > 1e-5) {
        const k: [number, number, number] = [rot[0] / rotLen, rot[1] / rotLen, rot[2] / rotLen];
        const ang = Math.acos(Math.max(-1, Math.min(1, ax[0] * nx[0] + ax[1] * nx[1] + ax[2] * nx[2])));
        const v = radial[i];
        const c = Math.cos(ang), s = Math.sin(ang);
        const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
        expected = [
          v[0] * c + (k[1] * v[2] - k[2] * v[1]) * s + k[0] * kv * (1 - c),
          v[1] * c + (k[2] * v[0] - k[0] * v[2]) * s + k[1] * kv * (1 - c),
          v[2] * c + (k[0] * v[1] - k[1] * v[0]) * s + k[2] * kv * (1 - c),
        ];
      }
      // Angle between the transported radial and the frame's radial must be ~0.
      const d = expected[0] * radial[i + 1][0] + expected[1] * radial[i + 1][1] + expected[2] * radial[i + 1][2];
      expect(Math.acos(Math.max(-1, Math.min(1, d)))).toBeLessThan(1e-6);
    }
  });

  it('emits finite, unit-length normals', () => {
    for (const t of buildQsmTubes(fixtureQsm())) {
      for (const n of t.normals) {
        expect(Number.isFinite(n[0] + n[1] + n[2])).toBe(true);
        expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 6);
      }
    }
  });

  it('skips a shoot too short to sweep', () => {
    expect(sweepTube([[0, 0, 0]], [0.1], TUBE_SEGMENTS)).toBeNull();
  });
});

describe('qsmToCylinderCsv', () => {
  const csv = qsmToCylinderCsv(fixtureQsm());
  const lines = csv.trim().split('\n');

  it('emits the exact SimpleForest-compatible header', () => {
    // Verified against rTwig's importer: ID/parentID/branchID/branchOrder gate
    // detection; segmentID/parentSegmentID are required by its first mutate.
    expect(lines[0]).toBe(
      'ID,parentID,branchID,branchOrder,segmentID,parentSegmentID,' +
        'startX,startY,startZ,endX,endY,endZ,' +
        'axisX,axisY,axisZ,radius,length,surfaceCoverage,meanAbsDeviation',
    );
  });

  it('has one data row per cylinder', () => {
    expect(lines).toHaveLength(1 + 3); // header + 3 cylinders
  });

  it('writes parentID=-1 for the root cylinder', () => {
    const root = lines[1].split(',');
    expect(root[0]).toBe('0'); // ID
    expect(root[1]).toBe('-1'); // parentID
  });

  it('emits segmentID (= shoot) and parentSegmentID (= parent shoot, -1 for trunk)', () => {
    const root = lines[1].split(','); // cyl 0: shoot 0, trunk shoot -> parent -1
    expect(root[4]).toBe('0'); // segmentID
    expect(root[5]).toBe('-1'); // parentSegmentID (trunk)
    const branch = lines[3].split(','); // cyl 2: shoot 1, parent shoot 0
    expect(branch[4]).toBe('1'); // segmentID
    expect(branch[5]).toBe('0'); // parentSegmentID
  });

  it('computes a unit axis and correct length', () => {
    // cyl 0: start (0,0,0) end (0,0,1) -> axis (0,0,1), length 1
    const row = lines[1].split(',');
    expect(Number(row[12])).toBeCloseTo(0); // axisX
    expect(Number(row[13])).toBeCloseTo(0); // axisY
    expect(Number(row[14])).toBeCloseTo(1); // axisZ
    expect(Number(row[16])).toBeCloseTo(1); // length
  });

  it('renders null surf_cov / mad as empty fields', () => {
    const row = lines[3].split(','); // cyl 2 has null surf_cov + mad
    expect(row[17]).toBe(''); // surfaceCoverage
    expect(row[18]).toBe(''); // meanAbsDeviation
  });

  it('maps shoot_id to branchID and rank to branchOrder', () => {
    const row = lines[3].split(','); // cyl 2: shoot_id 1, rank 1
    expect(row[2]).toBe('1'); // branchID
    expect(row[3]).toBe('1'); // branchOrder
  });
});

describe('qsmToCylinderMeshObj', () => {
  const obj = qsmToCylinderMeshObj(fixtureQsm());
  const lines = obj.trim().split('\n');

  it('emits one swept tube per shoot, with a normal for every vertex', () => {
    const vCount = lines.filter(l => l.startsWith('v ')).length;
    const vnCount = lines.filter(l => l.startsWith('vn ')).length;
    const fCount = lines.filter(l => l.startsWith('f ')).length;
    expect(vCount).toBe(TOTAL_VERTS);
    expect(vnCount).toBe(TOTAL_VERTS); // smooth normals, else viewers shade it faceted
    expect(fCount).toBe(TOTAL_FACES);
  });

  it('groups each shoot as a named object so it stays separable in Blender', () => {
    const groups = lines.filter(l => l.startsWith('o '));
    expect(groups).toEqual(['o shoot_0_rank_0', 'o shoot_1_rank_1']);
  });

  it('uses 1-based v//vn face indices within the total vertex range', () => {
    for (const l of lines.filter(x => x.startsWith('f '))) {
      const verts = l.slice(2).trim().split(/\s+/);
      expect(verts).toHaveLength(3);
      for (const v of verts) {
        const [vi, vni] = v.split('//').map(Number);
        expect(vi).toBeGreaterThanOrEqual(1);
        expect(vi).toBeLessThanOrEqual(TOTAL_VERTS);
        expect(vni).toBe(vi); // positions and normals are parallel arrays
      }
    }
  });

  it('matches the geometry the viewport renders (same shared tube builder)', () => {
    // The bug this guards: the exporter used to build its own per-cylinder capped
    // cylinders, so the OBJ was a pile of disjoint tubes while the viewport showed
    // a smooth swept tube. Every exported vertex must be a vertex the shared
    // builder produced.
    const expected = new Set(
      buildQsmTubes(fixtureQsm()).flatMap(t =>
        t.positions.map(p => `${p[0]} ${p[1]} ${p[2]}`),
      ),
    );
    const got = lines.filter(l => l.startsWith('v ')).map(l => l.slice(2));
    expect(got).toHaveLength(TOTAL_VERTS);
    for (const g of got) expect(expected.has(g)).toBe(true);
  });

  it('skips a shoot whose cylinders are all degenerate', () => {
    const q = fixtureQsm();
    q.cylinders.push(cyl({ cyl_id: 9, start: [5, 5, 5], end: [5, 5, 5], shoot_id: 2, rank: 1 }));
    q.shoots.push({
      shoot_id: 2, rank: 1, cylinder_ids: [9],
      parent_shoot_id: 0, parent_cyl_id: 0, child_shoot_ids: [],
    });
    const objD = qsmToCylinderMeshObj(q);
    // A zero-length cylinder yields 2 coincident nodes: still swept (harmless,
    // finite), but it must never produce NaNs in the file.
    expect(objD).not.toMatch(/NaN|Infinity/);
  });
});

describe('qsmToCylinderMeshPly', () => {
  const ply = qsmToCylinderMeshPly(fixtureQsm());
  const lines = ply.trim().split('\n');

  it('declares vertex/face counts matching the body', () => {
    const vDecl = Number(lines.find(l => l.startsWith('element vertex'))!.split(' ')[2]);
    const fDecl = Number(lines.find(l => l.startsWith('element face'))!.split(' ')[2]);
    expect(vDecl).toBe(TOTAL_VERTS);
    expect(fDecl).toBe(TOTAL_FACES);

    const headerEnd = lines.indexOf('end_header');
    const body = lines.slice(headerEnd + 1);
    expect(body).toHaveLength(vDecl + fDecl);
  });

  it('declares and writes vertex normals', () => {
    expect(lines).toContain('property float nx');
    const headerEnd = lines.indexOf('end_header');
    // "x y z nx ny nz" -> 6 tokens per vertex line.
    const first = lines[headerEnd + 1].trim().split(/\s+/);
    expect(first).toHaveLength(6);
    const n = first.slice(3).map(Number);
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
  });

  it('attaches branch_order equal to the shoot rank on each face', () => {
    const headerEnd = lines.indexOf('end_header');
    const faceLines = lines.slice(headerEnd + 1 + TOTAL_VERTS);
    const firstFace = faceLines[0].trim().split(/\s+/);
    // "3 i j k branch_order radius" -> 6 tokens
    expect(firstFace).toHaveLength(6);
    expect(firstFace[0]).toBe('3');
    expect(firstFace[4]).toBe('0'); // rank-0 trunk shoot
    // The rank-1 shoot is last; its faces should carry branch_order 1.
    const lastFace = faceLines[faceLines.length - 1].trim().split(/\s+/);
    expect(lastFace[4]).toBe('1');
  });

  it('carries the per-node radius on each face, so it tapers along a shoot', () => {
    const headerEnd = lines.indexOf('end_header');
    const faceLines = lines.slice(headerEnd + 1 + TOTAL_VERTS);
    // Trunk shoot 0 tapers 0.1 -> 0.075 -> 0.05. Its first ring-pair's faces carry
    // 0.1; the second ring-pair's carry the joint mean 0.075. A per-cylinder export
    // could only ever emit the two raw cylinder radii.
    const radiusOf = (l: string) => Number(l.trim().split(/\s+/)[5]);
    expect(radiusOf(faceLines[0])).toBeCloseTo(0.1, 6);
    expect(radiusOf(faceLines[TUBE_SEGMENTS * 2])).toBeCloseTo(0.075, 6);
  });

  it('keeps every face index inside the declared vertex range', () => {
    const headerEnd = lines.indexOf('end_header');
    const faceLines = lines.slice(headerEnd + 1 + TOTAL_VERTS);
    for (const l of faceLines) {
      for (const i of l.trim().split(/\s+/).slice(1, 4).map(Number)) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(TOTAL_VERTS);
      }
    }
  });
});

// The regression this whole refactor exists for: the OBJ/PLY exporters used to
// build their own geometry (one capped cylinder per cylinder, world-referenced ring
// frames, unreconciled joints, stepped radii) while the viewport swept one
// continuous tube per shoot. The exported mesh therefore looked like a pile of
// disjoint cylinders in Blender, and its surface area / volume were wrong. Both now
// go through lib/qsmTube; these tests assert the properties that would break again
// if someone reintroduces a private geometry path.
describe('exported mesh matches the rendered mesh', () => {
  const q = fixtureQsm();

  it('OBJ and PLY share identical vertex positions', () => {
    const objV = qsmToCylinderMeshObj(q)
      .trim().split('\n').filter(l => l.startsWith('v ')).map(l => l.slice(2));
    const ply = qsmToCylinderMeshPly(q).trim().split('\n');
    const plyV = ply
      .slice(ply.indexOf('end_header') + 1, ply.indexOf('end_header') + 1 + TOTAL_VERTS)
      .map(l => l.trim().split(/\s+/).slice(0, 3).join(' '));
    expect(objV).toEqual(plyV);
  });

  it('joins consecutive cylinders of a shoot into one watertight surface', () => {
    // Within a shoot, the joint is a SINGLE shared ring: ring count == node count.
    // A per-cylinder export produced two coincident rings there (plus caps between
    // them), which is exactly what read as "disjointed cylinders".
    const t = buildQsmTubes(q)[0];
    expect(t.positions.length / RING_STRIDE).toBe(3); // 2 cylinders -> 3 rings, not 4
  });

  it('has no interior cap surface inflating the exported area', () => {
    const total = buildQsmTubes(q).reduce((n, t) => n + t.faces.length, 0);
    expect(total).toBe(TOTAL_FACES);
  });

  it('produces no NaN or Infinity coordinates in either format', () => {
    expect(qsmToCylinderMeshObj(q)).not.toMatch(/NaN|Infinity/);
    expect(qsmToCylinderMeshPly(q)).not.toMatch(/NaN|Infinity/);
  });
});

describe('sanitizeQsmFilename', () => {
  it('strips path separators and reserved characters', () => {
    expect(sanitizeQsmFilename('tree/scan:1*?')).toBe('tree_scan_1');
    expect(sanitizeQsmFilename('a\\b')).toBe('a_b');
  });
  it('collapses whitespace and trims', () => {
    expect(sanitizeQsmFilename('  my   tree  ')).toBe('my_tree');
  });
  it('falls back to "qsm" for empty results', () => {
    expect(sanitizeQsmFilename('///')).toBe('qsm');
    expect(sanitizeQsmFilename('')).toBe('qsm');
  });
  it('drops a trailing source extension so the export ext is not doubled up', () => {
    expect(sanitizeQsmFilename('tree.xyz')).toBe('tree');
    expect(sanitizeQsmFilename('plot_3.laz')).toBe('plot_3');
    // Only the LAST extension goes; a dotted stem keeps its earlier dots.
    expect(sanitizeQsmFilename('scan.2024.las')).toBe('scan.2024');
  });
  it('keeps a trailing dot-segment that is not extension-shaped', () => {
    expect(sanitizeQsmFilename('oak.north_plot')).toBe('oak.north_plot');
  });
});

describe('qsmExtForFormat / serializeQsm', () => {
  it('returns the format as the extension', () => {
    expect(qsmExtForFormat('csv')).toBe('csv');
    expect(qsmExtForFormat('obj')).toBe('obj');
    expect(qsmExtForFormat('ply')).toBe('ply');
  });
  it('dispatches to the matching serializer', () => {
    const q = fixtureQsm();
    expect(serializeQsm(q, 'csv')).toBe(qsmToCylinderCsv(q));
    expect(serializeQsm(q, 'obj')).toBe(qsmToCylinderMeshObj(q));
    expect(serializeQsm(q, 'ply')).toBe(qsmToCylinderMeshPly(q));
  });
});
