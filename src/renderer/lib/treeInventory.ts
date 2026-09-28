// Tree inventory: the table, its CSV exports, and the viewer geometry.
//
// Everything here is pure: the backend measures (POST .../tree_inventory, method
// in docs/docs/concepts/tree-inventory.md) and this module turns its rows into
// what the Tree Table panel shows and saves. The user's own per-tree entries
// (species, status, label) live beside the measurements, keyed by tree id, so a
// re-run keeps them for the trees it finds again.

import type { TreeInventoryTree, StemCurveRow, TreeQSMResult } from '../utils/backendApi';
import { csvCell } from './pointPick';

export type TreeStatus = '' | 'live' | 'dead' | 'damaged' | 'uncertain';
export const TREE_STATUSES: TreeStatus[] = ['', 'live', 'dead', 'damaged', 'uncertain'];

export interface TreeEdit {
  species: string;
  status: TreeStatus;
  label: string;
}

export type TreeEdits = Record<number, TreeEdit>;

export const EMPTY_TREE_EDIT: TreeEdit = { species: '', status: '', label: '' };

type Vec3 = [number, number, number];

/** A sortable, displayable numeric column of the tree table. */
export interface TreeColumn {
  id: string;
  header: string;
  /** Tooltip: what the number is. */
  title: string;
  digits: number;
  get: (t: TreeInventoryTree) => number | null | undefined;
}

export const TREE_TABLE_COLUMNS: TreeColumn[] = [
  { id: 'tree_id', header: 'Tree', title: 'tree_instance id', digits: 0, get: t => t.tree_id },
  { id: 'dbh_cm', header: 'DBH cm', title: 'Diameter at breast height', digits: 1, get: t => (t.dbh_m == null ? null : t.dbh_m * 100) },
  { id: 'height_m', header: 'H m', title: 'Height above the stem-base ground', digits: 2, get: t => t.height_m },
  { id: 'crown_base_height_m', header: 'CBH m', title: 'Crown base height', digits: 2, get: t => t.crown_base_height_m },
  { id: 'crown_diameter_mean_m', header: 'Crown ⌀ m', title: 'Mean crown diameter (widest width and the width at right angles)', digits: 2, get: t => t.crown_diameter_mean_m },
  { id: 'crown_projected_area_m2', header: 'CPA m²', title: 'Crown projected area (convex hull)', digits: 1, get: t => t.crown_projected_area_m2 },
  { id: 'lean_deg', header: 'Lean °', title: 'Stem lean from vertical', digits: 1, get: t => t.lean_deg },
  { id: 'basal_area_m2', header: 'BA m²', title: 'Basal area π/4·DBH²', digits: 4, get: t => t.basal_area_m2 },
  { id: 'slenderness', header: 'H/D', title: 'Slenderness: height / DBH', digits: 0, get: t => t.slenderness },
  { id: 'hegyi_index', header: 'CI', title: "Hegyi's competition index (higher = more crowded)", digits: 2, get: t => t.hegyi_index },
  { id: 'crown_overlap_pct', header: 'Overlap %', title: 'Share of the crown projection covered by other crowns', digits: 0, get: t => (t.crown_overlap_fraction == null ? null : t.crown_overlap_fraction * 100) },
];

export type SortDir = 'asc' | 'desc';

/**
 * Sort trees by a column. Missing values sort LAST in both directions: a tree
 * with no DBH is not "the smallest", and flipping the direction should not
 * move the unmeasured rows to the top. Ties break on tree id, so the order is
 * stable across re-renders.
 */
export function sortTrees(
  trees: TreeInventoryTree[], columnId: string, dir: SortDir, columns: TreeColumn[] = TREE_TABLE_COLUMNS,
): TreeInventoryTree[] {
  const col = columns.find(c => c.id === columnId) ?? columns[0];
  const sign = dir === 'asc' ? 1 : -1;
  return [...trees].sort((a, b) => {
    const va = col.get(a);
    const vb = col.get(b);
    const na = va == null || !Number.isFinite(va);
    const nb = vb == null || !Number.isFinite(vb);
    if (na !== nb) return na ? 1 : -1;
    if (!na && !nb && va !== vb) return sign * ((va as number) - (vb as number));
    return a.tree_id - b.tree_id;
  });
}

/** How far a stem base may move between runs and still be the same tree (m). */
export const SAME_TREE_TOLERANCE_M = 0.5;

/**
 * Keep the user's entries for trees a re-run found again, and only those.
 * "Found again" means the same id AND a stem base within
 * SAME_TREE_TOLERANCE_M of where it was: re-running Segment Trees renumbers
 * the instances, and matching on the id alone would silently move a species
 * onto a different tree. `dropped` counts entries that did not survive.
 */
export function carryOverEdits(
  prevTrees: TreeInventoryTree[], prev: TreeEdits, trees: TreeInventoryTree[],
): { edits: TreeEdits; dropped: number } {
  const before = new Map(prevTrees.map(t => [t.tree_id, t]));
  const edits: TreeEdits = {};
  for (const t of trees) {
    const e = prev[t.tree_id];
    const was = before.get(t.tree_id);
    if (!e || !was) continue;
    const a = was.stem_base, b = t.stem_base;
    const same = a && b
      ? Math.hypot(a[0] - b[0], a[1] - b[1]) <= SAME_TREE_TOLERANCE_M
      : !a && !b;
    if (same) edits[t.tree_id] = e;
  }
  const dropped = Object.keys(prev).filter(k => !(Number(k) in edits)).length;
  return { edits, dropped };
}

/** Human wording for the quality flags the backend raises. */
export const TREE_FLAG_TEXT: Record<string, string> = {
  few_points: 'few stem points at breast height',
  partial_arc: 'less than half the stem circumference seen',
  high_residual: 'noisy circle fit',
  no_stem: 'no stem found at breast height',
  ground_from_tree_min: 'no ground data; heights from the tree’s lowest point',
  too_few_points: 'too few points',
};

export function describeFlags(flags: string[]): string {
  return flags.map(f => TREE_FLAG_TEXT[f] ?? f).join('; ');
}

// ---------------------------------------------------------------- CSV ------

function num(v: number | null | undefined, digits = 4): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '';
}

// Column order is the contract with anyone parsing the file: append, never
// reorder. Lengths are meters, areas m², volumes m³, angles degrees;
// coordinates are world coordinates.
export const TREE_LIST_CSV_HEADER = [
  'scan_name', 'tree_id', 'species', 'status', 'label',
  'stem_x', 'stem_y', 'ground_z',
  'dbh_m', 'dbh_rms_m', 'dbh_arc_coverage', 'dbh_max_gap_deg', 'dbh_n_inliers', 'dbh_method',
  'breast_height_ref_z',
  'height_m', 'lean_deg', 'lean_azimuth_deg',
  'crown_base_height_m', 'crown_projected_area_m2',
  'crown_diameter_mean_m', 'crown_diameter_equiv_m', 'crown_max_width_m', 'crown_perp_width_m',
  'crown_ellipse_eccentricity', 'crown_offset_m', 'crown_offset_azimuth_deg',
  'crown_volume_voxel_m3', 'basal_area_m2', 'slenderness',
  'ground_source', 'n_points', 'flags',
  // Competition (appended with the stand metrics).
  'hegyi_index', 'n_competitors', 'crown_overlap_m2', 'crown_overlap_fraction', 'edge',
  // QSM and biomass: filled when a batch QSM ran / a biomass method is chosen.
  'qsm_woody_volume_m3', 'agb_kg', 'agb_method',
] as const;

/** Per-tree values that come from later steps rather than the inventory run. */
export interface TreeListExtras {
  qsmVolumes?: Record<number, number>;
  biomassKg?: Record<number, number | null>;
  biomassMethod?: string;
}

export function buildTreeListCsv(
  scanName: string, trees: TreeInventoryTree[], edits: TreeEdits, extras: TreeListExtras = {},
): string {
  const rows = trees.map(t => {
    const e = edits[t.tree_id] ?? EMPTY_TREE_EDIT;
    const d = t.dbh ?? null;
    return [
      scanName, String(t.tree_id), e.species, e.status, e.label,
      num(t.stem_base?.[0]), num(t.stem_base?.[1]), num(t.ground_z),
      num(t.dbh_m), num(d?.rms_m), num(d?.arc_coverage, 3), num(d?.max_gap_deg, 1),
      d ? String(d.n_inliers) : '', d?.method ?? '',
      num(t.breast_height_ref_z),
      num(t.height_m), num(t.lean_deg, 2), num(t.lean_azimuth_deg, 1),
      num(t.crown_base_height_m), num(t.crown_projected_area_m2),
      num(t.crown_diameter_mean_m), num(t.crown_diameter_equiv_m),
      num(t.crown_max_width_m), num(t.crown_perp_width_m),
      num(t.crown_ellipse_eccentricity), num(t.crown_offset_m), num(t.crown_offset_azimuth_deg, 1),
      num(t.crown_volume_voxel_m3), num(t.basal_area_m2, 6), num(t.slenderness, 2),
      t.ground_source ?? '', String(t.n_points), (t.flags ?? []).join(';'),
      num(t.hegyi_index), t.n_competitors == null ? '' : String(t.n_competitors),
      num(t.crown_overlap_m2), num(t.crown_overlap_fraction, 3),
      t.edge == null ? '' : String(t.edge),
      num(extras.qsmVolumes?.[t.tree_id], 5),
      num(extras.biomassKg?.[t.tree_id] ?? null, 2),
      // The method only where it produced a value: a tree outside the stand
      // filter, or one the method cannot estimate, has neither.
      extras.biomassMethod && extras.biomassKg?.[t.tree_id] != null ? extras.biomassMethod : '',
    ];
  });
  return [TREE_LIST_CSV_HEADER as readonly string[], ...rows]
    .map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

export const STEM_CURVE_CSV_HEADER = [
  'scan_name', 'tree_id', 'axial_m', 'height_m', 'x', 'y', 'z',
  'diameter_m', 'rms_m', 'arc_coverage', 'n_points', 'ok',
] as const;

export function buildStemCurveCsv(scanName: string, rows: StemCurveRow[]): string {
  const sorted = [...rows].sort((a, b) => a.tree_id - b.tree_id || a.axial_m - b.axial_m);
  const body = sorted.map(r => [
    scanName, String(r.tree_id), num(r.axial_m, 3), num(r.height_m, 3),
    num(r.x), num(r.y), num(r.z), num(r.diameter_m), num(r.rms_m), num(r.arc_coverage, 3),
    String(r.n_points), r.ok ? 'true' : 'false',
  ]);
  return [STEM_CURVE_CSV_HEADER as readonly string[], ...body]
    .map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

export const TREE_QSM_CSV_HEADER = [
  'scan_name', 'tree_id', 'success', 'error', 'points_in_tree', 'points_used', 'voxel_m', 'wood_only',
  'n_cylinders', 'n_shoots', 'total_woody_volume_m3', 'stem_volume_m3', 'branch_volume_m3',
  'trunk_diameter_mm', 'tcsa_m2', 'tree_height_m', 'total_length_m', 'n_scaffolds',
  'n_shoots_total', 'max_rank', 'canopy_width_m', 'canopy_height_m',
] as const;

/** One row per tree of a batch QSM, failed trees included with their error. */
export function buildTreeQsmCsv(scanName: string, results: TreeQSMResult[]): string {
  const rows = [...results].sort((a, b) => a.tree_id - b.tree_id).map(r => {
    const m = r.metrics;
    return [
      scanName, String(r.tree_id), String(r.success), r.error ?? '',
      String(r.points_in_tree), String(r.points_used), num(r.voxel_m, 4), String(r.wood_only),
      String(r.n_cylinders), String(r.n_shoots),
      num(m?.total_woody_volume_m3, 6), num(m?.stem_volume_m3, 6), num(m?.branch_volume_m3, 6),
      num(m?.trunk_diameter_mm, 1), num(m?.tcsa_m2, 6), num(m?.tree_height_m, 3),
      num(m?.total_length_m, 3), m ? String(m.n_scaffolds) : '', m ? String(m.n_shoots_total) : '',
      m ? String(m.max_rank) : '', num(m?.canopy_width_m, 3), num(m?.canopy_height_m, 3),
    ];
  });
  return [TREE_QSM_CSV_HEADER as readonly string[], ...rows]
    .map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

// ------------------------------------------------------------- viewer ------

/**
 * The box to frame for one tree, in the frame `__frameSelection` takes: the
 * cloud's STORED frame (world − worldShift), which is where the cloud draws
 * before the display offset. Centered horizontally on the STEM BASE when there
 * is one, not on the points' bounding box: a few stray points from a
 * neighbor (segmentation is never perfect) drag a bbox center meters away,
 * while the stem base is the tree's position. Null when the tree has no extent.
 */
export function treeFrameTarget(
  t: TreeInventoryTree, worldShift: Vec3 = [0, 0, 0],
): { center: Vec3; size: Vec3 } | null {
  if (!t.bbox_min || !t.bbox_max) return null;
  const center: Vec3 = [0, 1, 2].map(i => (t.bbox_min![i] + t.bbox_max![i]) / 2 - worldShift[i]) as Vec3;
  if (t.stem_base) {
    center[0] = t.stem_base[0] - worldShift[0];
    center[1] = t.stem_base[1] - worldShift[1];
  }
  const size: Vec3 = [0, 1, 2].map(i => Math.max(0.5, t.bbox_max![i] - t.bbox_min![i])) as Vec3;
  return { center, size };
}

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Line-segment vertices (pairs) for one tree's overlay in DISPLAY space
 * (world − worldShift − displayOffset), computed in float64 before the
 * float32 buffer so UTM-scale coordinates keep millimeter precision:
 *
 *  - the DBH circle, in the plane perpendicular to the stem axis;
 *  - a stem-base cross on the ground, sized to the stem;
 *  - the stem axis from the base up to breast height.
 */
export function treeOverlaySegments(
  t: TreeInventoryTree, worldShift: Vec3, displayOffset: Vec3, segments = 48,
): number[] {
  const out: number[] = [];
  const off: Vec3 = [worldShift[0] + displayOffset[0], worldShift[1] + displayOffset[1], worldShift[2] + displayOffset[2]];
  const push = (p: Vec3) => { const q = sub(p, off); out.push(q[0], q[1], q[2]); };
  const axis = normalize(t.stem_axis ?? [0, 0, 1]);
  const helper: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(axis, helper));
  const v = cross(axis, u);

  if (t.dbh && t.dbh.diameter_m > 0) {
    const c = t.dbh.center;
    const r = t.dbh.diameter_m / 2;
    const at = (k: number): Vec3 => {
      const a = (2 * Math.PI * k) / segments;
      const cu = Math.cos(a) * r, sv = Math.sin(a) * r;
      return [c[0] + cu * u[0] + sv * v[0], c[1] + cu * u[1] + sv * v[1], c[2] + cu * u[2] + sv * v[2]];
    };
    for (let k = 0; k < segments; k++) { push(at(k)); push(at(k + 1)); }
  }
  if (t.stem_base) {
    const b = t.stem_base;
    const arm = Math.max(0.15, (t.dbh_m ?? 0.2));
    push([b[0] - arm, b[1], b[2]]); push([b[0] + arm, b[1], b[2]]);
    push([b[0], b[1] - arm, b[2]]); push([b[0], b[1] + arm, b[2]]);
    if (t.dbh) { push(b); push(t.dbh.center); }
  }
  return out;
}
