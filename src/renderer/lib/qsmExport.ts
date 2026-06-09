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
//   - obj : triangulated cylinder mesh, for Blender / CloudCompare / MeshLab.
//   - ply : same geometry as OBJ, ASCII, with per-face branch_order + radius
//           so downstream viewers can color by branching order.

import type { QSMEntry } from './pointCloudTypes';
import type { QSMCylinder } from '../utils/backendApi';

export type QSMExportFormat = 'csv' | 'obj' | 'ply';

// Radial segments per cylinder tube. 12 is a good balance of fidelity vs file
// size for the visualization exports.
const TUBE_SEGMENTS = 12;

export function qsmExtForFormat(fmt: QSMExportFormat): string {
  return fmt; // 'csv' | 'obj' | 'ply' all double as the extension
}

// Strip characters that are unsafe in filenames across macOS/Windows, collapse
// whitespace, and trim. Empty result falls back to 'qsm'.
export function sanitizeQsmFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, '_') // path separators + Windows-reserved chars
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '') // no leading/trailing dots or underscores
    .trim();
  return cleaned.length > 0 ? cleaned : 'qsm';
}

// --- geometry ---------------------------------------------------------------

function sub(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function norm(v: readonly number[]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: readonly number[]): [number, number, number] {
  const n = norm(v);
  if (n === 0) return [0, 0, 0];
  return [v[0] / n, v[1] / n, v[2] / n];
}

// Unit cylinder axis from start->end. Returns null for degenerate cylinders.
export function cylinderAxis(c: QSMCylinder): [number, number, number] | null {
  const d = sub(c.end, c.start);
  const n = norm(d);
  if (n === 0) return null;
  return [d[0] / n, d[1] / n, d[2] / n];
}

export function cylinderLength(c: QSMCylinder): number {
  return norm(sub(c.end, c.start));
}

interface TubeMesh {
  positions: [number, number, number][];
  // 1-based-agnostic triangle indices into `positions` (0-based here).
  faces: [number, number, number][];
}

// Build a capped tube between start and end with the given radius. Returns null
// for degenerate cylinders (zero length or non-positive radius).
export function cylinderTube(
  c: QSMCylinder,
  segments = TUBE_SEGMENTS,
): TubeMesh | null {
  const axis = cylinderAxis(c);
  if (!axis || c.radius <= 0) return null;

  // Two perpendiculars to the axis form the ring basis. Pick a reference that
  // isn't parallel to the axis.
  const ref: [number, number, number] =
    Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(axis, ref));
  const v = normalize(cross(axis, u));

  const positions: [number, number, number][] = [];
  // Ring vertices: bottom ring [0..segments-1], top ring [segments..2*segments-1].
  for (const center of [c.start, c.end]) {
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      const cosA = Math.cos(a) * c.radius;
      const sinA = Math.sin(a) * c.radius;
      positions.push([
        center[0] + u[0] * cosA + v[0] * sinA,
        center[1] + u[1] * cosA + v[1] * sinA,
        center[2] + u[2] * cosA + v[2] * sinA,
      ]);
    }
  }
  // Cap centers.
  const bottomCenter = positions.length;
  positions.push([c.start[0], c.start[1], c.start[2]]);
  const topCenter = positions.length;
  positions.push([c.end[0], c.end[1], c.end[2]]);

  const faces: [number, number, number][] = [];
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    const b0 = i;
    const b1 = next;
    const t0 = segments + i;
    const t1 = segments + next;
    // Side quad -> two triangles (outward winding).
    faces.push([b0, t0, t1]);
    faces.push([b0, t1, b1]);
    // Bottom cap fan.
    faces.push([bottomCenter, b1, b0]);
    // Top cap fan.
    faces.push([topCenter, t0, t1]);
  }
  return { positions, faces };
}

// --- CSV --------------------------------------------------------------------

// SimpleForest core columns + two quality extras (surfaceCoverage, meanAbsDeviation).
const CSV_HEADER =
  'ID,parentID,branchID,branchOrder,startX,startY,startZ,endX,endY,endZ,' +
  'axisX,axisY,axisZ,radius,length,surfaceCoverage,meanAbsDeviation';

function num(x: number): string {
  // Compact but lossless enough for downstream tools; trims trailing zeros.
  return Number.isFinite(x) ? String(x) : '';
}

export function qsmToCylinderCsv(qsm: QSMEntry): string {
  const lines: string[] = [CSV_HEADER];
  for (const c of qsm.cylinders) {
    const axis = cylinderAxis(c) ?? [0, 0, 0];
    const len = cylinderLength(c);
    lines.push(
      [
        c.cyl_id,
        c.parent_id,
        c.shoot_id,
        c.rank,
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

export function qsmToCylinderMeshObj(qsm: QSMEntry): string {
  const lines: string[] = [
    `# Phytograph QSM cylinder mesh`,
    `# cylinders: ${qsm.cylinders.length}`,
  ];
  let vOffset = 0; // OBJ vertex indices are 1-based and accumulate across cylinders
  for (const c of qsm.cylinders) {
    const tube = cylinderTube(c);
    if (!tube) continue;
    for (const p of tube.positions) {
      lines.push(`v ${p[0]} ${p[1]} ${p[2]}`);
    }
    for (const f of tube.faces) {
      lines.push(`f ${f[0] + 1 + vOffset} ${f[1] + 1 + vOffset} ${f[2] + 1 + vOffset}`);
    }
    vOffset += tube.positions.length;
  }
  return lines.join('\n') + '\n';
}

// --- PLY --------------------------------------------------------------------

export function qsmToCylinderMeshPly(qsm: QSMEntry): string {
  const allPositions: [number, number, number][] = [];
  // Each face carries the branch order + radius of the cylinder it came from.
  const allFaces: { tri: [number, number, number]; order: number; radius: number }[] = [];
  let vOffset = 0;
  for (const c of qsm.cylinders) {
    const tube = cylinderTube(c);
    if (!tube) continue;
    for (const p of tube.positions) allPositions.push(p);
    for (const f of tube.faces) {
      allFaces.push({
        tri: [f[0] + vOffset, f[1] + vOffset, f[2] + vOffset],
        order: c.rank,
        radius: c.radius,
      });
    }
    vOffset += tube.positions.length;
  }

  const header = [
    'ply',
    'format ascii 1.0',
    'comment Phytograph QSM cylinder mesh',
    `element vertex ${allPositions.length}`,
    'property float x',
    'property float y',
    'property float z',
    `element face ${allFaces.length}`,
    'property list uchar int vertex_indices',
    'property uchar branch_order',
    'property float radius',
    'end_header',
  ];
  const body: string[] = [];
  for (const p of allPositions) body.push(`${p[0]} ${p[1]} ${p[2]}`);
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
