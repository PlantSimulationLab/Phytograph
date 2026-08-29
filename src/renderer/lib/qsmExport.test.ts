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
  qsmToCylinderMeshObjBundle,
} from './qsmExport';
import { buildShootPolylines, buildTubeFrame, sweepTube } from './qsmTube';
import type { QSMEntry } from './pointCloudTypes';
import type { QSMCylinder } from '../utils/backendApi';
import { rankColorRgb, shootColorSrgb, hexToRgb } from './qsmColors';
import { srgbChannelToLinear } from '../utils/backendApi';

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
    const text = (fmt: 'csv' | 'obj' | 'ply') =>
      serializeQsm(q, fmt, { baseName: 'qsm' })[0].text;
    expect(text('csv')).toBe(qsmToCylinderCsv(q));
    expect(text('obj')).toBe(qsmToCylinderMeshObj(q));
    expect(text('ply')).toBe(qsmToCylinderMeshPly(q));
  });

  it('names every file in the bundle from the caller-supplied stem', () => {
    const q = fixtureQsm();
    expect(serializeQsm(q, 'csv', { baseName: 'oak' }).map(f => f.name)).toEqual(['oak.csv']);
    expect(serializeQsm(q, 'ply', { baseName: 'oak' }).map(f => f.name)).toEqual(['oak.ply']);
    expect(serializeQsm(q, 'obj', { baseName: 'oak' }).map(f => f.name)).toEqual([
      'oak.obj',
      'oak.mtl',
    ]);
  });
});


// The bug this suite exists for: the OBJ exporter wrote geometry ONLY -- no
// `mtllib`, no `usemtl`, no sibling .mtl -- so a QSM opened in Blender/CloudCompare
// was untextured grey, and every appearance choice the user made in the viewport
// (rank palette, per-shoot hues, a picked colour, a bark photo) was silently
// dropped. `Kd` via `usemtl` is the only colour channel that portably survives OBJ.
describe('OBJ materials', () => {
  const bundle = (appearance = {}) =>
    qsmToCylinderMeshObjBundle(fixtureQsm(), { baseName: 'tree', ...appearance });
  const objOf = (files: ReturnType<typeof bundle>) => files[0].text!;
  const mtlOf = (files: ReturnType<typeof bundle>) =>
    files.find(f => f.name.endsWith('.mtl'))!.text!;

  // Parse `newmtl NAME` blocks into { name: Kd triple }, the way a reader does.
  const kdByMaterial = (mtl: string): Record<string, number[]> => {
    const out: Record<string, number[]> = {};
    let current = '';
    for (const line of mtl.split('\n')) {
      const nm = line.match(/^newmtl (\S+)/);
      if (nm) { current = nm[1]; continue; }
      const kd = line.match(/^Kd (\S+) (\S+) (\S+)/);
      if (kd && current) out[current] = [+kd[1], +kd[2], +kd[3]];
    }
    return out;
  };

  it('writes an mtllib reference and a sibling .mtl that actually exists', () => {
    const files = bundle();
    expect(files.map(f => f.name)).toEqual(['tree.obj', 'tree.mtl']);
    // The mtllib name must match the file we ship, or the reader finds nothing.
    expect(objOf(files)).toContain('mtllib tree.mtl');
  });

  it('keeps an inner dot in the stem, so mtllib names the file we wrote', () => {
    // A user saving as `tree.v2.obj` means the stem `tree.v2`. Eating the `.v2`
    // (as the label sanitizer does, correctly, for a source filename) would emit
    // `mtllib tree.mtl` beside a file named `tree.v2.obj` — a reference to
    // nothing, which loads as untextured grey just like having no MTL at all.
    const files = bundle({ baseName: 'tree.v2' } as never);
    const objName = files[0].name;
    const mtlName = files.find(f => f.name.endsWith('.mtl'))!.name;
    expect(objName).toBe('tree.v2.obj');
    expect(mtlName).toBe('tree.v2.mtl');
    expect(files[0].text!).toContain(`mtllib ${mtlName}`);
  });

  it('declares every material the OBJ references (no dangling usemtl)', () => {
    for (const appearance of [
      { colorMode: 'rank' as const },
      { colorMode: 'shoot' as const },
      { colorMode: 'color' as const, solidColor: '#123456' },
    ]) {
      const files = bundle(appearance);
      const used = new Set(
        [...objOf(files).matchAll(/^usemtl (\S+)$/gm)].map(m => m[1]),
      );
      const declared = new Set(Object.keys(kdByMaterial(mtlOf(files))));
      expect(used.size).toBeGreaterThan(0);
      for (const u of used) expect(declared).toContain(u);
    }
  });

  it('assigns every shoot group a material, so no face exports unpainted', () => {
    const obj = objOf(bundle({ colorMode: 'rank' }));
    const groups = [...obj.matchAll(/^o (\S+)$/gm)].length;
    const usemtls = [...obj.matchAll(/^usemtl (\S+)$/gm)].length;
    expect(groups).toBe(2); // the fixture's two shoots
    expect(usemtls).toBe(groups);
    // Order matters: `usemtl` must precede the faces it applies to.
    const firstFace = obj.indexOf('\nf ');
    expect(obj.indexOf('\nusemtl ')).toBeLessThan(firstFace);
  });

  it('rank mode writes one material per rank, carrying the rank palette colour', () => {
    const kd = kdByMaterial(mtlOf(bundle({ colorMode: 'rank' })));
    // The fixture has rank 0 (trunk) and rank 1 (scaffold) -> two materials.
    expect(Object.keys(kd).sort()).toEqual(['rank_0', 'rank_1']);
    expect(kd.rank_0).toEqual(rankColorRgb(0).map(c => +c.toFixed(6)));
    expect(kd.rank_1).toEqual(rankColorRgb(1).map(c => +c.toFixed(6)));
    // And they must be visibly different, or the export loses the distinction the
    // palette exists to draw. Threshold is lower than QSM3D's matching assertion
    // because that one measures in three.js's LINEAR space while an MTL's Kd is
    // sRGB, where the same pair sits closer together.
    const dist = Math.hypot(...kd.rank_0.map((c, i) => c - kd.rank_1[i]));
    expect(dist).toBeGreaterThan(0.3);
  });

  it('shoot mode gives each shoot its own distinct material', () => {
    const kd = kdByMaterial(mtlOf(bundle({ colorMode: 'shoot' })));
    expect(Object.keys(kd).sort()).toEqual(['shoot_0', 'shoot_1']);
    expect(kd.shoot_0).toEqual(shootColorSrgb(0).map(c => +c.toFixed(6)));
    expect(kd.shoot_0).not.toEqual(kd.shoot_1);
  });

  it("color mode writes the user's picked colour as Kd, in sRGB", () => {
    const kd = kdByMaterial(mtlOf(bundle({ colorMode: 'color', solidColor: '#8b6f47' })));
    expect(Object.keys(kd)).toEqual(['qsm_color']);
    // sRGB, NOT three.js's linearized channels: 0x8b/255 = 0.545, not 0.256.
    expect(kd.qsm_color).toEqual(hexToRgb('#8b6f47').map(c => +c.toFixed(6)));
    expect(kd.qsm_color[0]).toBeCloseTo(0.545098, 5);
  });

  it('defaults to rank mode when no appearance is supplied', () => {
    expect(mtlOf(bundle())).toContain('newmtl rank_0');
  });
});

describe('OBJ bark texture', () => {
  // A 1x1 PNG and a 1x1 JPEG, as base64 -- enough for the magic-byte sniff.
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const JPEG_B64 = btoa(
    String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46),
  );
  const bundle = (barkTexture: { data: string; mime: string } | null, tile?: number) =>
    qsmToCylinderMeshObjBundle(fixtureQsm(), {
      baseName: 'tree',
      colorMode: 'texture',
      barkTexture,
      textureTileSize: tile,
    });

  it('ships the bark image and points map_Kd at the file it actually wrote', () => {
    const files = bundle({ data: PNG_B64, mime: 'image/png' });
    const img = files.find(f => f.bytes);
    expect(img).toBeDefined();
    expect(img!.name).toBe('tree_bark.png');
    // Real decoded bytes, not the base64 text -- a reader has to open this.
    expect(img!.bytes!.slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const mtl = files.find(f => f.name.endsWith('.mtl'))!.text!;
    expect(mtl).toContain(`map_Kd ${img!.name}`);
    // White Kd under a diffuse map, or the map gets tinted.
    expect(mtl).toMatch(/Kd 1\.000000 1\.000000 1\.000000/);
  });

  it('names the texture from its MAGIC BYTES, not the declared mime', () => {
    // The trap that shipped JPEG bytes under a .png name: readers pick a decoder
    // from the suffix, so a mismatch is a hard load error.
    const files = bundle({ data: JPEG_B64, mime: 'image/png' });
    expect(files.find(f => f.bytes)!.name).toBe('tree_bark.jpg');
  });

  it('writes UVs and v/vt/vn faces so the bark can actually tile', () => {
    const obj = bundle({ data: PNG_B64, mime: 'image/png' })[0].text!;
    expect(obj).toMatch(/^vt /m);
    // A textured face must reference the UV slot; `v//vn` would drop the mapping.
    expect(obj).toMatch(/^f \d+\/\d+\/\d+ \d+\/\d+\/\d+ \d+\/\d+\/\d+$/m);
    // One vt per vertex, or the indices don't line up.
    const vCount = [...obj.matchAll(/^v /gm)].length;
    expect([...obj.matchAll(/^vt /gm)].length).toBe(vCount);
  });

  it('omits vt in the non-textured modes (nothing maps them)', () => {
    const obj = qsmToCylinderMeshObjBundle(fixtureQsm(), {
      baseName: 'tree',
      colorMode: 'rank',
    })[0].text!;
    expect(obj).not.toMatch(/^vt /m);
    expect(obj).toMatch(/^f \d+\/\/\d+/m);
  });

  it('the tile size changes the UVs, so the bark scale the user set survives', () => {
    const uvs = (tile: number) =>
      [...bundle({ data: PNG_B64, mime: 'image/png' }, tile)[0].text!.matchAll(/^vt (\S+) (\S+)$/gm)]
        .map(m => +m[2]);
    const coarse = uvs(1.0);
    const fine = uvs(0.1);
    expect(fine.some((v, i) => Math.abs(v - coarse[i]) > 1e-6)).toBe(true);
  });

  it('degrades to a flat bark colour when the image is missing or undecodable', () => {
    for (const bad of [null, { data: 'not base64 @@@', mime: 'image/png' }]) {
      const files = bundle(bad as never);
      // No texture file, no dangling map_Kd naming a file we never wrote.
      expect(files.some(f => f.bytes)).toBe(false);
      const mtl = files.find(f => f.name.endsWith('.mtl'))!.text!;
      expect(mtl).not.toContain('map_Kd');
      expect(mtl).toContain('newmtl bark');
      // A plausible wood brown rather than white.
      expect(mtl).toMatch(/Kd 0\.545098 0\.435294 0\.278431/);
    }
  });
});


// Leaves added via the Add Leaves tool render as part of the tree in the viewport,
// so an OBJ without them exports a bare winter skeleton. They also carry real
// textured, alpha-cutout materials — the thing OBJ materials exist for.
describe('OBJ leaves', () => {
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  // Two leaf quads (4 triangles) with UVs and normals, in world coordinates —
  // the same frame the cylinders are in.
  function leafMesh() {
    const vertices = new Float32Array([
      0, 0, 2,  1, 0, 2,  1, 1, 2,  0, 1, 2,
      2, 0, 3,  3, 0, 3,  3, 1, 3,  2, 1, 3,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const normals = new Float32Array(Array.from({ length: 8 }, () => [0, 0, 1]).flat());
    const uvCoordinates = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
    return {
      vertices, indices, normals, uvCoordinates,
      vertexCount: 8, triangleCount: 4,
    };
  }

  function qsmWithLeaves(overrides: Record<string, unknown> = {}): QSMEntry {
    return {
      ...fixtureQsm(),
      leaves: {
        data: leafMesh(),
        plantMaterials: [
          { name: 'leaf', textureData: PNG_B64, hasAlpha: true, triangleIndices: [0, 1, 2, 3] },
        ],
        leafCount: 2,
        ...overrides,
      },
    } as QSMEntry;
  }

  const bundle = (q: QSMEntry) =>
    qsmToCylinderMeshObjBundle(q, { baseName: 'tree', colorMode: 'rank' });

  it('appends the leaf geometry as its own group', () => {
    const leafless = bundle(fixtureQsm())[0].text!;
    const leafy = bundle(qsmWithLeaves())[0].text!;
    expect(leafless).not.toContain('o leaves');
    expect(leafy).toContain('o leaves');
    // 8 leaf vertices and 4 leaf faces beyond the bare tree's.
    const count = (t: string, re: RegExp) => [...t.matchAll(re)].length;
    expect(count(leafy, /^v /gm)).toBe(count(leafless, /^v /gm) + 8);
    expect(count(leafy, /^f /gm)).toBe(count(leafless, /^f /gm) + 4);
  });

  it('writes leaf vertices in the world frame, unmodified', () => {
    const obj = bundle(qsmWithLeaves())[0].text!;
    // The leaf group's own vertex lines, in order.
    const leafBlock = obj.slice(obj.indexOf('o leaves'));
    const vs = [...leafBlock.matchAll(/^v (\S+) (\S+) (\S+)$/gm)].map(m =>
      [+m[1], +m[2], +m[3]],
    );
    expect(vs).toHaveLength(8);
    // Cylinders and leaves share one frame in the viewer, so no shift is applied.
    expect(vs[0]).toEqual([0, 0, 2]);
    expect(vs[6]).toEqual([3, 1, 3]);
  });

  it('ships the leaf texture with map_d, so cutouts survive re-import', () => {
    const files = bundle(qsmWithLeaves());
    const img = files.find(f => f.bytes);
    expect(img).toBeDefined();
    expect(img!.name).toMatch(/\.png$/);
    const mtl = files.find(f => f.name.endsWith('.mtl'))!.text!;
    expect(mtl).toContain(`map_Kd ${img!.name}`);
    // Alpha cutout => map_d. Without it a leaf comes back an opaque rectangle.
    expect(mtl).toContain(`map_d ${img!.name}`);
  });

  it('does NOT write map_d for opaque bark, only for cutouts', () => {
    // Same texture bytes, but bark is opaque — a dissolve map there would punch
    // holes through the trunk.
    const files = qsmToCylinderMeshObjBundle(fixtureQsm(), {
      baseName: 'tree',
      colorMode: 'texture',
      barkTexture: { data: PNG_B64, mime: 'image/png' },
    });
    const mtl = files.find(f => f.name.endsWith('.mtl'))!.text!;
    expect(mtl).toContain('map_Kd');
    expect(mtl).not.toContain('map_d');
  });

  it('indexes leaf v/vt/vn against their own 1-based spaces', () => {
    // The trap: OBJ counts v, vt and vn INDEPENDENTLY. In rank mode the tubes
    // write no `vt` at all, so a leaf UV index offset by the tube VERTEX count
    // would point past the end of the vt list (or at the wrong UV) — textures
    // land scrambled, or the file fails to parse.
    const obj = bundle(qsmWithLeaves())[0].text!;
    const vCount = [...obj.matchAll(/^v /gm)].length;
    const vtCount = [...obj.matchAll(/^vt /gm)].length;
    const vnCount = [...obj.matchAll(/^vn /gm)].length;
    // Rank mode: no tube UVs, so the only vt lines are the 8 leaf ones.
    expect(vtCount).toBe(8);

    const leafBlock = obj.slice(obj.indexOf('o leaves'));
    const faces = [...leafBlock.matchAll(/^f (.+)$/gm)].map(m => m[1]);
    expect(faces).toHaveLength(4);
    for (const f of faces) {
      for (const tri of f.trim().split(/\s+/)) {
        const [v, vt, vn] = tri.split('/').map(Number);
        // Every index must fall inside its OWN list.
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(vCount);
        expect(vt).toBeGreaterThan(0);
        expect(vt).toBeLessThanOrEqual(vtCount);
        expect(vn).toBeGreaterThan(0);
        expect(vn).toBeLessThanOrEqual(vnCount);
      }
    }
  });

  it('keeps leaf UV indices correct in texture mode too, where tubes DO write vt', () => {
    const obj = qsmToCylinderMeshObjBundle(qsmWithLeaves(), {
      baseName: 'tree',
      colorMode: 'texture',
      barkTexture: { data: PNG_B64, mime: 'image/png' },
    })[0].text!;
    const vtCount = [...obj.matchAll(/^vt /gm)].length;
    const leafBlock = obj.slice(obj.indexOf('o leaves'));
    // The leaf UVs are the LAST 8 vt lines, so their indices must be the top of
    // the range — not restarting at 1, and not running past the end.
    const vts = [...leafBlock.matchAll(/^f (.+)$/gm)]
      .flatMap(m => m[1].trim().split(/\s+/))
      .map(tri => Number(tri.split('/')[1]));
    expect(Math.min(...vts)).toBe(vtCount - 7);
    expect(Math.max(...vts)).toBe(vtCount);
  });

  it('gives leaf materials names that cannot collide with the tube materials', () => {
    // A leaf material literally named `rank_0` must not overwrite the trunk's.
    const q = qsmWithLeaves({
      plantMaterials: [
        { name: 'rank_0', textureData: PNG_B64, hasAlpha: true, triangleIndices: [0, 1, 2, 3] },
      ],
    });
    const files = bundle(q);
    const mtl = files.find(f => f.name.endsWith('.mtl'))!.text!;
    const names = [...mtl.matchAll(/^newmtl (\S+)$/gm)].map(m => m[1]);
    expect(new Set(names).size).toBe(names.length); // no duplicates
    expect(names).toContain('rank_0');
    expect(names).toContain('rank_0_2'); // the leaf, renamed out of the way
  });

  it('writes every leaf triangle even when no material claims it', () => {
    const q = qsmWithLeaves({ plantMaterials: [] });
    const obj = bundle(q)[0].text!;
    const leafBlock = obj.slice(obj.indexOf('o leaves'));
    expect([...leafBlock.matchAll(/^f /gm)]).toHaveLength(4);
    expect(leafBlock).toContain('usemtl leaf_default');
    const mtl = bundle(q).find(f => f.name.endsWith('.mtl'))!.text!;
    expect(mtl).toContain('newmtl leaf_default');
  });

  it('ignores an empty leaves record rather than emitting a stray group', () => {
    const q = qsmWithLeaves({
      data: { ...leafMesh(), triangleCount: 0, vertexCount: 0 },
    });
    expect(bundle(q)[0].text!).not.toContain('o leaves');
  });
});


// The reported bug: import a QSM CSV -> export to OBJ -> re-import, and the tree
// came back lighter and desaturated. `Kd` in an MTL is an **sRGB** display colour,
// but three.js treats both landing spots (a `color` BufferAttribute, and
// `new THREE.Color(r,g,b)`'s numeric form) as LINEAR and encodes them to sRGB at
// output — so an unconverted Kd was encoded twice. Measured on the rank-0 trunk:
// 176,141,87 became 216,196,158, drifting further on every extra trip.
describe('OBJ colour round-trip', () => {
  // three.js's output encode (WebGLRenderer outputColorSpace) — the last step
  // before the framebuffer, for a colour held in the linear working space.
  const linearToSrgbOut = (v: number) =>
    v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  // The REAL importer conversion, imported from utils/backendApi rather than
  // reimplemented here. That matters: a local copy would keep agreeing with the
  // exporter even if the shipped importer stopped converting — which is exactly
  // the bug this suite is about, so the test would have gone green through it.
  const importKd = srgbChannelToLinear;
  const toByte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);

  const kdOf = (mtl: string, material: string): number[] => {
    const block = mtl.slice(mtl.indexOf(`newmtl ${material}`));
    const m = block.match(/^Kd (\S+) (\S+) (\S+)$/m)!;
    return [+m[1], +m[2], +m[3]];
  };

  it('renders a re-imported QSM in the same pixels as the original', () => {
    const mtl = qsmToCylinderMeshObjBundle(fixtureQsm(), {
      baseName: 'tree',
      colorMode: 'rank',
    }).find(f => f.name.endsWith('.mtl'))!.text!;

    for (const rank of [0, 1]) {
      // What the VIEWPORT draws: QSM3D holds the palette linear (three.js's hex
      // parser decodes sRGB), and three.js encodes at output.
      const original = rankColorRgb(rank)
        .map(c => importKd(c))          // same transfer three.js's hex parse uses
        .map(linearToSrgbOut)
        .map(toByte);

      // What a RE-IMPORT draws: Kd -> importer converts to linear -> encoded out.
      const reimported = kdOf(mtl, `rank_${rank}`)
        .map(importKd)
        .map(linearToSrgbOut)
        .map(toByte);

      expect(reimported).toEqual(original);
    }
  });

  it('writes Kd in sRGB, not three.js linear', () => {
    // The concrete regression guard: the trunk's Kd is the palette's own sRGB
    // value (0xb0/255 = 0.690196). Writing the LINEAR channel (0.434) instead is
    // what made the re-imported tree wash out.
    const mtl = qsmToCylinderMeshObjBundle(fixtureQsm(), {
      baseName: 'tree',
      colorMode: 'rank',
    }).find(f => f.name.endsWith('.mtl'))!.text!;
    const [r, g, b] = kdOf(mtl, 'rank_0');
    expect(r).toBeCloseTo(0.690196, 5);
    expect(g).toBeCloseTo(0.552941, 5);
    expect(b).toBeCloseTo(0.341176, 5);
  });

  it('survives repeated round-trips without drifting', () => {
    // The failure compounds: each unconverted trip lightens the colour again. Ten
    // simulated round-trips must land exactly where one does.
    const start = rankColorRgb(0);
    let kd = [...start];
    for (let i = 0; i < 10; i++) {
      // import (sRGB Kd -> linear store), then export (linear -> sRGB Kd).
      kd = kd.map(importKd).map(linearToSrgbOut);
    }
    for (let i = 0; i < 3; i++) expect(kd[i]).toBeCloseTo(start[i], 6);
  });

  it('encodes leaf colours, which are stored linear, back to sRGB', () => {
    // Leaf materials come from meshExport's resolveMaterials, reading LINEAR
    // vertexColors — the opposite convention from the tube palette. Writing them
    // raw would make the foliage too dark and over-saturated (the same bug
    // mirrored), so the writer must encode exactly these and not the tube colours.
    const LEAF_LINEAR = 0.216;
    const q = {
      ...fixtureQsm(),
      leaves: {
        data: {
          vertices: new Float32Array([0, 0, 2, 1, 0, 2, 1, 1, 2]),
          indices: new Uint32Array([0, 1, 2]),
          vertexColors: new Float32Array(Array(9).fill(LEAF_LINEAR)),
          vertexCount: 3,
          triangleCount: 1,
        },
        plantMaterials: [
          { name: 'leaf', hasAlpha: false, triangleIndices: [0] },
        ],
        leafCount: 1,
      },
    } as QSMEntry;

    const mtl = qsmToCylinderMeshObjBundle(q, { baseName: 'tree', colorMode: 'rank' })
      .find(f => f.name.endsWith('.mtl'))!.text!;
    // 0.216 linear encodes to ~0.5 sRGB. Unconverted it would still read 0.216.
    // Compared at 4 dp: the colour is stored in a Float32Array, and that ulp of
    // rounding reaches the 6th decimal place of the encoded value.
    const [r] = kdOf(mtl, 'leaf');
    expect(r).toBeCloseTo(linearToSrgbOut(LEAF_LINEAR), 4);
    expect(r).not.toBeCloseTo(LEAF_LINEAR, 3);
  });
});
