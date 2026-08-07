// Crown-fitting scenario detection + run options.
//
// The Fit Crown & Metrics tool fits a geometric shape (ellipsoid / rectangular
// prism / cone / alpha shape) to a tree's CROWN and reports per-crown metrics.
// It requires each input scan to be a segmented individual tree with the ground
// handled. Three classification labels drive HOW a scan is fit:
//
//   ground_class  (1=ground, 2=non-ground)  — height baseline + drop ground pts
//   tree_instance (0=unassigned, 1..N)      — one crown per tree in the cloud
//   wood_class    (1=wood, 2=leaf)           — crown = leaf points only
//
// The tricky product rule: when a label is ABSENT we cannot tell whether the
// user handled that step manually (removed ground / split one tree per cloud) or
// simply forgot to run the automated segmentation. So a missing label is a
// WARNING, never a silent proceed and never a hard block on a legitimate manual
// workflow. We hard-disable a scan only when it is structurally unusable (too
// few points, or no backing data source to compute from).
//
// This module is pure + stateless — safe to unit-test directly. It reads only
// what the renderer already holds per scan (octree attribute metadata or flat
// scalarFields), via columnSlugs / attribute ranges.
import type { Scan } from './scan';
import { columnSlugs, hasData } from './scan';
import {
  GROUND_CLASS_ATTRIBUTE,
  WOOD_CLASS_ATTRIBUTE,
  TREE_INSTANCE_ATTRIBUTE,
  treeInstanceColor,
  rgbToHex,
} from './classification';

// The four crown shapes the backend can fit. Matches the backend Literal.
export type CrownShape = 'ellipsoid' | 'prism' | 'cone' | 'alpha';

export const CROWN_SHAPE_LABELS: Record<CrownShape, string> = {
  ellipsoid: 'Ellipsoid',
  prism: 'Rectangular prism',
  cone: 'Cone',
  alpha: 'Alpha shape',
};

export const CROWN_SHAPES: CrownShape[] = ['ellipsoid', 'prism', 'cone', 'alpha'];

// A scan needs at least this many readable points before a crown fit is even
// attempted — below it, PCA / shape fitting is meaningless.
export const MIN_CROWN_POINTS = 50;

// How tree height is measured. 'ground_class' uses the min-Z of labelled ground
// points; 'min_z' falls back to the tree cloud's own lowest point (works when
// ground was removed manually and no labels remain).
export type GroundBaseline = 'ground_class' | 'min_z';

// Per-scan eligibility + resolved fit inputs, computed from the labels present.
export interface CrownFitScanEligibility {
  scanId: string;
  eligible: boolean;
  // Set when the scan is structurally unusable — the picker greys the row and
  // shows this as the reason. Distinct from `warning` (enabled-but-caveated).
  disabledReason?: string;
  // Composed soft warning for the ambiguity cases (missing labels). The scan is
  // still eligible; the modal surfaces this so the user can go run segmentation
  // first if they meant to. Empty/undefined when all labels are present.
  warning?: string;
  hasGround: boolean;
  hasTree: boolean;
  hasWood: boolean;
  // Distinct nonzero tree_instance ids present (sorted). Only meaningful when
  // hasTree; drives 'multiTree' fitting (one crown per id).
  treeInstanceIds?: number[];
  // 'multiTree' when the cloud carries ≥2 distinct trees (one crown each);
  // 'single' when it's a single tree (labelled or assumed).
  mode: 'single' | 'multiTree';
  // Resolved backend inputs.
  useLeafOnly: boolean;
  groundBaseline: GroundBaseline;
  pointCount: number;
}

// Distinct nonzero integer tree_instance ids a cloud carries. tree_instance is
// only exposed as a [min,max] range on the octree (individual values live in the
// backend session), or as flat scalarFields values. We read the range and, when
// flat values exist, the exact distinct set.
function treeInstanceIds(scan: Scan): number[] {
  const oct = scan.data?.octree;
  // Flat cloud: exact distinct values from the scalar field.
  const flat = scan.data?.scalarFields?.[TREE_INSTANCE_ATTRIBUTE];
  if (flat?.values && flat.values.length > 0) {
    const set = new Set<number>();
    for (const v of flat.values) {
      const id = Math.round(v);
      if (id > 0) set.add(id);
    }
    return [...set].sort((a, b) => a - b);
  }
  // Octree cloud: we only know the [min,max] range, so enumerate 1..max. The
  // backend re-reads the true distinct set from the session; here we only need
  // to know whether ≥2 trees exist (mode) and roughly how many.
  const range = oct?.attributeRanges?.[TREE_INSTANCE_ATTRIBUTE];
  if (range) {
    const max = Math.round(Array.isArray(range.max) ? range.max[0] : (range.max as unknown as number));
    if (Number.isFinite(max) && max >= 1) {
      const ids: number[] = [];
      for (let i = 1; i <= max; i++) ids.push(i);
      return ids;
    }
  }
  return [];
}

const NO_TREE_WARNING =
  'No tree segmentation detected. The fit assumes this cloud is a single ' +
  'manually-segmented tree. If it contains multiple trees or unsegmented data, ' +
  'run tree segmentation first (or split trees into separate clouds).';

const NO_GROUND_WARNING =
  'No ground segmentation detected. Tree height uses the lowest point as the ' +
  'ground baseline. Make sure the ground was removed / the tree base sits at ' +
  'ground level, or run ground segmentation.';

const NO_WOOD_WARNING =
  'No leaf/wood segmentation detected. The crown will include trunk and branch ' +
  'points. Run leaf/wood segmentation for a leaf-only crown.';

// Decide eligibility + resolved fit inputs for a single scan from the labels it
// carries. See the module header for the ground/tree/wood decision rules.
export function evaluateScanForCrownFit(scan: Scan): CrownFitScanEligibility {
  const slugs = columnSlugs(scan);
  const hasGround = slugs.has(GROUND_CLASS_ATTRIBUTE);
  const hasTree = slugs.has(TREE_INSTANCE_ATTRIBUTE);
  const hasWood = slugs.has(WOOD_CLASS_ATTRIBUTE);
  const pointCount = scan.data?.pointCount ?? 0;

  const ids = hasTree ? treeInstanceIds(scan) : [];
  const mode: 'single' | 'multiTree' = ids.length >= 2 ? 'multiTree' : 'single';

  const base: CrownFitScanEligibility = {
    scanId: scan.id,
    eligible: false,
    hasGround,
    hasTree,
    hasWood,
    treeInstanceIds: ids.length > 0 ? ids : undefined,
    mode,
    useLeafOnly: hasWood,
    groundBaseline: hasGround ? 'ground_class' : 'min_z',
    pointCount,
  };

  // Hard-disable: structurally unusable scans.
  if (!hasData(scan)) {
    return { ...base, disabledReason: 'Scan has no point data.' };
  }
  const oct = scan.data.octree;
  const hasSource = !!(oct?.sessionId || oct?.sourceXyzPath);
  if (!hasSource) {
    return { ...base, disabledReason: 'Scan has no backing data source; re-import to fit.' };
  }
  if (pointCount < MIN_CROWN_POINTS) {
    return { ...base, disabledReason: 'Too few points to fit a crown.' };
  }

  // Eligible — compose the soft warning from the missing dimensions.
  const parts: string[] = [];
  if (!hasTree) parts.push(NO_TREE_WARNING);
  if (!hasGround) parts.push(NO_GROUND_WARNING);
  if (!hasWood) parts.push(NO_WOOD_WARNING);

  return {
    ...base,
    eligible: true,
    warning: parts.length > 0 ? parts.join(' ') : undefined,
  };
}

// ==================== Run options (remembered in the electron store) ====================

export interface CrownFitOptions {
  shape: CrownShape;
  // Fuzziness / strictness in [0,1]. 0 = keep every point (tight bound around
  // the full crown incl. stray branches); 1 = trim the outermost points hardest
  // so a lone branch shooting outside the crown doesn't inflate the shape.
  strictness: number;
  // Optional alpha-shape radius override (m). null = auto (mean NN dist × 2).
  alpha: number | null;
  // Export a per-crown metrics CSV after the fit completes.
  exportCsv: boolean;
}

// Fuzziness is capped at this maximum in the UI: past ~0.5 the trim gets too
// aggressive to be useful, and the useful working range is the low end.
export const MAX_STRICTNESS = 0.5;

export const DEFAULT_CROWN_FIT_OPTIONS: CrownFitOptions = {
  shape: 'ellipsoid',
  strictness: 0.2,
  alpha: null,
  exportCsv: false,
};

export const CROWN_FIT_OPTIONS_STORE_KEY = 'crownFit.options';

// Merge a (possibly partial / stale) stored value over the defaults so a missing
// or older persisted blob can never produce an invalid options object.
export function coerceCrownFitOptions(stored: unknown): CrownFitOptions {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_CROWN_FIT_OPTIONS };
  const s = stored as Partial<CrownFitOptions>;
  const shape: CrownShape = CROWN_SHAPES.includes(s.shape as CrownShape)
    ? (s.shape as CrownShape)
    : DEFAULT_CROWN_FIT_OPTIONS.shape;
  const strictness =
    typeof s.strictness === 'number' && Number.isFinite(s.strictness)
      ? Math.max(0, Math.min(MAX_STRICTNESS, s.strictness))
      : DEFAULT_CROWN_FIT_OPTIONS.strictness;
  const alpha =
    typeof s.alpha === 'number' && Number.isFinite(s.alpha) && s.alpha > 0 ? s.alpha : null;
  const exportCsv =
    typeof s.exportCsv === 'boolean' ? s.exportCsv : DEFAULT_CROWN_FIT_OPTIONS.exportCsv;
  return { shape, strictness, alpha, exportCsv };
}

// ==================== Crown mesh colors ====================

// The tree-instance color for a tree id, matching the `tree_instance` scalar
// colormap used in the viewer — so anything derived from a segmented cloud (a
// fitted crown, a cloud split out per tree) reads with the same colour as its
// tree. Returns null for the sentinel id 0 (whole-cloud single tree) and for
// unassigned/negative ids, where there is no tree-instance colour to match.
export function crownColorForTreeId(treeId: number): string | null {
  if (treeId <= 0) return null;
  return rgbToHex(treeInstanceColor(treeId));
}

// A distinct auto-assigned colour for a crown when there's no tree id to match:
// the first fixed-palette entry not already taken, cycling once exhausted. Mirrors
// allocateScanColor so scan and crown palettes read consistently.
const CROWN_PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

export function allocateCrownColor(usedColors: Set<string>): string {
  return CROWN_PALETTE.find((c) => !usedColors.has(c))
    ?? CROWN_PALETTE[usedColors.size % CROWN_PALETTE.length];
}
