// QSM (Quantitative Structure Model) result distributions — the per-tree
// analytics behind the "View results" window.
//
// Pure logic (no React, no three.js), so it can be unit-tested and reused. It
// operates directly on the in-memory QSM payload (cylinders + shoots + metrics)
// that /api/qsm/build already returned and PointCloudViewer holds in state — no
// backend round-trip. The cylinder/shoot field shapes mirror the backend types
// in utils/backendApi.ts.
//
// The quantities computed here are the canonical things tree-QSM tools (TreeQSM,
// SimpleForest, aRchi) report for a single tree: the stem taper profile, how
// material partitions across branch orders, the branch-angle distribution, the
// vertical profile of woody volume/length, and — critically — fit-quality
// diagnostics (surf_cov / MAD) so a user can judge whether to trust the model.
//
// Units: cylinder radius/positions are METERS. We surface diameters in mm and
// lengths/heights in m, matching the existing QSM metrics UI.

import type { QSMCylinder, QSMShoot, QSMMetrics } from '../utils/backendApi';

// ---------------------------------------------------------------------------
// Per-cylinder derived geometry
// ---------------------------------------------------------------------------

type Vec3 = readonly [number, number, number];

function sub(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function norm(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// Length of a cylinder's axis (meters).
export function cylinderLength(c: QSMCylinder): number {
  return norm(sub(c.end, c.start));
}

// Woody volume of a cylinder, π r² L (cubic meters).
export function cylinderVolume(c: QSMCylinder): number {
  return Math.PI * c.radius * c.radius * cylinderLength(c);
}

// Midpoint height (z) of a cylinder.
function cylinderMidZ(c: QSMCylinder): number {
  return (c.start[2] + c.end[2]) * 0.5;
}

// Unit axis (start->end). Returns null for a degenerate zero-length cylinder.
function cylinderAxis(c: QSMCylinder): [number, number, number] | null {
  const d = sub(c.end, c.start);
  const L = norm(d);
  if (L < 1e-12) return null;
  return [d[0] / L, d[1] / L, d[2] / L];
}

// The lowest z across all cylinders — the tree base. 0 for an empty model.
export function treeBaseZ(cyls: QSMCylinder[]): number {
  let min = Infinity;
  for (const c of cyls) {
    min = Math.min(min, c.start[2], c.end[2]);
  }
  return Number.isFinite(min) ? min : 0;
}

// The highest z across all cylinders — the tree top.
function treeTopZ(cyls: QSMCylinder[]): number {
  let max = -Infinity;
  for (const c of cyls) {
    max = Math.max(max, c.start[2], c.end[2]);
  }
  return Number.isFinite(max) ? max : 0;
}

// ---------------------------------------------------------------------------
// Stem taper profile (diameter vs height)
// ---------------------------------------------------------------------------

export interface TaperPoint {
  heightM: number;       // midpoint height above the tree base
  diameterMm: number;    // 2 * radius, in mm
  lowCoverage: boolean;  // whether this trunk cylinder was seen one-sided
}

// The trunk taper: rank-0 (trunk) cylinders as (height, diameter) points,
// sorted by height. This is the signature QSM plot — trunk girth narrowing with
// height. Height is measured above the tree base so the axis starts at 0.
export function taperProfile(cyls: QSMCylinder[]): TaperPoint[] {
  const base = treeBaseZ(cyls);
  return cyls
    .filter(c => c.rank === 0)
    .map(c => ({
      heightM: cylinderMidZ(c) - base,
      diameterMm: 2 * c.radius * 1000,
      lowCoverage: lowCoveragePredicate(c),
    }))
    .sort((a, b) => a.heightM - b.heightM);
}

// Interpolated diameter (mm) at a target height (m above base) along the trunk
// taper, for a reconstructed DBH. Returns null when the profile doesn't span the
// target height (no extrapolation — DBH at 1.3 m is undefined on a < 1.3 m stem).
export function diameterAtHeight(cyls: QSMCylinder[], heightM: number): number | null {
  const prof = taperProfile(cyls);
  if (prof.length === 0) return null;
  if (heightM < prof[0].heightM || heightM > prof[prof.length - 1].heightM) return null;
  for (let i = 1; i < prof.length; i++) {
    const a = prof[i - 1];
    const b = prof[i];
    if (heightM >= a.heightM && heightM <= b.heightM) {
      const span = b.heightM - a.heightM;
      if (span < 1e-9) return a.diameterMm;
      const t = (heightM - a.heightM) / span;
      return a.diameterMm + t * (b.diameterMm - a.diameterMm);
    }
  }
  return prof[prof.length - 1].diameterMm;
}

// ---------------------------------------------------------------------------
// Branch-order (rank) distribution
// ---------------------------------------------------------------------------

export interface RankBar {
  rank: number;
  label: string;          // "Trunk" | "Scaffold" | "Order 2" ...
  nShoots: number;
  totalLengthM: number;
  woodyVolM3: number;
}

// Human-readable rank label: 0 = Trunk, 1 = Scaffold, n>=2 = Order n.
export function rankLabel(rank: number): string {
  if (rank === 0) return 'Trunk';
  if (rank === 1) return 'Scaffold';
  return `Order ${rank}`;
}

// Per-rank bars straight from the precomputed metrics.per_rank breakdown. Empty
// when there are no metrics. This is exact backend output, not re-derived.
export function rankBars(metrics: QSMMetrics | null): RankBar[] {
  if (!metrics) return [];
  return metrics.per_rank
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map(r => ({
      rank: r.rank,
      label: rankLabel(r.rank),
      nShoots: r.n_shoots,
      totalLengthM: r.total_length_m,
      woodyVolM3: r.woody_volume_m3,
    }));
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

export interface CountHistogram {
  binCenters: number[];  // bin midpoints
  binWidth: number;
  counts: number[];      // raw count per bin
  total: number;         // total counted (excludes excluded items)
  excluded: number;      // items dropped (e.g. null metric, degenerate geometry)
}

function emptyHistogram(lo: number, binWidth: number, binCount: number): CountHistogram {
  const binCenters = new Array(binCount);
  for (let b = 0; b < binCount; b++) binCenters[b] = lo + (b + 0.5) * binWidth;
  return { binCenters, binWidth, counts: new Array(binCount).fill(0), total: 0, excluded: 0 };
}

// Bin a list of finite values into [lo, hi) over binCount equal bins; the hi
// endpoint and any overflow fall into the last bin.
function countHistogram(values: number[], lo: number, hi: number, binCount: number): CountHistogram {
  const h = emptyHistogram(lo, (hi - lo) / binCount, binCount);
  for (const v of values) {
    if (!Number.isFinite(v)) { h.excluded++; continue; }
    let b = Math.floor((v - lo) / h.binWidth);
    if (b < 0) b = 0;
    if (b >= binCount) b = binCount - 1;
    h.counts[b]++;
    h.total++;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Branch-angle distribution (fork angle)
// ---------------------------------------------------------------------------

// The branching angle of each shoot: the angle (deg, 0..90) between its parent
// cylinder's axis and the shoot's first (base) cylinder axis. This is the
// standard fork-angle convention — a narrow angle means the branch runs nearly
// parallel to its parent (included-bark risk), a wide angle means it splays out.
//
// Only shoots with a real parent (parent_cyl_id >= 0) and resolvable axes
// contribute; the trunk and any orphaned shoots are excluded.
export function branchAngles(cyls: QSMCylinder[], shoots: QSMShoot[]): number[] {
  const byId = new Map<number, QSMCylinder>();
  for (const c of cyls) byId.set(c.cyl_id, c);

  const angles: number[] = [];
  for (const s of shoots) {
    if (s.parent_cyl_id < 0 || s.cylinder_ids.length === 0) continue;
    const parent = byId.get(s.parent_cyl_id);
    const child = byId.get(s.cylinder_ids[0]);
    if (!parent || !child) continue;
    const pa = cylinderAxis(parent);
    const ca = cylinderAxis(child);
    if (!pa || !ca) continue;
    // Use |cos| so the angle is the acute angle between the two axis lines
    // (independent of which way each cylinder was stored), giving 0..90°.
    const cos = Math.min(1, Math.max(0, Math.abs(dot(pa, ca))));
    angles.push((Math.acos(cos) * 180) / Math.PI);
  }
  return angles;
}

// Histogram of branch fork angles over 0..90°. Default 18 bins (5° wide).
export function branchAngleHistogram(
  cyls: QSMCylinder[],
  shoots: QSMShoot[],
  bins = 18,
): CountHistogram {
  return countHistogram(branchAngles(cyls, shoots), 0, 90, bins);
}

// ---------------------------------------------------------------------------
// Vertical profile (woody volume + length by height)
// ---------------------------------------------------------------------------

export interface HeightBin {
  heightLo: number;  // bin lower edge (m above base)
  heightHi: number;  // bin upper edge
  heightMid: number;
  volM3: number;
  lengthM: number;
}

// Bin each cylinder's volume and length into nBins equal height bands from the
// tree base to its top, by cylinder midpoint height. Reads as a tree silhouette
// when drawn as horizontal bars — where the woody mass actually lives.
export function heightProfile(cyls: QSMCylinder[], nBins = 20): HeightBin[] {
  const base = treeBaseZ(cyls);
  const top = treeTopZ(cyls);
  const span = top - base;
  const width = span > 1e-9 ? span / nBins : 1;

  const out: HeightBin[] = [];
  for (let b = 0; b < nBins; b++) {
    out.push({
      heightLo: b * width,
      heightHi: (b + 1) * width,
      heightMid: (b + 0.5) * width,
      volM3: 0,
      lengthM: 0,
    });
  }
  for (const c of cyls) {
    const h = cylinderMidZ(c) - base;
    let b = span > 1e-9 ? Math.floor(h / width) : 0;
    if (b < 0) b = 0;
    if (b >= nBins) b = nBins - 1;
    out[b].volM3 += cylinderVolume(c);
    out[b].lengthM += cylinderLength(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fit-quality diagnostics (surf_cov / MAD) — the trust layer
// ---------------------------------------------------------------------------

// IMPORTANT — what surf_cov actually means here, and why this is NOT a pass/fail.
//
// surf_cov is the fraction of a cylinder's lateral surface that the scanner's
// points cover. On terrestrial LiDAR a branch is only ever seen from ONE side,
// so even a perfectly-fit cylinder has surf_cov well under 1 — on real trees the
// median is ~0.25, and thin twigs sit near 0.08, purely from self-occlusion. Low
// coverage is therefore the NORMAL TLS condition, not a fit failure: the backend
// treats surf_cov as a continuous TRUST weight (trust = clip(surf_cov / 0.7)) and
// its radius-correction stage is explicitly DESIGNED to lean on the taper /
// pipe-model where coverage runs out. That's why a model can look excellent while
// raw coverage is low.
//
// So we present coverage as an OCCLUSION DIAGNOSTIC, not a quality gate, and we
// weight everything by VOLUME — the trunk and scaffolds (which dominate what you
// see and what the metrics report) count for far more than a swarm of thin twigs.
// We deliberately do NOT gate on mad/radius: for a sub-cm twig the residual is
// comparable to the radius itself (ratios of 100+ are routine and harmless), so a
// relative-MAD threshold flags essentially everything. MAD is shown in absolute
// mm as information only.

// surf_cov at/above which a cylinder's fit is FULLY trusted — the same ramp the
// backend's radius correction uses (qsm/radius.py sc_full).
export const SURF_COV_FULL_TRUST = 0.7;
// Below this volume-weighted coverage a cylinder is considered meaningfully
// under-covered (worth tinting in the table / plots). Chosen against the real TLS
// distribution: structural wood clears it easily, only genuinely one-sided
// cylinders fall below.
export const LOW_COVERAGE = 0.1;

// Per-cylinder TRUST in [0,1]: clip(surf_cov / full_trust). A null surf_cov (the
// fit couldn't measure coverage) is treated as 0 trust.
export function coverageTrust(c: QSMCylinder): number {
  if (c.surf_cov == null) return 0;
  return Math.min(1, Math.max(0, c.surf_cov / SURF_COV_FULL_TRUST));
}

// A cylinder whose coverage is low ENOUGH to be worth flagging — only used to
// tint suspect structural cylinders, never to declare the model "bad".
export function lowCoveragePredicate(c: QSMCylinder): boolean {
  return c.surf_cov != null && c.surf_cov < LOW_COVERAGE;
}

// Histogram of surf_cov over [0,1]. Nulls are excluded (reported as `excluded`),
// not treated as 0. Default 20 bins (0.05 wide).
export function surfCovHistogram(cyls: QSMCylinder[], bins = 20): CountHistogram {
  const vals: number[] = [];
  let excluded = 0;
  for (const c of cyls) {
    if (c.surf_cov == null) { excluded++; continue; }
    vals.push(c.surf_cov);
  }
  const h = countHistogram(vals, 0, 1, bins);
  h.excluded += excluded;
  return h;
}

// Histogram of ABSOLUTE MAD in millimeters (informational fit-tightness, not a
// gate). A long right tail is expected from a few thin/occluded cylinders, so we
// cap the axis at `maxMm` with everything above landing in the overflow bin.
// Nulls are excluded. Default 20 bins over 0..20 mm.
export function madHistogram(cyls: QSMCylinder[], bins = 20, maxMm = 20): CountHistogram {
  const vals: number[] = [];
  let excluded = 0;
  for (const c of cyls) {
    if (c.mad == null) { excluded++; continue; }
    vals.push(c.mad * 1000);
  }
  const h = countHistogram(vals, 0, maxMm, bins);
  h.excluded += excluded;
  return h;
}

// Volume-weighted median of a per-cylinder quantity: the value at which half the
// woody VOLUME lies below. NaN when no cylinder qualifies.
function volWeightedMedian(
  cyls: QSMCylinder[],
  value: (c: QSMCylinder) => number | null,
): number {
  const pairs: { v: number; w: number }[] = [];
  let total = 0;
  for (const c of cyls) {
    const v = value(c);
    if (v == null) continue;
    const w = cylinderVolume(c);
    pairs.push({ v, w });
    total += w;
  }
  if (total <= 0) return NaN;
  pairs.sort((a, b) => a.v - b.v);
  let cum = 0;
  for (const p of pairs) {
    cum += p.w;
    if (cum >= total / 2) return p.v;
  }
  return pairs[pairs.length - 1].v;
}

export type CoverageGrade = 'high' | 'moderate' | 'low';

export interface QASummary {
  // Volume-weighted median surface coverage — half the woody VOLUME is better
  // covered than this. The headline number, since it tracks the structural wood.
  volMedianSurfCov: number;
  // Volume-weighted mean TRUST (clip(surf_cov/0.7)) — how much, on a volume
  // basis, the fitted radii are point-supported vs. taper/pipe-model inferred.
  volMeanTrust: number;
  // Share of woody volume that is well covered (surf_cov >= full trust).
  wellCoveredVolFrac: number;
  // Median absolute fit residual (MAD) over the woody volume, in millimeters.
  volMedianMadMm: number;
  // Share of woody volume in under-covered (one-sided) cylinders — the honest
  // "how much of the structure is the model inferring rather than measuring".
  lowCoverageVolFrac: number;
  // Fraction of cylinders that even carry a coverage metric.
  metricCoverageFrac: number;
  grade: CoverageGrade;
}

// Whole-model COVERAGE scorecard (not a fit pass/fail). Everything is volume-
// weighted so the trunk and scaffolds dominate, matching the visual impression.
// "High" when most of the woody volume is well-covered; "Low" when the structure
// is largely one-sided and the model is leaning hard on the taper/pipe-model.
export function qaSummary(cyls: QSMCylinder[]): QASummary {
  const volMedianSurfCov = volWeightedMedian(cyls, c => c.surf_cov);
  const volMedianMadMm = volWeightedMedian(cyls, c => (c.mad == null ? null : c.mad * 1000));

  let totalVol = 0;
  let trustVol = 0;
  let wellVol = 0;
  let lowVol = 0;
  for (const c of cyls) {
    const v = cylinderVolume(c);
    totalVol += v;
    trustVol += v * coverageTrust(c);
    if (c.surf_cov != null && c.surf_cov >= SURF_COV_FULL_TRUST) wellVol += v;
    if (lowCoveragePredicate(c)) lowVol += v;
  }
  const volMeanTrust = totalVol > 0 ? trustVol / totalVol : 0;
  const wellCoveredVolFrac = totalVol > 0 ? wellVol / totalVol : 0;
  const lowCoverageVolFrac = totalVol > 0 ? lowVol / totalVol : 0;

  const withMetric = cyls.filter(c => c.surf_cov != null).length;
  const metricCoverageFrac = cyls.length ? withMetric / cyls.length : 0;

  // Grade on the volume-weighted trust — how point-supported the STRUCTURE is.
  let grade: CoverageGrade = 'low';
  if (volMeanTrust >= 0.6) grade = 'high';
  else if (volMeanTrust >= 0.35) grade = 'moderate';

  return {
    volMedianSurfCov,
    volMeanTrust,
    wellCoveredVolFrac,
    volMedianMadMm,
    lowCoverageVolFrac,
    metricCoverageFrac,
    grade,
  };
}

// ---------------------------------------------------------------------------
// Per-shoot table
// ---------------------------------------------------------------------------

export interface ShootRow {
  shootId: number;
  rank: number;
  lengthM: number;          // sum of its cylinder lengths
  baseDiameterMm: number;   // diameter of its base cylinder
  branchAngleDeg: number | null;  // fork angle vs parent; null for the trunk
  childCount: number;
  // Volume-weighted surface coverage over the shoot's cylinders (so its thick
  // base counts more than its many thin tips). Null when none carry coverage.
  surfCov: number | null;
  lowCoverage: boolean;     // the shoot's coverage is low (mostly one-sided)
}

// One row per shoot for the sortable table. Pulls together the per-shoot
// aggregates a user drills into when an outlier shows up in the charts.
export function perShootRows(cyls: QSMCylinder[], shoots: QSMShoot[]): ShootRow[] {
  const byId = new Map<number, QSMCylinder>();
  for (const c of cyls) byId.set(c.cyl_id, c);

  const rows: ShootRow[] = [];
  for (const s of shoots) {
    const shootCyls = s.cylinder_ids
      .map(id => byId.get(id))
      .filter((c): c is QSMCylinder => c != null);
    if (shootCyls.length === 0) continue;

    const lengthM = shootCyls.reduce((sum, c) => sum + cylinderLength(c), 0);
    const baseDiameterMm = 2 * shootCyls[0].radius * 1000;

    let branchAngleDeg: number | null = null;
    if (s.parent_cyl_id >= 0) {
      const parent = byId.get(s.parent_cyl_id);
      const pa = parent ? cylinderAxis(parent) : null;
      const ca = cylinderAxis(shootCyls[0]);
      if (pa && ca) {
        const cos = Math.min(1, Math.max(0, Math.abs(dot(pa, ca))));
        branchAngleDeg = (Math.acos(cos) * 180) / Math.PI;
      }
    }

    // Volume-weighted coverage: half-mass median over the shoot's cylinders.
    const surfCov = volWeightedMedian(shootCyls, c => c.surf_cov);
    const surfCovOrNull = Number.isFinite(surfCov) ? surfCov : null;

    rows.push({
      shootId: s.shoot_id,
      rank: s.rank,
      lengthM,
      baseDiameterMm,
      branchAngleDeg,
      childCount: s.child_shoot_ids.length,
      surfCov: surfCovOrNull,
      lowCoverage: surfCovOrNull != null && surfCovOrNull < LOW_COVERAGE,
    });
  }
  return rows;
}
