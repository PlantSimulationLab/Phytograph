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
function columnSlugs(scan: WithData): Set<string> {
  const slugs = new Set<string>();
  const oct = scan.data?.octree;
  for (const k of Object.keys(oct?.attributeLabels ?? {})) slugs.add(k);
  for (const k of Object.keys(oct?.attributeRanges ?? {})) slugs.add(k);
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

export function scanDisplayName(scan: Scan): string {
  if (scan.label) return scan.label;
  if (scan.data?.fileName) return scan.data.fileName;
  return 'Untitled scan';
}

// Generate a unique label for a duplicated scan. A trailing "(copy)" / "(copy N)"
// on the source is stripped first so duplicating a copy reads "… (copy 2)" rather
// than "… (copy) (copy)". The result is the first of "{base} (copy)",
// "{base} (copy 2)", "{base} (copy 3)", … not already present in `existing`.
export function duplicateScanName(sourceLabel: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  const base = sourceLabel.replace(/\s*\(copy(?: \d+)?\)\s*$/, '').trim() || sourceLabel.trim();
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? `${base} (copy)` : `${base} (copy ${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

// The fixed per-scan color palette. New scans (imports, params-only scans, and
// duplicates) pick the first entry not already in use so each scan's swatch is
// visually distinct. Order: blue, green, amber, red, violet, pink, teal, orange.
const SCAN_PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

// Pick the first palette color not already in `usedColors`; if all are taken,
// fall back to cycling by the count of used colors so successive allocations
// still vary.
export function allocateScanColor(usedColors: Set<string>): string {
  return SCAN_PALETTE.find(c => !usedColors.has(c)) ?? SCAN_PALETTE[usedColors.size % SCAN_PALETTE.length];
}

export type { ScanParameters } from './scanParameters';
