// Stand summary and biomass for a tree inventory.
//
// Pure arithmetic over the tree list, done in the renderer so it follows the
// user's own edits at once: a tree marked dead leaves the live-stand figures,
// the minimum DBH and the plot area are settings, and a QSM built later adds
// its woody volume. The definitions and their sources are on
// docs/docs/concepts/stand-metrics.md; the geometry that needs crown polygons
// (plot boundary, canopy union, competition) comes from the backend
// (backend-api/stand_metrics.py).

import type { TreeInventoryTree } from '../utils/backendApi';
import type { TreeEdits } from './treeInventory';
import { csvCell } from './pointPick';

export type BiomassMethod = 'none' | 'chave2014' | 'jenkins2003' | 'qsm';

/**
 * Jenkins et al. (2003), Table 4: bm = exp(β0 + β1 ln dbh), bm kg total
 * above-ground, dbh cm, for trees ≥ 2.5 cm. `maxDbhCm` is the largest tree in
 * the group's data; beyond it the equation is an extrapolation.
 */
export const JENKINS_GROUPS = {
  aspen_alder_cottonwood_willow: { label: 'Aspen / alder / cottonwood / willow', b0: -2.2094, b1: 2.3867, maxDbhCm: 70 },
  soft_maple_birch: { label: 'Soft maple / birch', b0: -1.9123, b1: 2.3651, maxDbhCm: 66 },
  mixed_hardwood: { label: 'Mixed hardwood', b0: -2.4800, b1: 2.4835, maxDbhCm: 56 },
  hard_maple_oak_hickory_beech: { label: 'Hard maple / oak / hickory / beech', b0: -2.0127, b1: 2.4342, maxDbhCm: 73 },
  cedar_larch: { label: 'Cedar / larch', b0: -2.0336, b1: 2.2592, maxDbhCm: 250 },
  douglas_fir: { label: 'Douglas-fir', b0: -2.2304, b1: 2.4435, maxDbhCm: 210 },
  true_fir_hemlock: { label: 'True fir / hemlock', b0: -2.5384, b1: 2.4814, maxDbhCm: 230 },
  pine: { label: 'Pine', b0: -2.5356, b1: 2.4349, maxDbhCm: 180 },
  spruce: { label: 'Spruce', b0: -2.0773, b1: 2.3323, maxDbhCm: 250 },
  woodland_juniper_oak_mesquite: { label: 'Woodland (juniper / oak / mesquite)', b0: -0.7152, b1: 1.7029, maxDbhCm: 78 },
} as const;
export type JenkinsGroup = keyof typeof JENKINS_GROUPS;

export interface StandSettings {
  /** Trees below this DBH (cm) are left out of the stand figures. */
  minDbhCm: number;
  /** Plot area in m²; null uses the measured plot boundary. */
  plotAreaM2: number | null;
  /** Leave trees whose status is 'dead' out of the stand figures. */
  excludeDead: boolean;
  dbhClassCm: number;
  heightClassM: number;
  biomassMethod: BiomassMethod;
  /** Wood density (oven-dry mass / green volume), g/cm³. */
  woodDensity: number;
  jenkinsGroup: JenkinsGroup;
}

export const DEFAULT_STAND_SETTINGS: StandSettings = {
  minDbhCm: 5,
  plotAreaM2: null,
  excludeDead: true,
  dbhClassCm: 5,
  heightClassM: 2,
  biomassMethod: 'none',
  woodDensity: 0.5,
  jenkinsGroup: 'mixed_hardwood',
};

export interface HistogramBin { lo: number; hi: number; count: number }

export interface StandSummary {
  plotAreaM2: number | null;
  plotAreaSource: 'measured' | 'entered' | 'none';
  nTrees: number;
  stemsPerHa: number | null;
  basalAreaM2PerHa: number | null;
  qmdCm: number | null;
  loreyHeightM: number | null;
  meanHeightM: number | null;
  maxHeightM: number | null;
  canopyCover: number | null;
  biomassKg: number | null;
  biomassMgPerHa: number | null;
  /** Trees in the stand whose biomass could not be estimated. */
  biomassMissing: number;
  /** Trees larger than the equation's data (Jenkins groups only). */
  biomassExtrapolated: number;
  dbhHistogram: HistogramBin[];
  heightHistogram: HistogramBin[];
}

/**
 * Above-ground biomass of one tree, kg, or null when the method cannot apply.
 *
 *  - chave2014: AGB = 0.0673 · (ρ D² H)^0.976, D in cm, H in m, ρ in g/cm³
 *    (Chave et al. 2014). Needs DBH and height.
 *  - jenkins2003: exp(β0 + β1 ln D), D in cm, one US species group's
 *    coefficients (Jenkins et al. 2003). Needs DBH only.
 *  - qsm: woody volume (m³) × ρ (g/cm³ = 1000 kg/m³), the volume from the
 *    tree's QSM (Calders et al. 2015). Needs a QSM volume.
 */
export function treeBiomassKg(
  t: TreeInventoryTree, method: BiomassMethod, woodDensity: number, qsmVolumeM3?: number | null,
  jenkinsGroup: JenkinsGroup = 'mixed_hardwood',
): number | null {
  if (method === 'jenkins2003') {
    if (t.dbh_m == null || !(t.dbh_m > 0)) return null;
    const g = JENKINS_GROUPS[jenkinsGroup];
    return Math.exp(g.b0 + g.b1 * Math.log(t.dbh_m * 100));
  }
  if (method === 'chave2014') {
    if (t.dbh_m == null || t.height_m == null || !(t.dbh_m > 0) || !(t.height_m > 0)) return null;
    const dCm = t.dbh_m * 100;
    return 0.0673 * Math.pow(woodDensity * dCm * dCm * t.height_m, 0.976);
  }
  if (method === 'qsm') {
    if (qsmVolumeM3 == null || !(qsmVolumeM3 > 0)) return null;
    return qsmVolumeM3 * woodDensity * 1000;
  }
  return null;
}

function histogram(values: number[], width: number): HistogramBin[] {
  if (values.length === 0 || !(width > 0)) return [];
  // Edges as lo + k·width, rounded, never by repeated addition: summing 0.3
  // six times gives 1.7999999999999998, which is then shown and exported.
  const edge = (k: number) => Math.round((k0 + k) * width * 1e9) / 1e9;
  const k0 = Math.floor(Math.min(...values) / width + 1e-9);
  const n = Math.floor(Math.max(...values) / width + 1e-9) - k0 + 1;
  const bins: HistogramBin[] = Array.from({ length: n }, (_, k) => ({ lo: edge(k), hi: edge(k + 1), count: 0 }));
  for (const v of values) {
    const k = Math.min(n - 1, Math.max(0, Math.floor(v / width + 1e-9) - k0));
    bins[k].count++;
  }
  return bins;
}

/** Which trees count toward the stand figures under these settings. */
export function standTrees(trees: TreeInventoryTree[], edits: TreeEdits, s: StandSettings): TreeInventoryTree[] {
  return trees.filter(t => {
    if (t.dbh_m == null || !(t.dbh_m * 100 >= s.minDbhCm)) return false;
    if (s.excludeDead && edits[t.tree_id]?.status === 'dead') return false;
    return true;
  });
}

/**
 * The stand summary:
 *   stems/ha  = N / A · 10⁴
 *   BA/ha     = Σ π/4 · dᵢ² / A · 10⁴           (m²/ha)
 *   QMD       = √(Σ dᵢ² / N)                    (Curtis & Marshall 2000)
 *   Lorey's H = Σ gᵢ hᵢ / Σ gᵢ                  (basal-area-weighted height)
 *   cover     = crown union area / A
 * with A the plot area in m².
 */
export function summarizeStand(
  trees: TreeInventoryTree[], edits: TreeEdits, s: StandSettings,
  measured: { plotAreaM2: number | null; crownUnionAreaM2: number | null },
  qsmVolumes: Record<number, number> = {},
): StandSummary {
  const stand = standTrees(trees, edits, s);
  const entered = s.plotAreaM2 != null && s.plotAreaM2 > 0;
  const area = entered ? s.plotAreaM2! : (measured.plotAreaM2 && measured.plotAreaM2 > 0 ? measured.plotAreaM2 : null);
  const perHa = (x: number) => (area ? (x / area) * 10000 : null);

  const n = stand.length;
  const d = stand.map(t => t.dbh_m as number);
  const g = d.map(x => (Math.PI / 4) * x * x);
  const sumG = g.reduce((a, b) => a + b, 0);
  const withH = stand.filter(t => t.height_m != null && Number.isFinite(t.height_m));
  const gH = stand.reduce((acc, t, i) => (t.height_m != null ? acc + g[i] * t.height_m : acc), 0);
  const gWithH = stand.reduce((acc, t, i) => (t.height_m != null ? acc + g[i] : acc), 0);

  let biomass: number | null = null;
  let missing = 0;
  let extrapolated = 0;
  if (s.biomassMethod !== 'none') {
    biomass = 0;
    for (const t of stand) {
      const b = treeBiomassKg(t, s.biomassMethod, s.woodDensity, qsmVolumes[t.tree_id], s.jenkinsGroup);
      if (b == null) missing++; else biomass += b;
      if (s.biomassMethod === 'jenkins2003' && (t.dbh_m ?? 0) * 100 > JENKINS_GROUPS[s.jenkinsGroup].maxDbhCm) {
        extrapolated++;
      }
    }
  }

  // Canopy cover is a property of the canopy, not of the stand filter: every
  // crown the backend measured, over the plot. Rescaled when the user enters
  // an area, since the union was measured inside the measured boundary.
  const cover = measured.crownUnionAreaM2 != null && area
    ? Math.min(1, measured.crownUnionAreaM2 / area) : null;

  return {
    plotAreaM2: area,
    plotAreaSource: entered ? 'entered' : area ? 'measured' : 'none',
    nTrees: n,
    stemsPerHa: perHa(n),
    basalAreaM2PerHa: perHa(sumG),
    qmdCm: n ? Math.sqrt(d.reduce((a, x) => a + x * x, 0) / n) * 100 : null,
    loreyHeightM: gWithH > 0 ? gH / gWithH : null,
    meanHeightM: withH.length ? withH.reduce((a, t) => a + (t.height_m as number), 0) / withH.length : null,
    maxHeightM: withH.length ? Math.max(...withH.map(t => t.height_m as number)) : null,
    canopyCover: cover,
    biomassKg: biomass,
    biomassMgPerHa: biomass == null ? null : perHa(biomass / 1000),
    biomassMissing: missing,
    biomassExtrapolated: extrapolated,
    dbhHistogram: histogram(d.map(x => x * 100), s.dbhClassCm),
    heightHistogram: histogram(withH.map(t => t.height_m as number), s.heightClassM),
  };
}

function num(v: number | null | undefined, digits = 4): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '';
}

/**
 * The stand CSV: a `metric,value,unit` block, a blank line, then the DBH and
 * height class tables (`class,lo,hi,count`). Settings are written with the
 * figures so the file records how they were produced.
 */
export function buildStandCsv(scanName: string, sum: StandSummary, s: StandSettings): string {
  const rows: string[][] = [
    ['metric', 'value', 'unit'],
    ['scan_name', scanName, ''],
    ['plot_area', num(sum.plotAreaM2, 2), 'm2'],
    ['plot_area_source', sum.plotAreaSource, ''],
    ['min_dbh', num(s.minDbhCm, 1), 'cm'],
    ['exclude_dead', String(s.excludeDead), ''],
    ['n_trees', String(sum.nTrees), ''],
    ['stems_per_ha', num(sum.stemsPerHa, 1), '1/ha'],
    ['basal_area_per_ha', num(sum.basalAreaM2PerHa, 3), 'm2/ha'],
    ['qmd', num(sum.qmdCm, 2), 'cm'],
    ['lorey_height', num(sum.loreyHeightM, 2), 'm'],
    ['mean_height', num(sum.meanHeightM, 2), 'm'],
    ['max_height', num(sum.maxHeightM, 2), 'm'],
    ['canopy_cover', num(sum.canopyCover, 4), 'fraction'],
    ['biomass_method', s.biomassMethod, ''],
    ['wood_density', s.biomassMethod === 'chave2014' || s.biomassMethod === 'qsm' ? num(s.woodDensity, 3) : '', 'g/cm3'],
    ['jenkins_group', s.biomassMethod === 'jenkins2003' ? s.jenkinsGroup : '', ''],
    ['biomass', num(sum.biomassKg, 1), 'kg'],
    ['biomass_per_ha', num(sum.biomassMgPerHa, 3), 'Mg/ha'],
    ['biomass_trees_missing', s.biomassMethod === 'none' ? '' : String(sum.biomassMissing), ''],
    ['biomass_trees_beyond_equation_range', s.biomassMethod === 'jenkins2003' ? String(sum.biomassExtrapolated) : '', ''],
    [],
    ['class', 'lo', 'hi', 'count'],
    ...sum.dbhHistogram.map(b => ['dbh_cm', num(b.lo, 1), num(b.hi, 1), String(b.count)]),
    ...sum.heightHistogram.map(b => ['height_m', num(b.lo, 1), num(b.hi, 1), String(b.count)]),
  ];
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}
