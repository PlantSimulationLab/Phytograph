// Crown-fit export: the per-crown table, and the mesh files that go beside it.
//
// The table is one row per fitted crown. It carries both the SUMMARY metrics
// (height, volume, bbox) and the fit PARAMETERS — the semi-axes / base radius /
// alpha radius that actually define the solid. The parameters are what make a
// row reproducible: without them the table describes a crown without recording
// it, which is why they're here at all.
//
// The alpha shape is the case the parameters can't cover. A concave hull has no
// analytic form — the mesh IS the model — so an alpha crown additionally gets a
// mesh file written next to the CSV and named in the row's `mesh_file` column.
// Parametric crowns need no such file and leave that cell empty.
//
// Naming reuses `objectFileSlug` / `exportBaseName` from exportObjects.ts rather
// than inventing a second slug dialect: those already mirror the backend's
// `_scan_label_slug` against a shared case table.

import type { CrownFitCrown } from '../utils/backendApi';
import type { CrownMeshFormat } from './crownFit';
import { objectFileSlug, exportBaseName } from './exportObjects';

/** One crown as it appears in the exported table. */
export interface CrownCsvRow {
  scanName: string;
  crown: CrownFitCrown;
  /** File name of this crown's mesh, relative to the CSV. Alpha crowns only. */
  meshFile?: string;
}

// Column order is the contract with anyone parsing the file — append, never
// reorder. `param_a_m`/`param_b_m`/`param_c_m` are the semi-extent along x/y/z
// for BOTH box-like shapes (the ellipsoid's semi-axes, the prism's half-extents),
// so a column means one thing regardless of the row's shape. There are no center
// columns because for all three parametric shapes the solid's center is exactly
// `crown_center_*` (the fitted mesh's AABB center).
export const CROWN_CSV_HEADER = [
  'scan_name', 'tree_instance_id', 'shape', 'tree_height_m', 'crown_volume_m3',
  'crown_center_x', 'crown_center_y', 'crown_center_z',
  'crown_dim_x_m', 'crown_dim_y_m', 'crown_dim_z_m',
  'crown_surface_area_m2', 'num_points_used', 'strictness',
  // Fit parameters. Blank where the shape has no such parameter.
  'param_a_m', 'param_b_m', 'param_c_m',
  'param_base_radius_m', 'param_height_m',
  'param_alpha_m', 'param_alpha_auto',
  // The mesh: its size, and (alpha only) the file carrying its geometry.
  'mesh_vertices', 'mesh_triangles', 'mesh_file',
] as const;

/** RFC4180 quoting: only cells containing a quote, comma or newline get wrapped. */
function esc(v: string): string {
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** A number as a fixed-4 cell, or an empty cell when the value doesn't apply. */
function num(v: number | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) : '';
}

/** An integer cell, or empty when absent (an older backend omits the counts). */
function int(v: number | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : '';
}

/** Build the crown table. `strictness` is the run-level fuzziness, repeated per row. */
export function buildCrownCsv(rows: CrownCsvRow[], strictness: number): string {
  const body = rows.map(({ scanName, crown, meshFile }) => {
    const m = crown.metrics;
    const p = crown.params ?? {};
    return [
      scanName, String(crown.tree_instance_id), crown.shape,
      num(m.tree_height_m), num(m.crown_volume_m3),
      num(m.crown_center[0]), num(m.crown_center[1]), num(m.crown_center[2]),
      num(m.crown_dims_m[0]), num(m.crown_dims_m[1]), num(m.crown_dims_m[2]),
      num(m.surface_area_m2), String(m.num_points_used), String(strictness),
      num(p.a_m), num(p.b_m), num(p.c_m),
      num(p.base_radius_m), num(p.height_m),
      num(p.alpha_m), p.alpha_auto === undefined ? '' : String(p.alpha_auto),
      int(m.num_vertices), int(m.num_triangles), meshFile ?? '',
    ];
  });
  return [CROWN_CSV_HEADER as readonly string[], ...body]
    .map(r => r.map(esc).join(',')).join('\n') + '\n';
}

/**
 * The base name for a crown export: what the user typed, or the scan's name when
 * they typed nothing. Deliberately NOT `exportBaseName('')`, whose fallback is
 * "scans" — a crown export that silently names itself after scans would be a lie.
 */
export function crownExportBaseName(typed: string, firstScanName: string): string {
  const raw = typed.trim() || firstScanName.trim();
  return raw ? exportBaseName(raw) : 'crowns';
}

/**
 * File name for one crown's mesh: `<base>_<scan>_tree<id>.<ext>`, or
 * `<base>_<scan>_crown.<ext>` when the whole cloud was fitted as one tree
 * (tree_instance_id 0). Deduped in-batch against `used` case-insensitively,
 * since macOS and Windows would otherwise let two crowns overwrite one file.
 * `used` is mutated with the returned name.
 */
export function crownMeshFileName(
  base: string, scanName: string, treeId: number, ext: CrownMeshFormat, used: Set<string>,
): string {
  const suffix = treeId > 0 ? `tree${treeId}` : 'crown';
  const stem = `${base}_${objectFileSlug(scanName, 0)}_${suffix}`;
  let candidate = `${stem}.${ext}`;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem}_${n}.${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** Join a directory and a file name with the separator that directory already uses. */
export function joinExportPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}
