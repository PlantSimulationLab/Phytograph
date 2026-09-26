import { describe, it, expect } from 'vitest';
import type { TreeInventoryTree } from '../utils/backendApi';
import {
  summarizeStand, treeBiomassKg, standTrees, buildStandCsv, DEFAULT_STAND_SETTINGS, type StandSettings,
} from './standSummary';

const t = (id: number, dbhCm: number | null, h: number | null): TreeInventoryTree => ({
  tree_id: id, n_points: 100, flags: [], dbh_m: dbhCm == null ? null : dbhCm / 100, height_m: h ?? undefined,
});

const S = (over: Partial<StandSettings> = {}): StandSettings => ({ ...DEFAULT_STAND_SETTINGS, ...over });

describe('summarizeStand', () => {
  const trees = [t(1, 30, 20), t(2, 40, 25), t(3, 20, 15), t(4, 3, 4), t(5, null, 18)];
  const measured = { plotAreaM2: 1000, crownUnionAreaM2: 600 };

  it('computes per-hectare figures, QMD and Lorey height exactly', () => {
    const s = summarizeStand(trees, {}, S(), measured);
    // Stand: trees 1-3 (tree 4 is under 5 cm; tree 5 has no DBH).
    expect(s.nTrees).toBe(3);
    expect(s.stemsPerHa).toBeCloseTo(30);
    const g = [0.3, 0.4, 0.2].map(d => Math.PI / 4 * d * d);
    expect(s.basalAreaM2PerHa).toBeCloseTo(g.reduce((a, b) => a + b) * 10, 10);
    expect(s.qmdCm).toBeCloseTo(Math.sqrt((900 + 1600 + 400) / 3), 10);
    expect(s.loreyHeightM).toBeCloseTo((g[0] * 20 + g[1] * 25 + g[2] * 15) / (g[0] + g[1] + g[2]), 10);
    expect(s.meanHeightM).toBeCloseTo(20);
    expect(s.maxHeightM).toBe(25);
    expect(s.canopyCover).toBeCloseTo(0.6);
    expect(s.plotAreaSource).toBe('measured');
  });

  it('an entered plot area overrides the measured one', () => {
    const s = summarizeStand(trees, {}, S({ plotAreaM2: 2000 }), measured);
    expect(s.plotAreaSource).toBe('entered');
    expect(s.stemsPerHa).toBeCloseTo(15);
    expect(s.canopyCover).toBeCloseTo(0.3);
  });

  it('dead trees leave the stand unless asked to keep them', () => {
    const edits = { 2: { species: '', status: 'dead' as const, label: '' } };
    expect(standTrees(trees, edits, S()).map(x => x.tree_id)).toEqual([1, 3]);
    expect(standTrees(trees, edits, S({ excludeDead: false })).map(x => x.tree_id)).toEqual([1, 2, 3]);
  });

  it('without an area there are no per-hectare figures', () => {
    const s = summarizeStand(trees, {}, S(), { plotAreaM2: null, crownUnionAreaM2: null });
    expect(s.stemsPerHa).toBeNull();
    expect(s.basalAreaM2PerHa).toBeNull();
    expect(s.qmdCm).not.toBeNull();
    expect(s.plotAreaSource).toBe('none');
  });

  it('bins DBH and height into classes', () => {
    const s = summarizeStand(trees, {}, S({ minDbhCm: 0 }), measured);
    expect(s.dbhHistogram.map(b => [b.lo, b.count])).toEqual(
      [[0, 1], [5, 0], [10, 0], [15, 0], [20, 1], [25, 0], [30, 1], [35, 0], [40, 1]]);
    expect(s.heightHistogram.reduce((a, b) => a + b.count, 0)).toBe(4);
  });

  it('class edges do not drift with a non-dyadic width', () => {
    const s = summarizeStand([t(1, 5.9, 10), t(2, 7.0, 10)], {}, S({ minDbhCm: 0, dbhClassCm: 0.3 }),
      { plotAreaM2: 100, crownUnionAreaM2: null });
    for (const b of s.dbhHistogram) {
      expect(String(b.lo).length).toBeLessThan(6);
      expect(b.hi - b.lo).toBeCloseTo(0.3, 9);
    }
    expect(s.dbhHistogram.reduce((a, b) => a + b.count, 0)).toBe(2);
    expect(s.dbhHistogram[s.dbhHistogram.length - 1].count).toBe(1);
  });

  it('an empty stand', () => {
    const s = summarizeStand([], {}, S(), measured);
    expect(s.nTrees).toBe(0);
    expect(s.qmdCm).toBeNull();
    expect(s.loreyHeightM).toBeNull();
    expect(s.dbhHistogram).toEqual([]);
  });
});

describe('biomass', () => {
  it('Chave et al. 2014 on a worked example', () => {
    // D = 30 cm, H = 20 m, rho = 0.6: 0.0673 * (0.6*900*20)^0.976
    const kg = treeBiomassKg(t(1, 30, 20), 'chave2014', 0.6)!;
    expect(kg).toBeCloseTo(0.0673 * Math.pow(10800, 0.976), 8);
    expect(kg).toBeGreaterThan(500);
    expect(kg).toBeLessThan(600);
    expect(treeBiomassKg(t(1, null, 20), 'chave2014', 0.6)).toBeNull();
  });

  it('Jenkins et al. 2003 per species group', () => {
    const kg = treeBiomassKg(t(1, 30, 20), 'jenkins2003', 0.5, null, 'pine')!;
    expect(kg).toBeCloseTo(Math.exp(-2.5356 + 2.4349 * Math.log(30)), 8);
    // Height is not needed.
    expect(treeBiomassKg(t(1, 30, null), 'jenkins2003', 0.5, null, 'pine')).toBeCloseTo(kg, 8);
    const s = summarizeStand([t(1, 30, 20), t(2, 80, 25)], {},
      S({ biomassMethod: 'jenkins2003', jenkinsGroup: 'mixed_hardwood' }), { plotAreaM2: 1000, crownUnionAreaM2: null });
    expect(s.biomassExtrapolated).toBe(1);  // 80 cm > the group's 56 cm
    expect(s.biomassMissing).toBe(0);
  });

  it('QSM volume times density', () => {
    expect(treeBiomassKg(t(1, 30, 20), 'qsm', 0.5, 0.8)).toBeCloseTo(400);
    expect(treeBiomassKg(t(1, 30, 20), 'qsm', 0.5, undefined)).toBeNull();
  });

  it('stand biomass sums trees and counts the ones it could not estimate', () => {
    const trees = [t(1, 30, 20), t(2, 40, 25)];
    const s = summarizeStand(trees, {}, S({ biomassMethod: 'qsm', woodDensity: 0.5 }),
      { plotAreaM2: 10000, crownUnionAreaM2: null }, { 1: 1.0 });
    expect(s.biomassKg).toBeCloseTo(500);
    expect(s.biomassMissing).toBe(1);
    expect(s.biomassMgPerHa).toBeCloseTo(0.5);
  });
});

describe('buildStandCsv', () => {
  it('writes the settings with the figures, then the class tables', () => {
    const trees = [t(1, 30, 20), t(2, 40, 25)];
    const set = S({ biomassMethod: 'chave2014', woodDensity: 0.55 });
    const csv = buildStandCsv('plot, A', summarizeStand(trees, {}, set, { plotAreaM2: 400, crownUnionAreaM2: 100 }), set);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('metric,value,unit');
    expect(lines[1]).toBe('scan_name,"plot, A",');
    expect(lines).toContain('stems_per_ha,50.0,1/ha');
    expect(lines).toContain('wood_density,0.550,g/cm3');
    expect(lines).toContain('class,lo,hi,count');
    expect(lines.filter(l => l.startsWith('dbh_cm,')).length).toBe(3);
  });
});
