// Measurement tool — pure logic behind the CloudCompare-style ruler.
//
// The picker answers "what is this point?"; this answers "how far apart are
// these two things?", which is the question most users actually bring to a
// point cloud. Three kinds, all built from the same vertex list:
//
//   * distance — two points, the length between them plus ΔX/ΔY/ΔZ,
//   * polyline — N points, each segment's length and the running total,
//   * angle    — three points, the angle at the middle one.
//
// Same split as lib/pointPick.ts: everything here is pure (no three.js, no
// React, no DOM) so the arithmetic that produces the number a user will quote
// in a paper is unit-testable without a GL context.
//
// ── Units ──────────────────────────────────────────────────────────────────
//
// Lengths print in METRES, and say so. That is now a guarantee rather than an
// assumption: a cloud whose source declares another unit (a LAS CRS in US
// survey feet, say) is scaled at import, and a format that cannot declare one
// is asked in the import wizard, defaulting to metres. So every coordinate in
// the app is metres by construction — see backend `_scale_positions_to_metres`
// and `lib/units.ts`.
//
// This replaced a deliberate abstention: the readout used to print bare numbers
// precisely because nothing recorded what unit a file was in, and appending "m"
// would have asserted something unverified. The per-scan unit is what made the
// suffix honest.
//
// The precision ladder below is metre-calibrated (100 m is a stand, 1 mm is a
// twig) and is now correct by construction for the same reason.
import { csvCell, formatCoord } from './pointPick';
import type { Vec3 } from './pointPick';

export type MeasurementKind = 'distance' | 'polyline' | 'angle';

// One placed vertex. Carries the same two frames a PickedPoint does — `world`
// is what the user reads (true source-file coordinates), `local` is what the
// app renders from — plus the cloud it was picked on, which is what lets a
// vertex ride along when that cloud alone is transformed.
export interface MeasureVertex {
  world: Vec3;
  local: Vec3;
  cloudId: string;
}

export interface Measurement {
  id: string;
  // Stagger counter for the label overlay, mirroring PickedPoint.seq — kept out
  // of the array index so dismissing one doesn't reshuffle the survivors.
  seq: number;
  kind: MeasurementKind;
  vertices: MeasureVertex[];
  hasShift: boolean;
}

// How many vertices each kind needs before it can be committed. A polyline is
// open-ended, so it has a minimum rather than an exact count and is closed by
// the user (Enter / double-click) instead of by arity.
export const REQUIRED_VERTICES: Record<MeasurementKind, number> = {
  distance: 2,
  angle: 3,
  polyline: 2,
};

// True when a vertex list is long enough to be a valid measurement of `kind`.
export function isComplete(kind: MeasurementKind, vertexCount: number): boolean {
  return vertexCount >= REQUIRED_VERTICES[kind];
}

// True when placing one more vertex COMPLETES the measurement and it should be
// committed automatically. A polyline never auto-commits — it grows until the
// user closes it — which is the whole difference between it and a distance.
export function autoCommitsAt(kind: MeasurementKind, vertexCount: number): boolean {
  if (kind === 'polyline') return false;
  return vertexCount >= REQUIRED_VERTICES[kind];
}

// ── Geometry ───────────────────────────────────────────────────────────────
//
// All of it runs on `world`, not `local`. The two differ only by a constant
// per-cloud shift, so a same-cloud measurement is identical either way — but a
// measurement SPANNING two clouds with different shifts is only correct in
// world space, and that is exactly the case (scan-to-scan separation) a user
// reaches for a ruler to answer.

export interface Deltas {
  dx: number;
  dy: number;
  dz: number;
  dist: number;
}

export function deltas(a: Vec3, b: Vec3): Deltas {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return { dx, dy, dz, dist: Math.hypot(dx, dy, dz) };
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

// Per-segment lengths along a vertex list: N vertices → N−1 segments.
export function segmentLengths(vertices: MeasureVertex[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < vertices.length; i++) {
    out.push(distance(vertices[i - 1].world, vertices[i].world));
  }
  return out;
}

export function totalLength(vertices: MeasureVertex[]): number {
  let sum = 0;
  for (let i = 1; i < vertices.length; i++) {
    sum += distance(vertices[i - 1].world, vertices[i].world);
  }
  return sum;
}

// The angle at `vertex`, between the rays to `a` and `b`, in DEGREES on [0,180].
//
// Returns null rather than NaN when either arm has zero length — clicking the
// same point twice is an easy thing for a user to do, and `acos(0/0)` would
// otherwise propagate NaN into the readout. The caller prints an em dash.
//
// Uses atan2(|u×v|, u·v) rather than acos(u·v/|u||v|): the acos form loses
// precision badly near 0° and 180°, which are exactly the angles a user
// measures along a straight trunk or across a flat branch junction. atan2 is
// well-conditioned across the whole range.
export function angleAt(a: Vec3, vertex: Vec3, b: Vec3): number | null {
  const ux = a[0] - vertex[0], uy = a[1] - vertex[1], uz = a[2] - vertex[2];
  const vx = b[0] - vertex[0], vy = b[1] - vertex[1], vz = b[2] - vertex[2];
  const lu = Math.hypot(ux, uy, uz);
  const lv = Math.hypot(vx, vy, vz);
  if (lu === 0 || lv === 0) return null;

  const dot = ux * vx + uy * vy + uz * vz;
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  const cross = Math.hypot(cx, cy, cz);
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

// The angle of a 3-vertex measurement, or null for any other shape.
export function measurementAngle(m: Measurement): number | null {
  if (m.vertices.length !== 3) return null;
  return angleAt(m.vertices[0].world, m.vertices[1].world, m.vertices[2].world);
}

// Where a measurement's label should anchor, in LOCAL space (the frame the
// scene renders from — see PickedPointLabels on why anchors never use `world`).
//
//   distance → the midpoint of the segment, the way a dimension line is labelled
//   angle    → the vertex the angle is measured at
//   polyline → the last vertex, so the label trails the growing line rather
//              than jumping to a midpoint that moves with every new click
export function labelAnchor(m: Measurement): Vec3 | null {
  const vs = m.vertices;
  if (vs.length === 0) return null;
  if (m.kind === 'angle') return vs.length >= 2 ? vs[1].local : vs[0].local;
  if (m.kind === 'distance' && vs.length >= 2) {
    const a = vs[0].local;
    const b = vs[1].local;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  }
  return vs[vs.length - 1].local;
}

// ── Formatting ─────────────────────────────────────────────────────────────

// A length, at precision chosen from its magnitude.
//
// Fixed decimals fail at both ends of the range this app spans: a 120 m stand
// separation does not need 4 decimals of noise, and a 3 mm twig radius reads as
// "0.003" at the precision that suits the stand. Mirrors the `smartFormat`
// helper already used for the transform HUD. No unit suffix — see the module
// header.
export function formatLength(v: number): string {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 100) return v.toFixed(2);
  // 3 decimals runs all the way down to a millimetre rather than stopping at 1.
  // Sub-metre lengths are the common case in plant work, and a 25 cm span reads
  // as "0.250" — matching the coordinate rows in the same bubble, which are
  // also 3-decimal (formatCoord) — not "0.2500", which is a digit past what a
  // tolerance-limited pick can support.
  if (abs >= 0.001) return v.toFixed(3);
  // Below a millimetre, fixed notation would print a run of zeros.
  return v === 0 ? '0.000' : v.toExponential(3);
}

// An angle in degrees. One decimal is the useful resolution — a pick is
// tolerance-limited well before the second decimal means anything.
export function formatAngle(v: number | null): string {
  if (v === null || !isFinite(v)) return '—';
  return v.toFixed(1);
}

// The unit every length in this module is in. A constant rather than a literal
// sprinkled through the components, so the day a display-unit preference lands
// there is one place to change.
export const LENGTH_UNIT_SUFFIX = 'm';

// A length WITH its unit, for display. Kept separate from `formatLength` on
// purpose: the CSV and clipboard paths must stay numeric — a "1.250 m" cell is
// not a number any spreadsheet will sum — so the suffix is added at the display
// sites and nowhere else.
export function formatLengthWithUnit(v: number): string {
  const s = formatLength(v);
  return s === '—' ? s : `${s} ${LENGTH_UNIT_SUFFIX}`;
}

// A signed component delta. Same precision ladder as formatLength, but keeps
// the sign so ΔZ reads as a direction rather than a magnitude.
export function formatDelta(v: number): string {
  if (!isFinite(v)) return '—';
  const s = formatLength(Math.abs(v));
  return v < 0 ? `−${s}` : s;
}

// Human-readable name for a kind, for the label header and the panel.
export function kindLabel(kind: MeasurementKind): string {
  if (kind === 'distance') return 'Distance';
  if (kind === 'polyline') return 'Polyline';
  return 'Angle';
}

// The single headline number a measurement reports, already formatted. This is
// what the bubble shows large and what the CSV's `value` column carries.
export function primaryValue(m: Measurement): string {
  if (m.kind === 'angle') return formatAngle(measurementAngle(m));
  return formatLength(totalLength(m.vertices));
}

// ── Clipboard serialisation ────────────────────────────────────────────────

// `chord_*` rather than `dx/dy/dz`: for a distance the chord IS the
// measurement, but for a polyline it is the straight line from first vertex to
// last, which has nothing to do with the `total_length` beside it. Naming it
// honestly beats a column a reader would reasonably misread as the path's own
// components.
const CSV_COLUMNS = [
  'kind',
  'value',
  'vertices',
  'total_length',
  'angle_deg',
  'chord_dx', 'chord_dy', 'chord_dz',
];

// One row per measurement, followed by one row per vertex so the underlying
// coordinates travel with the numbers — a distance nobody can re-derive is not
// much use in a methods section. Vertex rows repeat the measurement id.
export function measurementsToCsv(measurements: Measurement[]): string {
  const header = ['id', ...CSV_COLUMNS, 'vertex_index', 'world_x', 'world_y', 'world_z'];
  const lines = [header.join(',')];

  for (const m of measurements) {
    const segs = segmentLengths(m.vertices);
    const ang = measurementAngle(m);
    const d = m.vertices.length >= 2
      ? deltas(m.vertices[0].world, m.vertices[m.vertices.length - 1].world)
      : null;

    lines.push([
      csvCell(m.id),
      csvCell(m.kind),
      csvCell(primaryValue(m)),
      String(m.vertices.length),
      segs.length > 0 ? formatLength(totalLength(m.vertices)) : '',
      ang === null ? '' : formatAngle(ang),
      d ? formatLength(d.dx) : '',
      d ? formatLength(d.dy) : '',
      d ? formatLength(d.dz) : '',
      '', '', '', '',
    ].join(','));

    for (let i = 0; i < m.vertices.length; i++) {
      const v = m.vertices[i];
      lines.push([
        csvCell(m.id),
        csvCell(m.kind),
        '', '', '', '', '', '', '',
        String(i),
        // formatCoord, NOT formatLength: a coordinate is not a length and must
        // not share its magnitude-adaptive ladder, which drops to 2 decimals
        // above 100 and would print a UTM easting a digit coarser than the
        // inspect bubble reports for the very same point.
        formatCoord(v.world[0]),
        formatCoord(v.world[1]),
        formatCoord(v.world[2]),
      ].join(','));
    }
  }
  return lines.join('\n');
}

// Human-readable single-measurement summary for the per-bubble copy button —
// the same content the bubble shows, one "label\tvalue" pair per line.
export function measurementToText(m: Measurement): string {
  const lines = [kindLabel(m.kind)];

  if (m.kind === 'angle') {
    lines.push(`angle\t${formatAngle(measurementAngle(m))}`);
    const segs = segmentLengths(m.vertices);
    segs.forEach((s, i) => lines.push(`arm ${i + 1}\t${formatLength(s)}`));
  } else {
    lines.push(`length\t${formatLength(totalLength(m.vertices))}`);
    if (m.kind === 'polyline') {
      const segs = segmentLengths(m.vertices);
      lines.push(`segments\t${segs.length}`);
      segs.forEach((s, i) => lines.push(`  seg ${i + 1}\t${formatLength(s)}`));
    } else if (m.vertices.length >= 2) {
      const d = deltas(m.vertices[0].world, m.vertices[1].world);
      lines.push(`dX\t${formatDelta(d.dx)}`);
      lines.push(`dY\t${formatDelta(d.dy)}`);
      lines.push(`dZ\t${formatDelta(d.dz)}`);
    }
  }

  const axes = ['X', 'Y', 'Z'];
  m.vertices.forEach((v, i) => {
    // formatCoord for the same reason as the CSV: coordinates keep millimetre
    // precision regardless of magnitude.
    const coords = axes.map((ax, k) => `${ax} ${formatCoord(v.world[k])}`).join('  ');
    lines.push(`P${i + 1}\t${coords}`);
  });
  return lines.join('\n');
}
