// Pure model behind the point-cloud import options: the per-scan config the
// options panel edits, the helpers that turn it into what the importer needs,
// and the edit functions both hosts share. Two hosts render it — the modal
// PointCloudImportWizard (drag-drop, Open-With, Helios XML, RIEGL) and the
// in-app file browser (File -> Import) — so the logic lives here, once.
import type {
  PointCloudPreviewResponse,
  PreviewColumn,
  ColumnPlan,
  ColumnPlanEntry,
} from '../utils/backendApi';
import type { ScanParameters } from './scanParameters';
import type { PoseStream } from './poseStream';
import { hasRegisteredScheme } from './classification';
import { DEFAULT_UNIT, isLengthUnit, metersPerUnit, type LengthUnit } from './units';


// One scan to walk the user through. `path` is REQUIRED — the wizard previews
// by reading the file on disk; callers without a path (Blob fixtures) should
// bypass the wizard. `asciiFormatHint`/`params` ride along from a Helios XML
// import so the eventual Scan can carry them.
export interface WizardScanInput {
  path: string;
  fileName: string;
  asciiFormatHint?: string | null;
  params?: ScanParameters;
  label?: string;
  color?: string;
}

// What the wizard hands back per scan. App turns these into actual Scans by
// calling parsePointCloudFromPath(path, asciiFormat, columnPlan, categoricalSlugs).
export interface WizardResult {
  input: WizardScanInput;
  asciiFormat: string | null;
  columnPlan: ColumnPlan | null;   // null → let the backend auto-detect
  categoricalSlugs: string[];
  // Slugs the user forced to "Scalar" that would otherwise color categorically
  // by name (e.g. a Miss Flag downgraded to Scalar — it keeps the is_miss slug
  // for LAD, but the user wants a continuous gradient, not the Hit/Miss scheme).
  // App registers these as continuous overrides after import.
  continuousSlugs: string[];
  // Slugs the user unticked on an IN-FILE format (LAS/LAZ/PLY/PCD/E57/PTX),
  // where the column layout is fixed by the file so a positional ColumnPlan has
  // nothing to bind to (and `columnPlan` is null anyway). The backend drops
  // these from the session's extras by name. ASCII skips do NOT appear here —
  // they ride the plan as role 'skip'.
  droppedSlugs: string[];
  // `{source_slug: role}` for in-file formats — the columns the user reassigned
  // in the wizard. Empty for a no-edit import, which then behaves exactly as
  // before (pure backend auto-detection).
  roleOverrides?: Record<string, string>;
  // `{source_slug: label}` for in-file scalar columns the user renamed. The
  // slug is the file's own and stays; only the display label changes. ASCII
  // renames ride `columnPlan` instead. Empty for a no-edit import.
  scalarLabels?: Record<string, string>;
  // The complement of `droppedSlugs` — the in-file slugs still ticked. Only the
  // RIEGL extract path uses it, because that endpoint takes a keep list.
  keptSlugs: string[];
  // CloudCompare-style global shift [x, y, z] to SUBTRACT from every point at
  // import, or null to keep the original coordinates. Auto-suggested from the
  // preview for large (e.g. UTM) clouds; the user can edit or disable it.
  worldShift: [number, number, number] | null;
  // The unit the SOURCE file's coordinates are in. The backend scales positions
  // to meters at import using this, so it is a scale factor, not a label.
  // Always set — 'm' when the format declared meters, when the user left the
  // default, or when nothing could be detected.
  units: LengthUnit;
  // Mobile-platform trajectory to attach to this scan, or null for a static
  // (tripod) capture. When set, the imported Scan becomes a moving-platform
  // acquisition: its scan parameters carry this PoseStream so leaf-area
  // inversion reconstructs a per-beam origin per return (joined by timestamp).
  trajectory: PoseStream | null;
}

// Roles the user can assign to a column in the role dropdown. 'extra' = carry as
// a named scalar field; 'skip' = drop. r/g/b scale is handled by a separate
// per-scan toggle, so the dropdown only exposes the generic 'rgb' members.
// 'extra' = a continuous scalar field (gradient); 'label' = a categorical
// class field (discrete colors + legend). Both become an octree extra dim;
// they differ only in how the renderer colors them. 'skip' = drop. RGB scale
// is handled by a separate per-scan toggle, so the dropdown exposes plain r/g/b.
export const ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'x', label: 'X' },
  { value: 'y', label: 'Y' },
  { value: 'z', label: 'Z' },
  { value: 'r', label: 'Red' },
  { value: 'g', label: 'Green' },
  { value: 'b', label: 'Blue' },
  { value: 'intensity', label: 'Intensity' },
  { value: 'reflectance', label: 'Reflectance' },
  { value: 'timestamp', label: 'Timestamp' },
  { value: 'target_index', label: 'Target Index' },
  { value: 'target_count', label: 'Target Count' },
  { value: 'row_index', label: 'Scan Row Index' },
  { value: 'column_index', label: 'Scan Column Index' },
  { value: 'is_miss', label: 'Miss Flag' },
  { value: 'origin_x', label: 'Beam Origin X' },
  { value: 'origin_y', label: 'Beam Origin Y' },
  { value: 'origin_z', label: 'Beam Origin Z' },
  { value: 'extra', label: 'Scalar' },
  { value: 'label', label: 'Label' },
  { value: 'skip', label: 'Skip' },
];
// 'timestamp'/'target_index'/'target_count' are the per-pulse multi-return
// columns: the GPS/scan time of each return, its 1-based index within its pulse
// (1st/2nd/… return), and the pulse's total return count. LAS auto-maps these
// from return_number/number_of_returns/gps_time, but a header-less or oddly
// labeled ASCII column won't auto-detect (the backend only recognizes exact
// aliases like Timestamp/TargetIndex/ReturnNumber/NumberOfReturns), so these
// dropdown roles let the user assign them explicitly. Like the grid/miss roles
// they pass straight through buildColumnPlan as their own role token; the backend
// pins the canonical 'timestamp'/'target_index'/'target_count' slug (regardless
// of source spelling) so gap-filling / LAD / multi-return triangulation find them
// by name. They are per-pulse numeric fields, never categorical class fields —
// so no rename box (not in SCALAR_ROLES).
//
// 'row_index'/'column_index' are structured-scan raster indices: integer (row,
// column) positions within the scanner's rectangular acquisition grid. They
// pass straight through buildColumnPlan as their own role token — the backend
// pins them to canonical extra-dim slugs so the gap-filling / miss-recovery
// path can reconstruct the raster — so they need no rename box and aren't in
// SCALAR_ROLES below.
//
// 'is_miss' is the sky/miss flag (0 = return/hit, 1 = miss): a per-pulse 0/1
// indicator that the laser returned nothing. Like the grid indices it passes
// through as its own role token; the backend pins the canonical 'is_miss' slug
// (regardless of the source spelling is_miss/miss/sky) so the LAD path and the
// renderer's fixed Hit/Miss color scheme find it by name. It is NOT a scalar
// (no rename box) and NOT categorical-toggleable — the renderer always colors
// it with the dedicated Hit/Miss scheme, so it's excluded from SCALAR_ROLES.
//
// 'origin_x'/'origin_y'/'origin_z' are the per-pulse beam-emission origin (the
// laser's position for each return), in the same world frame as x/y/z. Mapping
// all three makes the cloud carry GROUND-TRUTH origins that the LAD inversion
// uses directly, bypassing the timestamp->trajectory join — exactly like the LAS
// ExtraBytes ox/oy/oz path. Like the grid/miss roles they pass straight through
// buildColumnPlan as their own role token; the backend captures them at full
// float64 precision into a side-channel (NOT as float32 extra dims, which would
// corrupt world/UTM coordinates), so they need no rename box and aren't in
// SCALAR_ROLES.

// Roles that carry a named scalar field (and so get a rename box). 'label' is
// the categorical variant of 'extra'.
export const SCALAR_ROLES = new Set(['extra', 'label']);

// Geometry roles: a cloud is meaningless without them, and `hasXYZ` already
// blocks Import until all three are assigned, so offering an Import checkbox
// would only create a dead-end error state. These header cells show no
// checkbox at all.
export const GEOMETRY_ROLES = new Set(['x', 'y', 'z']);

// Roles that name a session channel directly rather than a free-form scalar.
// Their role token IS the drop name, because the preview gives a fixed in-file
// column no `suggested_slug` to fall back on.
export const NAMED_CHANNEL_ROLES = new Set([
  'intensity', 'reflectance', 'r', 'g', 'b',
]);

// Slugs that downstream tools look up BY NAME. Dropping one doesn't error — it
// silently removes a capability — so unticking any of these surfaces an inline
// warning naming what stops working. The user is still allowed to drop them:
// these fields are often dead weight (an all-zero is_miss on a hits-only
// export) and forcing them into every import would be its own bug.
export const PROTECTED_SLUGS: Record<string, string> = {
  is_miss: 'sky/miss handling — leaf-area density and the Hit/Miss color scheme',
  row_index: 'structured-scan gap filling and miss recovery',
  column_index: 'structured-scan gap filling and miss recovery',
  timestamp: 'the trajectory join for moving-platform leaf-area density',
  target_index: 'multi-return grouping (gap filling, leaf-area density)',
  target_count: 'multi-return grouping (gap filling, leaf-area density)',
};

// The canonical slug a column would land under, for PROTECTED_SLUGS lookup. A
// role token (is_miss / row_index / timestamp / …) IS the canonical slug the
// backend pins, so it wins; otherwise fall back to the column's own slug, which
// is what an in-file format's fixed field is named.
//
// `prevRole` is consulted first for an unticked column: unticking an ASCII
// column moves its role to 'skip', which would otherwise erase the very
// identity the protected-field warning needs to report.
export function canonicalSlugOf(col: ColumnConfig): string {
  const role = (!col.imported && col.prevRole) ? col.prevRole : col.role;
  if (role in PROTECTED_SLUGS) return role;
  // intensity / reflectance / r / g / b are named session channels rather than
  // free-form scalars, so the role token is the name the backend drops by. A
  // fixed in-file column has no meaningful `slug` (the preview leaves it empty
  // for non-scalars), so falling through to it would send an empty string.
  if (NAMED_CHANNEL_ROLES.has(role)) return role;
  return (col.slug || '').toLowerCase();
}

// Formats whose import path takes no global shift, so offering the control
// would be a lie: the user could tick it, type an offset, and nothing would
// happen.
//
// A RIEGL raw project is scanner-local meters — each position sits at its own
// origin, offset only by a centroid-anchored ENU prior — so coordinates are
// always small and there is nothing to shift away. The extract endpoint has no
// world_shift parameter at all, unlike create_cloud_session.
export const SHIFTLESS_KINDS = new Set(['riproject']);

// Formats whose importer takes no externally-supplied trajectory, so offering
// the upload would be dead UI: the file is read, parsed, and then ignored.
//
// A RIEGL raw project describes its own platform. Static tripod positions
// (ScanPos001, ScanPos002, …) each have a single GNSS fix and a fixed origin —
// there is no motion to describe, and attaching a trajectory would flip
// isMovingScan() true and route LAD down the trajectory-join path for a scan
// that does not need it. A genuinely mobile capture records its path in the
// project's own poslog_*.rxp files, which is where a trajectory should come
// from if we ever derive one — not from a separate upload.
export const TRAJECTORYLESS_KINDS = new Set(['riproject']);

// Roles that are singletons within a scan: a cloud has exactly one of each. The
// backend keys every algorithm off a canonical slug (one 'timestamp', one 'x',
// …), so assigning a singleton role to two columns silently orphans the second
// (it lands under a deduped 'timestamp_2' slug that nothing looks up) while both
// show the same label. To make the role exclusive we DEMOTE the previous holder
// when the user assigns one of these elsewhere. Excludes the scalar roles
// (extra/label — many columns can each be a distinct named scalar) and 'skip'.
export const EXCLUSIVE_ROLES = new Set([
  'x', 'y', 'z',
  'r', 'g', 'b',
  'intensity', 'reflectance',
  'timestamp', 'target_index', 'target_count',
  'row_index', 'column_index', 'is_miss',
  'origin_x', 'origin_y', 'origin_z',
]);

// Per-column editable state in the wizard.
export interface ColumnConfig {
  index: number;
  headerName: string | null;
  role: string;            // one of ROLE_OPTIONS values (RGB normalized to r/g/b)
  slug: string;            // editable for extra/label columns
  label: string;           // rename target
  typeHint: string;
  remappable: boolean;
  // The role the backend AUTO-DETECTED, kept so `roleOverrides` can send only
  // what the user actually changed — an untouched column must not be pinned by
  // an override, or a future improvement to auto-detection would be silently
  // overridden by a stale choice the user never made.
  detectedRole: string;
  // The label the preview suggested, so `scalarLabels` sends only an in-file
  // rename the user actually made.
  detectedLabel: string;
  // Whether the column's ROLE may be reassigned on a fixed-layout format.
  // Distinct from `remappable` (ASCII-only: the column's POSITION can move).
  // An in-file scalar's name is an arbitrary vendor string, so auto-detection
  // can't cover every spelling — this is what lets the user say "the column my
  // file calls `shot_time` is the Timestamp" instead of leaving it an anonymous
  // scalar that Backfill Misses and LAD then refuse.
  roleAssignable?: boolean;
  // Untick the header's "Import" checkbox to drop the column. The two format
  // families need different machinery, so this flag drives both:
  //   - remappable (ASCII): unticking also sets role 'skip', which the backend
  //     already honors positionally (a unique `skip:N` placeholder that the
  //     pandas `usecols` filter drops). `prevRole` restores the role on re-tick.
  //   - in-file (LAS/PLY/E57/PTX): roles are fixed by the file, so the column
  //     travels in `droppedSlugs` instead and the backend filters it out of the
  //     session's extras by name.
  imported: boolean;
  // Role held before the user unticked Import, so re-ticking round-trips back
  // to it instead of stranding the column on 'skip'.
  prevRole: string | null;
}

export interface ScanConfig {
  preview: PointCloudPreviewResponse | null;
  loading: boolean;
  error: string | null;     // hard failure → offer auto-detect import
  warning: string | null;
  columns: ColumnConfig[];
  rgbIs255: boolean;
  // True when preview returned no usable columns; the wizard then only offers
  // "import with auto-detect" for this scan.
  autoOnly: boolean;
  // CloudCompare-style global shift. `shiftEnabled` gates whether it's applied;
  // `shift` holds the per-axis offset to SUBTRACT. Seeded from the preview's
  // `suggested_shift` (enabled when the cloud's coords are large), with Z left at
  // 0/keep by default since elevation is rarely huge. The user can edit/toggle.
  shiftEnabled: boolean;
  shift: { x: number; y: number; z: number };
  // Set once the user edits the shift by hand, so a later preview arriving in
  // the same batch cannot overwrite their choice with the shared suggestion.
  shiftTouched?: boolean;
  // The length unit this scan's SOURCE coordinates are in. Positions are scaled
  // to meters at import, so this decides the scale factor — and defaults to
  // meters, which is exactly what every import implicitly assumed before units
  // existed.
  //
  // Seeded from the preview's `detected_units`; when `unitsCertain` the format
  // itself declared it (a LAS CRS, or E57/RIEGL which are meters by spec) and
  // the control states a fact rather than offering a guess.
  units: LengthUnit;
  unitsCertain: boolean;
  // Set once the user picks a unit by hand, so a later preview in the same
  // batch cannot overwrite their choice. Mirrors `shiftTouched`.
  unitsTouched?: boolean;
  // Mobile-platform trajectory attached to this scan (null = static capture).
  trajectory: PoseStream | null;
  // True once the user explicitly imported a trajectory FOR THIS SCAN. A
  // trajectory imported on one scan auto-populates the others (the common case:
  // one platform pass split across files), but only those still at their
  // inherited/empty default — an explicit per-scan choice is never overwritten.
  trajectoryExplicit: boolean;
  // Per-scan trajectory import error (bad file), shown inline next to the button.
  trajectoryError: string | null;
}

// Normalize a backend-detected role to the wizard's RGB convention: the backend
// reports r255/g255/b255, but the wizard models RGB scale with a single toggle
// and the plain r/g/b roles.
export function normalizeRole(role: string): string {
  if (role === 'r255') return 'r';
  if (role === 'g255') return 'g';
  if (role === 'b255') return 'b';
  return role;
}

export function configFromColumn(c: PreviewColumn): ColumnConfig {
  let role = normalizeRole(c.detected_role);
  // The backend reports an unrecognized ASCII column as 'skip', but auto-detect
  // import CARRIES it as a scalar field (it has a suggested slug). Default such
  // columns to 'extra' so the wizard's no-edit behavior matches the old
  // auto-detect — otherwise a default import would silently drop scalars.
  if (role === 'skip' && c.remappable && c.suggested_slug) {
    role = 'extra';
  }
  return {
    index: c.index,
    headerName: c.header_name,
    // A column the backend reported as 'skip' and that was NOT promoted to a
    // carried scalar above has nothing to import, so it starts unticked. Every
    // other column starts ticked, keeping a no-edit import byte-identical to
    // the old auto-detect behavior — unless the preview explicitly asked for it
    // to start off (`import_by_default: false`, the RIEGL diagnostic scalars).
    // That flag only ever UNTICKS: a 'skip' column stays unticked regardless.
    imported: role !== 'skip' && c.import_by_default !== false,
    prevRole: null,
    // Default a carried scalar to 'extra' (continuous), never 'label', so a
    // no-edit import matches the old auto-detect coloring — a field that used
    // to render as a gradient shouldn't silently become discrete. The type hint
    // instead suggests switching to 'Label' when the values look categorical.
    role,
    slug: c.suggested_slug,
    label: c.suggested_label,
    typeHint: c.type_hint,
    remappable: c.remappable,
    detectedRole: role,
    detectedLabel: c.suggested_label,
    roleAssignable: c.role_assignable ?? false,
  };
}

// Enforce exclusive-role uniqueness on the initial config built from a preview:
// if two columns arrive with the same exclusive role (a header the backend
// mapped to, say, 'timestamp' twice), keep the FIRST and demote the rest to
// 'skip' — the same first-wins rule the backend's slug dedup would apply, but
// made visible in the wizard instead of silently orphaning the loser. Runs once
// at load; user edits are kept exclusive by updateColumn.
export function dedupeExclusiveRoles(columns: ColumnConfig[]): ColumnConfig[] {
  const seen = new Set<string>();
  return columns.map((col) => {
    if (!EXCLUSIVE_ROLES.has(col.role)) return col;
    // A demoted duplicate carries nothing, so its Import checkbox must clear in
    // lockstep — leaving it ticked would show "Import ✓ / Skip", which reads as
    // a contradiction and would put the column in `droppedSlugs` on the in-file
    // path while the plan says otherwise.
    if (seen.has(col.role)) return { ...col, role: 'skip', imported: false };
    seen.add(col.role);
    return col;
  });
}

export function blankScanConfig(): ScanConfig {
  return {
    preview: null, loading: true, error: null, warning: null,
    columns: [], rgbIs255: true, autoOnly: false,
    shiftEnabled: false, shift: { x: 0, y: 0, z: 0 },
    // Meters until a preview says otherwise: the same assumption every import
    // made implicitly before units existed, so an untouched workflow is
    // unchanged.
    units: DEFAULT_UNIT, unitsCertain: false,
    trajectory: null, trajectoryExplicit: false, trajectoryError: null,
  };
}

// The shift [x, y, z] for a scan, or null when disabled / all-zero (a zero shift
// is a no-op, so don't bother sending it). Returned to the caller in WizardResult.
export function effectiveShift(cfg: ScanConfig): [number, number, number] | null {
  if (!cfg.shiftEnabled) return null;
  const { x, y, z } = cfg.shift;
  if (x === 0 && y === 0 && z === 0) return null;
  return [x, y, z];
}

// Does this scan's column config have all of x, y, z assigned? Required before
// import for remappable (ASCII) formats; in-file formats are always ready.
export function hasXYZ(cfg: ScanConfig): boolean {
  if (cfg.autoOnly) return true; // auto-detect will sort it out (or error clearly)
  const anyRemappable = cfg.columns.some((c) => c.remappable);
  if (!anyRemappable) return true;
  const roles = new Set(cfg.columns.map((c) => c.role));
  return roles.has('x') && roles.has('y') && roles.has('z');
}

// Build the ColumnPlan to send to the backend for a remappable (ASCII) scan.
// Returns null when the scan isn't remappable (in-file layout) or when the user
// left everything at auto-detected defaults with no edits — in which case we let
// the backend auto-detect (smaller request, identical result).
export function buildColumnPlan(cfg: ScanConfig): ColumnPlan | null {
  if (cfg.autoOnly) return null;
  const anyRemappable = cfg.columns.some((c) => c.remappable);
  if (!anyRemappable) return null;

  const columns: ColumnPlanEntry[] = cfg.columns.map((c) => {
    const isScalar = SCALAR_ROLES.has(c.role);
    // Both 'extra' (Scalar) and 'label' (Label) become a backend extra dim;
    // the backend only knows the 'extra' token, so map both to it and carry the
    // categorical-ness via the flag ('label' → categorical).
    let role = isScalar ? 'extra' : c.role;
    // RGB roles map to r255/g255/b255 when the scan is 0-255, else the 0-1 r/g/b
    // tokens, so the backend reads the right scale.
    if (role === 'r' || role === 'g' || role === 'b') {
      role = cfg.rgbIs255 ? `${role}255` : role;
    }
    return {
      index: c.index,
      role,
      slug: isScalar ? c.slug : null,
      label: isScalar ? c.label : null,
      categorical: c.role === 'label',
    };
  });
  return { columns, rgbIs255: cfg.rgbIs255 };
}

// Slugs mapped to the 'Label' role for a scan — registered for categorical
// (discrete) coloring after import. Unticked columns are excluded: they never
// reach the cloud, so registering a scheme for them would be dead state.
export function categoricalSlugs(cfg: ScanConfig): string[] {
  return cfg.columns
    .filter((c) => c.imported && c.role === 'label')
    .map((c) => c.slug)
    .filter(Boolean);
}

// Slugs to drop on an IN-FILE format, where the file fixes the layout so the
// positional ColumnPlan can't express the choice (buildColumnPlan returns null
// for these scans entirely). ASCII skips are deliberately NOT included — they
// travel as role 'skip' inside the plan, which the backend already honors.
export function droppedSlugs(cfg: ScanConfig): string[] {
  return cfg.columns
    .filter((c) => !c.imported && !c.remappable)
    .map((c) => canonicalSlugOf(c))
    .filter(Boolean);
}

// Role reassignments for an IN-FILE format, as `{source_slug: role}`.
//
// The counterpart to `droppedSlugs`: the file fixes the layout, so the
// positional ColumnPlan can't carry the choice and it travels by slug instead.
// Only columns the user actually CHANGED are sent — an untouched column is
// auto-detected backend-side exactly as before, so a no-edit import stays
// byte-identical.
//
// `extra`/`label`/`skip` are not canonical roles: 'extra' and 'label' differ
// only in how the renderer colors the field (and are already expressed by the
// rename box), and a dropped column travels in `droppedSlugs`.
export function roleOverrides(cfg: ScanConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of cfg.columns) {
    if (!c.roleAssignable || !c.imported) continue;
    if (c.role === c.detectedRole) continue;      // untouched
    if (SCALAR_ROLES.has(c.role) || c.role === 'skip') continue;
    const src = (c.headerName || c.slug || '').trim();
    if (src) out[src] = c.role;
  }
  return out;
}

// The complement of `droppedSlugs` for an in-file scan: every scalar slug the
// preview offered that is still ticked. The RIEGL extract endpoint takes a KEEP
// list (`keep_columns`) rather than a drop list, and the wizard is the only
// place that knows the full offered set — inverting in the caller would mean
// re-deriving it from a preview the caller never sees.
export function keptSlugs(cfg: ScanConfig): string[] {
  return cfg.columns
    .filter((c) => c.imported && !c.remappable)
    .map((c) => canonicalSlugOf(c))
    .filter(Boolean);
}

// Warnings for unticked columns whose slug drives a downstream tool. Returned
// as "<field> — <what stops working>" strings for the inline notice.
export function protectedDropWarnings(cfg: ScanConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const col of cfg.columns) {
    if (col.imported) continue;
    const slug = canonicalSlugOf(col);
    const consequence = PROTECTED_SLUGS[slug];
    if (!consequence || seen.has(slug)) continue;
    seen.add(slug);
    out.push(`${col.headerName ?? slug} — ${consequence}`);
  }
  return out;
}

// Slugs the user set to 'Scalar' (role 'extra') whose name carries a registered
// categorical scheme (e.g. a Miss Flag → Scalar keeps slug 'is_miss'). These
// would otherwise color with the fixed by-name scheme (Hit/Miss), ignoring the
// Scalar choice — so they're registered as continuous overrides after import to
// force the gradient path. The backend still pins the canonical slug, so LAD is
// unaffected; only the renderer's coloring changes.
export function continuousSlugs(cfg: ScanConfig): string[] {
  return cfg.columns
    .filter((c) => c.role === 'extra' && hasRegisteredScheme(c.slug))
    .map((c) => c.slug)
    .filter(Boolean);
}

// In-file renames, as `{source_slug: display label}`. An in-file column's slug
// is the file's own field name and is what every other channel (drops, keeps,
// role overrides, categorical registration) names it by, so a rename there
// changes only the LABEL — changing the slug would make each of those channels
// name a field the file does not have. ASCII renames ride the ColumnPlan instead.
// Only labels the user actually changed are sent, so a no-edit import is
// unchanged.
export function scalarLabels(cfg: ScanConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of cfg.columns) {
    if (c.remappable || !c.imported || !SCALAR_ROLES.has(c.role)) continue;
    const label = c.label.trim();
    if (!c.slug || !label || label === c.detectedLabel) continue;
    out[c.slug] = label;
  }
  return out;
}

// The identity "apply to all" matches scans by: format, column count, each
// column's header, and whether it is positionally remappable. JSON-encoded so
// header names can't run together (['ab','c'] vs ['a','bc']), and carrying the
// kind so an .xyz and a .ply that happen to share names don't count as one
// layout. null until the scan has a preview — an unknown layout matches nothing.
export function layoutSignature(cfg: ScanConfig | null | undefined): string | null {
  if (!cfg || !cfg.preview || cfg.autoOnly) return null;
  return JSON.stringify([
    cfg.preview.kind ?? '',
    cfg.columns.map((c) => [c.headerName ?? null, c.remappable]),
  ]);
}

// Copy `src`'s user settings onto `target`, or null when their layouts differ
// (a 6-col layout must never land on a 4-col file). Pure, so the wizard can run
// it inside a single setConfigs updater on every edit while "apply to all" is
// on — the box has to mean "these settings, for every scan", not "a snapshot
// of them taken when I ticked it".
export function propagateSettings(src: ScanConfig, target: ScanConfig): ScanConfig | null {
  const sig = layoutSignature(src);
  if (sig === null || layoutSignature(target) !== sig) return null;
  return {
    ...target,
    rgbIs255: src.rgbIs255,
    // Carry the global shift too. It is auto-suggested per file as
    // floor(min) per axis, so scans of ONE site get DIFFERENT shifts --
    // measured 25 m and 28 m apart on a three-scan vineyard, because the
    // scanners stood that far apart. Clouds render at
    // `world - displayOffset - worldShift`, so scans that disagree about
    // the shift are drawn in different frames: registration aligns them
    // correctly in world coordinates and the viewport then re-separates
    // them by the difference. "Apply to all" has to mean one frame.
    shiftEnabled: src.shiftEnabled,
    shift: { ...src.shift },
    shiftTouched: true,
    // Units are deliberately NOT carried when the target scan detected its
    // own. A unit is a property of the individual FILE — a batch can mix a
    // meter LAS with a feet one — and a detected unit is a fact read from
    // that file, so overwriting it with a neighbor's choice would rescale
    // real data on the strength of a UI convenience. Scans that could not
    // detect one do inherit, which is the case apply-to-all is for: a
    // directory of unit-less ASCII exports that are all in the same unit.
    ...(target.unitsCertain ? {} : { units: src.units, unitsTouched: true }),
    // The trajectory follows too (clearing it included), shown on the target
    // as inherited rather than as that scan's own explicit choice.
    trajectory: src.trajectory,
    trajectoryExplicit: false,
    trajectoryError: null,
    columns: target.columns.map((col, idx) => {
      const s = src.columns[idx];
      if (!s) return col;
      // Carry the Import choice too — the whole point of apply-to-all is
      // that the user shouldn't have to untick the same junk column on
      // every file of a matching-layout batch.
      return { ...col, role: s.role, slug: s.slug, label: s.label,
               imported: s.imported, prevRole: s.prevRole };
    }),
  };
}

// `configs` with every other scan re-synced from `configs[srcIdx]`. Scans with
// no preview yet or a different layout are left alone; a late preview is
// re-synced when it lands (see the preview effect).
export function propagateFrom(configs: ScanConfig[], srcIdx: number): ScanConfig[] {
  const src = configs[srcIdx];
  if (!src?.preview) return configs;
  return configs.map((c, i) => (i === srcIdx ? c : (propagateSettings(src, c) ?? c)));
}

// ─── Shared edits ──────────────────────────────────────────────────────────
// Pure (cfg) -> cfg transforms, so the wizard's per-scan stepping and the file
// browser's one-set-for-all model apply exactly the same rules.

// Fold one scan's preview into a batch. `prev[i]` receives the preview's
// columns, warning and detected unit; every untouched scan in the batch is
// (re)seeded with the batch's SHARED global shift.
export function applyPreview(
  prev: ScanConfig[],
  i: number,
  preview: PointCloudPreviewResponse,
): ScanConfig[] {
  const columns = dedupeExclusiveRoles(preview.columns.map(configFromColumn));
  // Seed the global shift from the backend's suggestion (present only for
  // large/UTM coords). Default Z to keep (0) — elevation is rarely huge —
  // even when a Z suggestion is offered, matching CloudCompare's default.
  const sug = preview.suggested_shift ?? null;
  // Scans imported together belong in ONE frame. The backend suggests
  // floor(min) per axis, which is per FILE, so scans of a single site
  // get different shifts -- measured 25 m and 28 m apart on a
  // three-scan vineyard, purely because the scanners stood that far
  // apart. Clouds render at `world - displayOffset - worldShift`, so
  // mismatched shifts draw them in different frames and any alignment
  // between them looks wrong however well it registered.
  //
  // Take the smallest suggestion seen so far across the batch: it is
  // stable regardless of preview completion order, and staying at or
  // below every scan's own floor(min) keeps coordinates positive,
  // which is what the shift is for.
  //
  // A suggestion arrives in RAW FILE UNITS, but the shift is applied
  // to points already scaled to meters — so every suggestion is
  // converted by its OWN scan's unit before being compared or shared.
  // Skipping this lands a feet-unit UTM cloud millions of meters from
  // the origin (see `withUnits`).
  const unitOf = (c: ScanConfig, idx: number): LengthUnit =>
    idx === i
      ? (isLengthUnit(preview.detected_units) ? preview.detected_units : DEFAULT_UNIT)
      : c.units;
  const shiftInMeters = (c: ScanConfig, idx: number): [number, number] | null => {
    const s = idx === i ? sug : (c.preview?.suggested_shift ?? null);
    if (!s) return null;
    const f = metersPerUnit(unitOf(c, idx)) ?? 1;
    return [Math.floor(s[0] * f), Math.floor(s[1] * f)];
  };

  // Sharing one frame is only valid when the scans agree on a UNIT: a
  // batch mixing a meter scan with a feet one describes two different
  // sites far more often than one site recorded twice, and min()-ing
  // across them would drag one cloud's frame to the other's.
  //
  // Compared over RESOLVED scans only. Using `prev[0]` as the
  // reference was wrong: previews land in parallel, so an unresolved
  // scan still sitting at the seeded default 'm' made a perfectly
  // uniform feet batch look mixed — and a scan whose preview THREW
  // stays at 'm' forever, permanently disabling shared shift for the
  // batch. That is the vineyard regression the comment above warns
  // about (scans drawn in different frames), so it must not be
  // reintroduced by a unit check.
  const resolved = prev
    .map((c, idx) => ({ c, idx }))
    .filter(({ c, idx }) => idx === i || c.preview !== null || c.unitsTouched);
  const unitsAgree = resolved.length === 0
    || resolved.every(({ c, idx }) => unitOf(c, idx) === unitOf(resolved[0].c, resolved[0].idx));

  const shared = !unitsAgree ? null : prev.reduce<[number, number] | null>((acc, c, idx) => {
    const s = shiftInMeters(c, idx);
    if (!s) return acc;
    return acc ? [Math.min(acc[0], s[0]), Math.min(acc[1], s[1])]
               : [s[0], s[1]];
  }, null);
  return prev.map((c, idx) => {
    let base = idx === i
      ? { ...c, preview, loading: false, warning: preview.warning ?? null,
          columns, autoOnly: columns.length === 0 }
      : c;
    // Seed this scan's unit from what its own format declared. Per
    // scan, never shared: a batch can legitimately mix a meter LAS
    // with a feet one, and guessing across them would rescale real
    // data. Untouched scans only, like the shift.
    if (idx === i && !base.unitsTouched) {
      const det = preview.detected_units;
      base = {
        ...base,
        units: isLengthUnit(det) ? det : DEFAULT_UNIT,
        unitsCertain: !!preview.units_certain && isLengthUnit(det),
      };
    }
    // Only re-seed scans the user has not edited by hand.
    if (!shared || base.shiftTouched) return base;
    return {
      ...base,
      shiftEnabled: true,
      shift: { x: shared[0], y: shared[1], z: 0 },
    };
  });
}

// A preview that threw: the scan can still import, with auto-detect.
export function withPreviewError(c: ScanConfig, message: string): ScanConfig {
  return { ...c, loading: false, error: message, autoOnly: true };
}

export function withColumnPatch(c: ScanConfig, colIndex: number, patch: Partial<ColumnConfig>): ScanConfig {
  // Assigning an exclusive (singleton) role demotes any OTHER column that
  // already holds it to 'skip' — the role can only live on one column, and a
  // silent duplicate would orphan the loser under a deduped slug. Only kicks
  // in when the patch actually changes the role to an exclusive one.
  const claims = patch.role !== undefined && EXCLUSIVE_ROLES.has(patch.role);
  return {
    ...c,
    columns: c.columns.map((col) => {
      if (col.index === colIndex) {
        // Choosing 'Skip' in the dropdown and unticking Import are the same
        // user intent, so keep the two controls consistent in both
        // directions rather than letting them disagree.
        const next = { ...col, ...patch };
        if (patch.role !== undefined && patch.imported === undefined) {
          next.imported = patch.role !== 'skip';
        }
        return next;
      }
      if (claims && col.role === patch.role) {
        return { ...col, role: 'skip', imported: false };
      }
      return col;
    }),
  };
}

// Toggle a column's Import checkbox. For a remappable (ASCII) column this
// also moves the role to/from 'skip' so the existing positional plan
// machinery carries the choice — no second mechanism on that path. The role
// held before the untick is stashed in `prevRole` so re-ticking restores it
// rather than stranding the column on 'skip'.
export function withColumnImported(c: ScanConfig, colIndex: number, imported: boolean): ScanConfig {
  return {
    ...c,
    columns: c.columns.map((col) => {
      if (col.index !== colIndex) return col;
      if (!col.remappable) return { ...col, imported };
      if (!imported) {
        return { ...col, imported: false, prevRole: col.role, role: 'skip' };
      }
      // Re-tick: restore the previous role, falling back to a carried
      // scalar when there is nothing to restore (a column that arrived as
      // 'skip' from auto-detect and is now being opted in).
      return { ...col, imported: true, role: col.prevRole ?? 'extra', prevRole: null };
    }),
  };
}

export function withRgbIs255(c: ScanConfig, v: boolean): ScanConfig {
  return { ...c, rgbIs255: v };
}

export function withShiftEnabled(c: ScanConfig, v: boolean): ScanConfig {
  return { ...c, shiftEnabled: v, shiftTouched: true };
}

// Mark it edited so a preview still loading elsewhere in the batch cannot
// overwrite the value with the shared suggestion.
export function withShiftAxis(c: ScanConfig, axis: 'x' | 'y' | 'z', v: number): ScanConfig {
  return { ...c, shift: { ...c.shift, [axis]: v }, shiftTouched: true };
}

// Choosing a unit by hand clears `unitsCertain`: whatever the file declared,
// the value shown is now the user's choice, and labeling it "detected from
// file" would be a lie. `unitsTouched` keeps a still-loading preview from
// overwriting it, exactly as with the shift.
export function withUnits(c: ScanConfig, u: LengthUnit): ScanConfig {
  const next = { ...c, units: u, unitsCertain: false, unitsTouched: true };

  // ── Re-derive the suggested shift in the NEW unit ──────────────────
  //
  // The shift is SUBTRACTED from positions that have already been scaled to
  // meters, so it must itself be in meters. The backend only pre-scales its
  // suggestion when the FORMAT declared a unit — for an ASCII/PLY/PCD/PTX
  // source it cannot, so `suggested_shift` arrives in RAW FILE UNITS and
  // this is the only place that can put it right.
  //
  // Getting it wrong is silent and severe: a UTM .xyz in US survey feet
  // (min ≈ 6,500,000 ft) scales to ≈ 1,981,204 m but keeps a 6,500,000
  // shift, landing the cloud 4.5 MILLION meters from the origin — framed on
  // empty space, with float32 precision destroyed.
  //
  // Only a shift the user has NOT hand-edited is re-derived; once they type
  // a value it is theirs, in whatever frame they meant it.
  const raw = c.preview?.suggested_shift;
  if (!c.shiftTouched && raw) {
    const f = metersPerUnit(u) ?? 1;
    next.shift = {
      x: Math.floor(raw[0] * f),
      y: Math.floor(raw[1] * f),
      // Z stays at keep/0, matching how the suggestion is seeded.
      z: c.shift.z,
    };
  }
  return next;
}

export function withTrajectoryCleared(c: ScanConfig): ScanConfig {
  return { ...c, trajectory: null, trajectoryExplicit: false, trajectoryError: null };
}

// What the importer needs for one scan, from its edited config.
export function toWizardResult(input: WizardScanInput, c: ScanConfig): WizardResult {
  return {
    input,
    asciiFormat: input.asciiFormatHint ?? null,
    columnPlan: buildColumnPlan(c),
    categoricalSlugs: categoricalSlugs(c),
    continuousSlugs: continuousSlugs(c),
    droppedSlugs: droppedSlugs(c),
    keptSlugs: keptSlugs(c),
    roleOverrides: roleOverrides(c),
    scalarLabels: scalarLabels(c),
    worldShift: effectiveShift(c),
    units: c.units,
    trajectory: c.trajectory,
  };
}
