import { describe, it, expect } from 'vitest';
import {
  qsmToCylinderCsv,
  qsmToCylinderMeshObj,
  qsmToCylinderMeshPly,
  sanitizeQsmFilename,
  qsmExtForFormat,
  cylinderTube,
  cylinderAxis,
  serializeQsm,
} from './qsmExport';
import type { QSMEntry } from './pointCloudTypes';
import type { QSMCylinder } from '../utils/backendApi';

const TUBE_SEGMENTS = 12;
// Per cylinder: 2 rings (2*segments) + 2 cap centers vertices.
const VERTS_PER_CYL = 2 * TUBE_SEGMENTS + 2;
// Per cylinder: 2 side tris + 1 bottom-cap tri + 1 top-cap tri, per segment.
const FACES_PER_CYL = 4 * TUBE_SEGMENTS;

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

describe('cylinderAxis / cylinderTube', () => {
  it('returns a unit axis for a non-degenerate cylinder', () => {
    const a = cylinderAxis(cyl({ start: [0, 0, 0], end: [0, 0, 2] }))!;
    expect(a).not.toBeNull();
    const len = Math.hypot(a[0], a[1], a[2]);
    expect(len).toBeCloseTo(1, 10);
    expect(a).toEqual([0, 0, 1]);
  });

  it('returns null for a zero-length cylinder', () => {
    expect(cylinderAxis(cyl({ start: [1, 1, 1], end: [1, 1, 1] }))).toBeNull();
    expect(cylinderTube(cyl({ start: [1, 1, 1], end: [1, 1, 1] }))).toBeNull();
  });

  it('returns null for a zero-radius cylinder', () => {
    expect(cylinderTube(cyl({ radius: 0 }))).toBeNull();
  });

  it('builds the expected vertex/face counts with in-range, finite indices', () => {
    const t = cylinderTube(cyl({}))!;
    expect(t.positions).toHaveLength(VERTS_PER_CYL);
    expect(t.faces).toHaveLength(FACES_PER_CYL);
    for (const f of t.faces) {
      for (const idx of f) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(t.positions.length);
      }
    }
    for (const p of t.positions) {
      for (const c of p) expect(Number.isFinite(c)).toBe(true);
    }
  });
});

describe('qsmToCylinderCsv', () => {
  const csv = qsmToCylinderCsv(fixtureQsm());
  const lines = csv.trim().split('\n');

  it('emits the exact SimpleForest-compatible header', () => {
    expect(lines[0]).toBe(
      'ID,parentID,branchID,branchOrder,startX,startY,startZ,endX,endY,endZ,' +
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

  it('computes a unit axis and correct length', () => {
    // cyl 0: start (0,0,0) end (0,0,1) -> axis (0,0,1), length 1
    const row = lines[1].split(',');
    expect(Number(row[10])).toBeCloseTo(0); // axisX
    expect(Number(row[11])).toBeCloseTo(0); // axisY
    expect(Number(row[12])).toBeCloseTo(1); // axisZ
    expect(Number(row[14])).toBeCloseTo(1); // length
  });

  it('renders null surf_cov / mad as empty fields', () => {
    const row = lines[3].split(','); // cyl 2 has null surf_cov + mad
    expect(row[15]).toBe(''); // surfaceCoverage
    expect(row[16]).toBe(''); // meanAbsDeviation
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

  it('emits v and f lines for every (non-degenerate) cylinder', () => {
    const vCount = lines.filter(l => l.startsWith('v ')).length;
    const fCount = lines.filter(l => l.startsWith('f ')).length;
    expect(vCount).toBe(3 * VERTS_PER_CYL);
    expect(fCount).toBe(3 * FACES_PER_CYL);
  });

  it('uses 1-based face indices within the total vertex range', () => {
    const totalV = 3 * VERTS_PER_CYL;
    for (const l of lines.filter(x => x.startsWith('f '))) {
      const idxs = l.slice(2).trim().split(/\s+/).map(Number);
      for (const i of idxs) {
        expect(i).toBeGreaterThanOrEqual(1);
        expect(i).toBeLessThanOrEqual(totalV);
      }
    }
  });

  it('skips degenerate cylinders', () => {
    const q = fixtureQsm();
    q.cylinders.push(cyl({ cyl_id: 9, start: [5, 5, 5], end: [5, 5, 5] })); // zero length
    const objD = qsmToCylinderMeshObj(q);
    const vCount = objD.trim().split('\n').filter(l => l.startsWith('v ')).length;
    expect(vCount).toBe(3 * VERTS_PER_CYL); // unchanged
  });
});

describe('qsmToCylinderMeshPly', () => {
  const ply = qsmToCylinderMeshPly(fixtureQsm());
  const lines = ply.trim().split('\n');

  it('declares vertex/face counts matching the body', () => {
    const vDecl = Number(lines.find(l => l.startsWith('element vertex'))!.split(' ')[2]);
    const fDecl = Number(lines.find(l => l.startsWith('element face'))!.split(' ')[2]);
    expect(vDecl).toBe(3 * VERTS_PER_CYL);
    expect(fDecl).toBe(3 * FACES_PER_CYL);

    const headerEnd = lines.indexOf('end_header');
    const body = lines.slice(headerEnd + 1);
    const vertexLines = body.slice(0, vDecl);
    const faceLines = body.slice(vDecl, vDecl + fDecl);
    expect(vertexLines).toHaveLength(vDecl);
    expect(faceLines).toHaveLength(fDecl);
  });

  it('attaches branch_order equal to the cylinder rank on each face', () => {
    const headerEnd = lines.indexOf('end_header');
    const vDecl = 3 * VERTS_PER_CYL;
    const faceLines = lines.slice(headerEnd + 1 + vDecl);
    // First cylinder (rank 0) contributes the first FACES_PER_CYL faces.
    const firstFace = faceLines[0].trim().split(/\s+/);
    // "3 i j k branch_order radius" -> 6 tokens
    expect(firstFace).toHaveLength(6);
    expect(firstFace[0]).toBe('3');
    expect(firstFace[4]).toBe('0'); // branch_order for rank-0 cylinder
    // The rank-1 cylinder is last; its faces should carry branch_order 1.
    const lastFace = faceLines[faceLines.length - 1].trim().split(/\s+/);
    expect(lastFace[4]).toBe('1');
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
