import { octreeAttributeSlug } from './pointCloudHelpers';
import type { PointCloudData } from './pointCloudTypes';
import type { ScanParameters } from './scanParameters';

// A Scan is the user-facing unit: it may have point data, scan parameters,
// both, or — transiently during construction — neither. `hasData` and
// `hasParams` predicates drive every conditional render and analysis gate.
//
// `sourcePath` is the on-disk path the data was loaded from (when known),
// used by the backend `file_path` field so we don't have to ship the raw
// points in the request body.

export interface Scan {
  id: string;
  label: string;
  visible: boolean;
  color: string;
  data?: PointCloudData;
  params?: ScanParameters;
  // Sky/miss points (laser pulses that returned nothing) are kept in the
  // backend session for LAD but excluded from the octree, so they're drawn by a
  // separate overlay. `showMisses` toggles that overlay (off by default — misses
  // are hidden until the user asks to verify them). The data's
  // `octree.hasMisses` is the source of truth for whether the toggle is offered.
  showMisses?: boolean;
  sourcePath?: string;
  // Helios <ASCII_format> hint preserved from XML import so the backend
  // can re-parse the file (e.g. for crop-by-path) with the same column
  // layout. Null/undefined falls back to backend auto-detection, which
  // covers the legacy 6/7-column conventions but may misread a file
  // that uses non-default column ordering.
  asciiFormat?: string | null;
  // Set when Auto-Register moved this scan onto another one. Auto-Register
  // BAKES its matrix into the geometry (a session transform, or new in-RAM
  // positions), so nothing about the resulting cloud says it was registered —
  // the record has to be kept here or the fact is lost the moment the toast
  // fades. Two things read it: the Scans panel, which badges the row, and
  // "Reset Registration", which needs the matrix to undo the move.
  registration?: ScanRegistration;
}

/** What Auto-Register did to a scan, kept so it can be shown and reversed.
 *
 *  `matrix` is the ACCUMULATED world-frame rigid transform (row-major 4x4,
 *  the layout the backend's ICP response and `/session/{id}/transform` use):
 *  registering an already-registered scan composes onto it (`M_new · M_old`)
 *  rather than replacing it, so the inverse always returns the cloud to where
 *  it sat before the FIRST registration. Without composing, a second pass
 *  would strand the cloud at the first pass's result on reset. */
export interface ScanRegistration {
  /** Accumulated row-major 4x4, world frame. */
  matrix: number[];
  /** Scan this one was registered ONTO, for the panel readout. Not a hard
   *  reference — the target may since have been deleted or renamed, so the
   *  label is snapshotted alongside the id rather than looked up. */
  targetId: string;
  targetLabel: string;
  /** How many Auto-Register passes are folded into `matrix`. */
  passes: number;
}

/** Compose a newly applied registration onto whatever a scan already carried. */
export function composeRegistration(
  prev: ScanRegistration | undefined,
  applied: number[],
  targetId: string,
  targetLabel: string,
): ScanRegistration {
  return {
    matrix: prev ? multiply4x4(applied, prev.matrix) : [...applied],
    targetId,
    targetLabel,
    passes: (prev?.passes ?? 0) + 1,
  };
}

/** Row-major 4x4 product a·b. Kept here (rather than reaching for three.js)
 *  so the registration bookkeeping stays testable without a renderer. */
export function multiply4x4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

/** Inverse of a RIGID row-major 4x4 (rotation + translation only): the
 *  transpose of the rotation block, applied to the negated translation.
 *
 *  Not a general 4x4 inverse on purpose. Registration matrices are rigid by
 *  construction, and this form is both exact and free of the conditioning
 *  problems a general inverse hits on the near-singular matrices a degenerate
 *  fit can produce — reversing a registration must never itself distort the
 *  cloud. */
export function invertRigid4x4(m: number[]): number[] {
  const rt = [
    m[0], m[4], m[8],
    m[1], m[5], m[9],
    m[2], m[6], m[10],
  ];
  const t = [m[3], m[7], m[11]];
  const it = [
    -(rt[0] * t[0] + rt[1] * t[1] + rt[2] * t[2]),
    -(rt[3] * t[0] + rt[4] * t[1] + rt[5] * t[2]),
    -(rt[6] * t[0] + rt[7] * t[1] + rt[8] * t[2]),
  ];
  return [
    rt[0], rt[1], rt[2], it[0],
    rt[3], rt[4], rt[5], it[1],
    rt[6], rt[7], rt[8], it[2],
    0, 0, 0, 1,
  ];
}

/** Scans carrying an Auto-Register record — the set "Reset Registration" acts
 *  on, and the reason that command is disabled on an unregistered project. */
export function registeredScans(scans: Scan[]): (Scan & { registration: ScanRegistration })[] {
  return scans.filter(
    (s): s is Scan & { registration: ScanRegistration } => s.registration != null,
  );
}

/** Ids of the scans that others were registered ONTO — the references.
 *
 *  DERIVED from the movers' `registration.targetId` rather than stored on the
 *  reference itself, and deliberately so. A reference is only a reference for
 *  as long as something is still registered onto it: reset that mover, or
 *  delete it, and the reference is once again an ordinary unregistered scan. A
 *  stored flag would have to be swept on every reset and every delete to stay
 *  true, and would quietly outlive the registration it describes when either
 *  sweep was missed. Deriving it cannot go stale.
 *
 *  A reference is NOT itself moved by Auto-Register, so it carries no matrix
 *  and "Reset Registration" never touches it — which is exactly why it needs a
 *  DIFFERENT marker from a mover rather than sharing one. */
export function referenceScanIds(scans: Scan[]): Set<string> {
  const ids = new Set<string>();
  const present = new Set(scans.map(s => s.id));
  for (const s of scans) {
    const target = s.registration?.targetId;
    // Skip a target that has since been deleted: nothing in the panel could
    // show the badge anyway, and a self-reference would be a bug elsewhere.
    if (target && target !== s.id && present.has(target)) ids.add(target);
  }
  return ids;
}

export function hasData(scan: Scan): scan is Scan & { data: PointCloudData } {
  return scan.data != null;
}

export function hasParams(scan: Scan): scan is Scan & { params: ScanParameters } {
  return scan.params != null;
}

// Column slugs that let the backend RECONSTRUCT sky/miss points (gapfillMisses):
// a per-pulse timestamp, OR a native scan-grid row/column index pair. These are
// the canonical session slugs (see backend _lad_labels_vals / the import wizard).
const MISS_RECON_TIMESTAMP = 'timestamp';
const MISS_RECON_GRID = ['row_index', 'column_index'] as const;

// These predicates read only the cloud's `data`, so they accept anything with a
// `data` field (Scan, PointCloudEntry, …) rather than the full Scan shape.
type WithData = { data?: PointCloudData };

// The set of column slugs a cloud carries, gathered from whichever metadata the
// import produced: an octree cloud exposes them on `octree.attributeLabels` /
// `attributeRanges`; a flat in-RAM cloud on `data.scalarFields`. Keyed by slug
// in all three, so we union their keys.
export function columnSlugs(scan: WithData): Set<string> {
  const slugs = new Set<string>();
  const oct = scan.data?.octree;
  // Normalise the octree's BUFFER KEYS onto canonical slugs. PotreeConverter
  // names the time column by its LAS dimension, `gps-time`, but every predicate
  // here (and the backend) keys off `timestamp` — so without this a scan whose
  // timestamps round-tripped through the LAS gps_time field reported no
  // timestamp column at all, and Backfill Misses refused it with "no column
  // 'timestamp'" while the Color-by picker happily listed `gps-time`.
  //
  // The buffer key itself must NOT be renamed at the source: it indexes the GPU
  // buffer (see octreeAttributeSlug's note). Mapping it here, where the question
  // is "which columns does this cloud carry?", keeps both layers correct.
  for (const k of Object.keys(oct?.attributeLabels ?? {})) slugs.add(octreeAttributeSlug(k));
  for (const k of Object.keys(oct?.attributeRanges ?? {})) slugs.add(octreeAttributeSlug(k));
  for (const k of Object.keys(scan.data?.scalarFields ?? {})) slugs.add(k);
  return slugs;
}

// True when the cloud carries the columns needed to reconstruct misses: a
// timestamp, OR both grid indices. (Either path drives gapfillMisses backend-side.)
export function missColumnsAvailable(scan: WithData): boolean {
  const slugs = columnSlugs(scan);
  if (slugs.has(MISS_RECON_TIMESTAMP)) return true;
  return MISS_RECON_GRID.every((s) => slugs.has(s));
}

// Which ancillary signals a cloud carries to reconstruct misses, and which one
// the backend will actually use. `hasTimestamp` / `hasGrid` report availability;
// `preferred` is the path gapfillMisses takes — TIMESTAMP wins when both exist
// (it's more robust to sparse grids; the backend drops the grid columns then),
// matching `_do_backfill_misses` in main.py. `preferred` is null when neither
// signal is present (the scan can't be backfilled).
export interface MissReconSources {
  hasTimestamp: boolean;
  hasGrid: boolean;
  preferred: 'timestamp' | 'grid' | null;
}

export function missReconSources(scan: WithData): MissReconSources {
  const slugs = columnSlugs(scan);
  const hasTimestamp = slugs.has(MISS_RECON_TIMESTAMP);
  const hasGrid = MISS_RECON_GRID.every((s) => slugs.has(s));
  const preferred = hasTimestamp ? 'timestamp' : hasGrid ? 'grid' : null;
  return { hasTimestamp, hasGrid, preferred };
}

// A scan is eligible for Backfill Misses when it has data, does NOT already carry
// misses (octree.hasMisses), and carries the columns to reconstruct them. Scans
// that already have misses (E57 / structured PLY) are skipped; scans with neither
// timestamp nor grid can't be recovered (re-import a miss-retaining format).
export function isBackfillEligible(scan: WithData): boolean {
  return (
    scan.data != null &&
    scan.data.octree?.hasMisses !== true &&
    missColumnsAvailable(scan)
  );
}

// Whether a scan has a KNOWN scanner origin (beam apex) — required to place the
// sky/miss overlay, which relocates misses onto a sphere centred on that apex.
// True when the source recorded one (octree.scanOrigin, e.g. E57 pose / synthetic
// scan) OR the scan carries scan parameters (from a Helios XML <scan> or a
// file header), whose `origin` is a real scanner position. A plain XYZ/LAS/PLY
// import has NEITHER — its params stay undefined (see App buildScanFromWizard
// result), so the overlay must stay disabled: a placeholder origin would scatter
// the misses into a wrong-frame disk. Misses are still COMPUTED (valid for LAD as
// directions); only their visualisation is gated.
export function scanHasKnownOrigin(scan: { data?: PointCloudData; params?: ScanParameters }): boolean {
  return scan.data?.octree?.scanOrigin != null || scan.params != null;
}

// The scan's scanner position (beam apex) in WORLD coordinates, or null when the
// source never recorded one. `params.origin` is the PRIMARY copy — it is what
// every scan-geometry consumer reads and what a scan-position gesture writes —
// and `octree.scanOrigin` is the fallback for data-only imports (E57 pose, a
// RIEGL position without a .pat/.scn) that carried a pose but no parameters.
// The same precedence as the Scans panel's `data-scan-origin` attribute; keep
// the two in step. Baked coordinates only: an uncommitted Translate/Rotate
// draft lives in the viewer's edit state, so callers that care apply it.
export function scanOriginOf(
  scan: { data?: PointCloudData; params?: ScanParameters },
): [number, number, number] | null {
  const p = scan.params?.origin;
  if (p) return [p.x, p.y, p.z];
  const o = scan.data?.octree?.scanOrigin;
  return o ? [o[0], o[1], o[2]] : null;
}

// Centroid of every KNOWN scanner position in `scans`, or null when none of them
// carries one. Used to seed the scene origin on the first import: a multi-scan
// project's natural pivot is the middle of the scanner ring, not the middle of
// the point cloud's bounding box (which a single far outlier can drag away).
// Scans without an origin are skipped, not counted as (0,0,0).
export function meanScanOrigin(
  scans: readonly { data?: PointCloudData; params?: ScanParameters }[],
): [number, number, number] | null {
  const origins = scans.map(scanOriginOf).filter((o): o is [number, number, number] => o != null);
  if (origins.length === 0) return null;
  const sum = origins.reduce<[number, number, number]>(
    (acc, o) => [acc[0] + o[0], acc[1] + o[1], acc[2] + o[2]],
    [0, 0, 0],
  );
  return [sum[0] / origins.length, sum[1] / origins.length, sum[2] / origins.length];
}

export function scanDisplayName(scan: Scan): string {
  if (scan.label) return scan.label;
  if (scan.data?.fileName) return scan.data.fileName;
  return 'Untitled scan';
}

// Generate a unique label for a scan DERIVED from another one, tagged with
// `suffix` ("copy" for a duplicate, "cropped" for a retained crop). A trailing
// "(suffix)" / "(suffix N)" on the source is stripped first so deriving from an
// already-derived scan reads "… (copy 2)" rather than "… (copy) (copy)". The
// result is the first of "{base} (suffix)", "{base} (suffix 2)", … not already
// present in `existing`.
export function derivedScanName(
  sourceLabel: string,
  existing: Iterable<string>,
  suffix: string,
): string {
  const taken = new Set(existing);
  // Escape the suffix so a regex metacharacter in it can't corrupt the strip
  // pattern. Both current callers pass plain words, but this is cheap.
  const esc = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const strip = new RegExp(`\\s*\\(${esc}(?: \\d+)?\\)\\s*$`);
  const base = sourceLabel.replace(strip, '').trim() || sourceLabel.trim();
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${base} (${suffix})` : `${base} (${suffix} ${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Unique label for a duplicated scan — the "(copy)" specialisation of
// {@link derivedScanName}.
export function duplicateScanName(sourceLabel: string, existing: Iterable<string>): string {
  return derivedScanName(sourceLabel, existing, 'copy');
}

// The fixed per-scan color palette. New scans (imports, params-only scans, and
// duplicates) pick the first entry not already in use so each scan's swatch is
// visually distinct. Order: blue, green, amber, red, violet, pink, teal, orange.
const SCAN_PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

// A STATEFUL colour generator over {@link SCAN_PALETTE}: each call claims the
// first entry not yet taken, so N successive calls yield N distinct swatches.
//
// This exists because a single import can produce SEVERAL scans — a multi-block
// PTX or a multi-scan E57 fans out into one scan per scanner setup — and those
// scans are only committed to the scene AFTER all of them are built. A colour
// picker that reads the committed scan list therefore sees the same state on
// every call and hands out the same colour to every position, which is exactly
// the bug this replaced. Seed it with the colours already on the scene and call
// it once per new scan.
//
// Past exhaustion it cycles on a MONOTONIC cursor rather than on `used.size`.
// That distinction is load-bearing: the set cannot grow beyond the palette, so a
// size-based fallback freezes on one colour from the 9th allocation onward —
// reintroducing the identical-swatch bug for any source with more than 8
// positions. The cursor keeps advancing, so colours keep varying.
export function createScanColorAllocator(usedColors: Iterable<string> = []): () => string {
  const used = new Set(usedColors);
  let cursor = 0;
  return () => {
    const free = SCAN_PALETTE.find(c => !used.has(c));
    if (free !== undefined) {
      used.add(free);
      return free;
    }
    return SCAN_PALETTE[cursor++ % SCAN_PALETTE.length];
  };
}

// One-shot form of {@link createScanColorAllocator}: the first palette colour
// not already in `usedColors`. Use this only where a SINGLE scan is created (a
// duplicate, a params-only scan); anything creating several in a row needs the
// allocator, or they all come out the same colour.
export function allocateScanColor(usedColors: Set<string>): string {
  return createScanColorAllocator(usedColors)();
}

export type { ScanParameters } from './scanParameters';
