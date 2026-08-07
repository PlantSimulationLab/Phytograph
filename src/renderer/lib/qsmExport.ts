// QSM export serializers. Pure functions that turn a built QSMEntry into a file
// payload string. No DOM / IPC here so the logic stays unit-testable; the actual
// save-to-disk lives in PointCloudViewer (native dialog + fs via preload IPC).
//
// Three formats:
//   - csv : SimpleForest-compatible per-cylinder table. The de-facto
//           TreeQSM-interoperable interchange — rTwig (import_qsm) and aRchi
//           (read_QSM model="simpleforest") read this layout. Readers ignore
//           unknown trailing columns, so the surf-cov / mad quality columns are
//           safe extras beyond the SimpleForest core.
//   - obj : triangulated tube mesh (with normals), for Blender / CloudCompare /
//           MeshLab.
//   - ply : same geometry as OBJ, ASCII, with per-face branch_order + radius
//           so downstream viewers can color by branching order.
//
// The OBJ/PLY geometry is built by the SHARED tube builder in ./qsmTube, the same
// one the viewport renderer uses — so the exported mesh is the mesh the user saw.
// Previously these exporters emitted an independent capped cylinder per cylinder
// (world-referenced ring frames, unreconciled joints, stepped radii), which read as
// a pile of disjoint cylinders in Blender while the viewport showed a smooth tube.

import type { QSMEntry } from './pointCloudTypes';
import { buildShootPolylines, cylinderAxis, cylinderLength, sweepTube } from './qsmTube';
import type { Vec3 } from './qsmTube';

export type QSMExportFormat = 'csv' | 'obj' | 'ply';

// Radial segments per exported tube ring. Higher than the viewport's default 8:
// the viewport trades roundness for interactive framerate on a whole tree, while an
// export is written once and then lives in Blender/CloudCompare, where the extra
// fidelity is worth the file size.
const TUBE_SEGMENTS = 12;

// Re-exported for callers that already import these from here.
export { cylinderAxis, cylinderLength };

export function qsmExtForFormat(fmt: QSMExportFormat): string {
  return fmt; // 'csv' | 'obj' | 'ply' all double as the extension
}

// Strip characters that are unsafe in filenames across macOS/Windows, collapse
// whitespace, and trim. Also drops a trailing source extension (labels are often
// a source file name like 'tree.xyz', and the export appends its own .csv/.obj/
// .ply — so keeping it would suggest 'tree.xyz.csv'). Empty result falls back to
// 'qsm'.
export function sanitizeQsmFilename(name: string): string {
  const cleaned = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, '') // trailing source extension, if any
    .replace(/[/\\:*?"<>|]/g, '_') // path separators + Windows-reserved chars
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '') // no leading/trailing dots or underscores
    .trim();
  return cleaned.length > 0 ? cleaned : 'qsm';
}

// --- geometry ---------------------------------------------------------------

/**
 * One shoot's swept tube, plus the per-ring attributes the PLY needs. Rings map
 * 1:1 to polyline nodes, so a face's attributes come from the ring it starts on.
 */
interface ShootTube {
  positions: Vec3[];
  normals: Vec3[];
  faces: [number, number, number][];
  ringStride: number;
  shootId: number;
  rank: number;
  /** Per-node radius, indexed by ring. */
  radii: number[];
}

/**
 * Build the export geometry for a whole QSM: one continuous tube per shoot, via the
 * same shared builder the viewport renders. Shoots whose polyline is too short to
 * sweep are skipped.
 */
export function buildQsmTubes(qsm: QSMEntry, segments = TUBE_SEGMENTS): ShootTube[] {
  const out: ShootTube[] = [];
  for (const poly of buildShootPolylines(qsm.cylinders, qsm.shoots)) {
    const swept = sweepTube(poly.nodes, poly.radii, segments);
    if (!swept) continue;
    out.push({
      positions: swept.positions,
      normals: swept.normals,
      faces: swept.faces,
      ringStride: swept.ringStride,
      shootId: poly.shootId,
      rank: poly.rank,
      radii: poly.radii,
    });
  }
  return out;
}

// --- CSV --------------------------------------------------------------------

// SimpleForest column layout. Verified against rTwig's importer source
// (standardise_qsm / update_cylinders, SimpleForest branch): its detection gate
// needs ID/parentID/branchID/branchOrder, and its FIRST mutate unconditionally
// references segmentID + parentSegmentID — so those two are REQUIRED, not
// optional, for the file to load. segmentID maps to our continuous shoot, and
// parentSegmentID to that shoot's parent shoot (-1 for the trunk), matching the
// root convention in rTwig's bundled QSM.csv (root parentID = parentSegmentID =
// -1). growthLength / reverseBranchOrder are derived by rTwig when absent, so we
// leave them out. surfaceCoverage / meanAbsDeviation are our own quality extras
// (readers ignore unknown trailing columns).
const CSV_HEADER =
  'ID,parentID,branchID,branchOrder,segmentID,parentSegmentID,' +
  'startX,startY,startZ,endX,endY,endZ,' +
  'axisX,axisY,axisZ,radius,length,surfaceCoverage,meanAbsDeviation';

function num(x: number): string {
  // Compact but lossless enough for downstream tools; trims trailing zeros.
  return Number.isFinite(x) ? String(x) : '';
}

export function qsmToCylinderCsv(qsm: QSMEntry): string {
  // Parent-shoot lookup for parentSegmentID: each cylinder's shoot -> its parent
  // shoot id (-1 for the trunk / a root shoot).
  const parentShootByShoot = new Map<number, number>();
  for (const s of qsm.shoots) parentShootByShoot.set(s.shoot_id, s.parent_shoot_id);

  const lines: string[] = [CSV_HEADER];
  for (const c of qsm.cylinders) {
    const axis = cylinderAxis(c) ?? [0, 0, 0];
    const len = cylinderLength(c);
    const parentSegment = parentShootByShoot.has(c.shoot_id)
      ? parentShootByShoot.get(c.shoot_id)!
      : -1;
    lines.push(
      [
        c.cyl_id,
        c.parent_id,
        c.shoot_id,        // branchID
        c.rank,            // branchOrder
        c.shoot_id,        // segmentID — our continuous shoot is the segment
        parentSegment,     // parentSegmentID
        num(c.start[0]), num(c.start[1]), num(c.start[2]),
        num(c.end[0]), num(c.end[1]), num(c.end[2]),
        num(axis[0]), num(axis[1]), num(axis[2]),
        num(c.radius),
        num(len),
        c.surf_cov == null ? '' : num(c.surf_cov),
        c.mad == null ? '' : num(c.mad),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

// --- OBJ --------------------------------------------------------------------

// Each shoot becomes one OBJ group `o shoot_<id>_rank_<n>`, so the tree arrives in Blender
// as separable objects rather than one anonymous soup. Vertex normals are written
// (`vn` + `f v//vn`) because they're the smooth swept normals from the tube frame —
// without them a viewer computes flat per-face normals and the tube looks faceted
// even though the geometry is smooth.
export function qsmToCylinderMeshObj(qsm: QSMEntry): string {
  const tubes = buildQsmTubes(qsm);
  const lines: string[] = [
    `# Phytograph QSM tube mesh`,
    `# one continuous tube per shoot (matches the Phytograph viewport)`,
    `# cylinders: ${qsm.cylinders.length}  shoots: ${tubes.length}`,
  ];
  // OBJ v/vn indices are 1-based and accumulate across the whole file. Positions
  // and normals are parallel arrays here, so one offset serves both.
  let vOffset = 0;
  for (const t of tubes) {
    lines.push(`o shoot_${t.shootId}_rank_${t.rank}`);
    for (const p of t.positions) lines.push(`v ${p[0]} ${p[1]} ${p[2]}`);
    for (const nrm of t.normals) lines.push(`vn ${nrm[0]} ${nrm[1]} ${nrm[2]}`);
    for (const f of t.faces) {
      const a = f[0] + 1 + vOffset;
      const b = f[1] + 1 + vOffset;
      const c = f[2] + 1 + vOffset;
      lines.push(`f ${a}//${a} ${b}//${b} ${c}//${c}`);
    }
    vOffset += t.positions.length;
  }
  return lines.join('\n') + '\n';
}

// --- PLY --------------------------------------------------------------------

export function qsmToCylinderMeshPly(qsm: QSMEntry): string {
  const tubes = buildQsmTubes(qsm);
  const allPositions: Vec3[] = [];
  const allNormals: Vec3[] = [];
  // Each face carries the branch order of its shoot + the radius at the ring it
  // starts on. Radius is now per-node (it varies continuously along a shoot), so
  // unlike the old per-cylinder export there is no single radius for a whole tube.
  const allFaces: { tri: [number, number, number]; order: number; radius: number }[] = [];
  let vOffset = 0;
  for (const t of tubes) {
    for (const p of t.positions) allPositions.push(p);
    for (const nrm of t.normals) allNormals.push(nrm);
    for (const f of t.faces) {
      // Faces are emitted ring-pair by ring-pair; the lowest vertex index of a
      // triangle always lies on its starting ring.
      const ring = Math.floor(Math.min(f[0], f[1], f[2]) / t.ringStride);
      allFaces.push({
        tri: [f[0] + vOffset, f[1] + vOffset, f[2] + vOffset],
        order: t.rank,
        radius: t.radii[Math.min(ring, t.radii.length - 1)],
      });
    }
    vOffset += t.positions.length;
  }

  const header = [
    'ply',
    'format ascii 1.0',
    'comment Phytograph QSM tube mesh',
    'comment one continuous tube per shoot (matches the Phytograph viewport)',
    `element vertex ${allPositions.length}`,
    'property float x',
    'property float y',
    'property float z',
    'property float nx',
    'property float ny',
    'property float nz',
    `element face ${allFaces.length}`,
    'property list uchar int vertex_indices',
    'property uchar branch_order',
    'property float radius',
    'end_header',
  ];
  const body: string[] = [];
  for (let i = 0; i < allPositions.length; i++) {
    const p = allPositions[i];
    const nrm = allNormals[i];
    body.push(`${p[0]} ${p[1]} ${p[2]} ${nrm[0]} ${nrm[1]} ${nrm[2]}`);
  }
  for (const f of allFaces) {
    // branch_order is a uchar; clamp to [0,255] defensively.
    const order = Math.max(0, Math.min(255, Math.round(f.order)));
    body.push(`3 ${f.tri[0]} ${f.tri[1]} ${f.tri[2]} ${order} ${f.radius}`);
  }
  return header.concat(body).join('\n') + '\n';
}

// Dispatch helper used by the export handler.
export function serializeQsm(qsm: QSMEntry, fmt: QSMExportFormat): string {
  switch (fmt) {
    case 'csv':
      return qsmToCylinderCsv(qsm);
    case 'obj':
      return qsmToCylinderMeshObj(qsm);
    case 'ply':
      return qsmToCylinderMeshPly(qsm);
  }
}
