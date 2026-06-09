import { describe, it, expect } from 'vitest';
import type { QSMCylinder, QSMShoot, QSMMetrics } from '../utils/backendApi';
import {
  cylinderLength,
  cylinderVolume,
  taperProfile,
  diameterAtHeight,
  rankBars,
  rankLabel,
  branchAngles,
  branchAngleHistogram,
  heightProfile,
  surfCovHistogram,
  madHistogram,
  coverageTrust,
  lowCoveragePredicate,
  qaSummary,
  perShootRows,
  treeBaseZ,
  SURF_COV_FULL_TRUST,
} from './qsmDistributions';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function cyl(over: Partial<QSMCylinder> & { cyl_id: number }): QSMCylinder {
  return {
    cyl_id: over.cyl_id,
    start: over.start ?? [0, 0, 0],
    end: over.end ?? [0, 0, 1],
    radius: over.radius ?? 0.05,
    parent_id: over.parent_id ?? -1,
    shoot_id: over.shoot_id ?? 0,
    rank: over.rank ?? 0,
    // Preserve an explicitly-passed null (?? would clobber it to the default).
    surf_cov: 'surf_cov' in over ? over.surf_cov! : 0.8,
    mad: 'mad' in over ? over.mad! : 0.001,
  };
}

function shoot(over: Partial<QSMShoot> & { shoot_id: number; cylinder_ids: number[] }): QSMShoot {
  return {
    shoot_id: over.shoot_id,
    rank: over.rank ?? 0,
    cylinder_ids: over.cylinder_ids,
    parent_shoot_id: over.parent_shoot_id ?? -1,
    parent_cyl_id: over.parent_cyl_id ?? -1,
    child_shoot_ids: over.child_shoot_ids ?? [],
  };
}

// A small tree: a 3-cylinder vertical trunk (rank 0, z: 0->3) plus one branch
// (rank 1) forking horizontally off the top trunk cylinder.
function smallTree(): { cyls: QSMCylinder[]; shoots: QSMShoot[] } {
  const cyls: QSMCylinder[] = [
    cyl({ cyl_id: 0, start: [0, 0, 0], end: [0, 0, 1], radius: 0.06, rank: 0, shoot_id: 0 }),
    cyl({ cyl_id: 1, start: [0, 0, 1], end: [0, 0, 2], radius: 0.04, rank: 0, shoot_id: 0, parent_id: 0 }),
    cyl({ cyl_id: 2, start: [0, 0, 2], end: [0, 0, 3], radius: 0.02, rank: 0, shoot_id: 0, parent_id: 1 }),
    // Branch forks horizontally (axis along +x) off cylinder 2 -> 90° fork.
    cyl({ cyl_id: 3, start: [0, 0, 3], end: [1, 0, 3], radius: 0.01, rank: 1, shoot_id: 1, parent_id: 2 }),
  ];
  const shoots: QSMShoot[] = [
    shoot({ shoot_id: 0, rank: 0, cylinder_ids: [0, 1, 2], parent_cyl_id: -1, child_shoot_ids: [1] }),
    shoot({ shoot_id: 1, rank: 1, cylinder_ids: [3], parent_cyl_id: 2, parent_shoot_id: 0 }),
  ];
  return { cyls, shoots };
}

// ---------------------------------------------------------------------------
// Per-cylinder geometry
// ---------------------------------------------------------------------------

describe('cylinder geometry', () => {
  it('computes length and volume', () => {
    const c = cyl({ cyl_id: 0, start: [0, 0, 0], end: [0, 0, 2], radius: 0.1 });
    expect(cylinderLength(c)).toBeCloseTo(2, 10);
    expect(cylinderVolume(c)).toBeCloseTo(Math.PI * 0.01 * 2, 10);
  });

  it('treeBaseZ is the minimum z across all cylinders', () => {
    const { cyls } = smallTree();
    expect(treeBaseZ(cyls)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Taper profile
// ---------------------------------------------------------------------------

describe('taperProfile', () => {
  it('returns only trunk cylinders, sorted by height, with mm diameter', () => {
    const { cyls } = smallTree();
    const prof = taperProfile(cyls);
    expect(prof).toHaveLength(3); // the branch (rank 1) is excluded
    // Heights ascend; midpoints at 0.5, 1.5, 2.5 m above base.
    expect(prof.map(p => p.heightM)).toEqual([0.5, 1.5, 2.5]);
    // Diameters taper: 120, 80, 40 mm (2 * radius * 1000).
    expect(prof.map(p => Math.round(p.diameterMm))).toEqual([120, 80, 40]);
  });

  it('diameterAtHeight interpolates and refuses to extrapolate', () => {
    const { cyls } = smallTree();
    // Between midpoints 0.5 (120mm) and 1.5 (80mm), at 1.0 m -> 100mm.
    expect(diameterAtHeight(cyls, 1.0)).toBeCloseTo(100, 6);
    // Below the lowest midpoint / above the highest -> null (no extrapolation).
    expect(diameterAtHeight(cyls, 0.1)).toBeNull();
    expect(diameterAtHeight(cyls, 2.9)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rank bars
// ---------------------------------------------------------------------------

describe('rankBars / rankLabel', () => {
  it('labels ranks', () => {
    expect(rankLabel(0)).toBe('Trunk');
    expect(rankLabel(1)).toBe('Scaffold');
    expect(rankLabel(3)).toBe('Order 3');
  });

  it('maps per_rank metrics to sorted bars', () => {
    const metrics = {
      per_rank: [
        { rank: 1, n_shoots: 4, total_length_m: 10, mean_shoot_length_m: 2.5, woody_volume_m3: 0.002, mean_diameter_mm: 20, mean_branch_angle_deg: 45 },
        { rank: 0, n_shoots: 1, total_length_m: 3, mean_shoot_length_m: 3, woody_volume_m3: 0.01, mean_diameter_mm: 80, mean_branch_angle_deg: null },
      ],
    } as unknown as QSMMetrics;
    const bars = rankBars(metrics);
    expect(bars.map(b => b.rank)).toEqual([0, 1]); // sorted
    expect(bars[0].label).toBe('Trunk');
    expect(bars[1].nShoots).toBe(4);
    expect(bars[1].woodyVolM3).toBe(0.002);
  });

  it('returns [] for null metrics', () => {
    expect(rankBars(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Branch angles
// ---------------------------------------------------------------------------

describe('branch angles', () => {
  it('computes the fork angle between parent and child base axes', () => {
    const { cyls, shoots } = smallTree();
    const angles = branchAngles(cyls, shoots);
    // Only the rank-1 branch has a parent: vertical trunk vs horizontal branch = 90°.
    expect(angles).toHaveLength(1);
    expect(angles[0]).toBeCloseTo(90, 6);
  });

  it('uses the acute angle regardless of axis storage direction', () => {
    const cyls: QSMCylinder[] = [
      cyl({ cyl_id: 0, start: [0, 0, 0], end: [0, 0, 1], rank: 0, shoot_id: 0 }),
      // Child stored tip->base (downward) but still 30° from the parent line.
      cyl({ cyl_id: 1, start: [Math.sin(Math.PI / 6), 0, 1 + Math.cos(Math.PI / 6)], end: [0, 0, 1], rank: 1, shoot_id: 1, parent_id: 0 }),
    ];
    const shoots = [
      shoot({ shoot_id: 0, rank: 0, cylinder_ids: [0] }),
      shoot({ shoot_id: 1, rank: 1, cylinder_ids: [1], parent_cyl_id: 0 }),
    ];
    expect(branchAngles(cyls, shoots)[0]).toBeCloseTo(30, 6);
  });

  it('histograms angles into 0..90° bins', () => {
    const { cyls, shoots } = smallTree();
    const h = branchAngleHistogram(cyls, shoots, 18);
    expect(h.binWidth).toBeCloseTo(5, 10);
    expect(h.total).toBe(1);
    // 90° lands in the final bin (index 17).
    expect(h.counts[17]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Height profile
// ---------------------------------------------------------------------------

describe('heightProfile', () => {
  it('bins volume and length by midpoint height and conserves totals', () => {
    const { cyls } = smallTree();
    const bins = heightProfile(cyls, 6); // 3 m / 6 = 0.5 m bands
    const totalVol = bins.reduce((s, b) => s + b.volM3, 0);
    const totalLen = bins.reduce((s, b) => s + b.lengthM, 0);
    const expectVol = cyls.reduce((s, c) => s + cylinderVolume(c), 0);
    const expectLen = cyls.reduce((s, c) => s + cylinderLength(c), 0);
    expect(totalVol).toBeCloseTo(expectVol, 10);
    expect(totalLen).toBeCloseTo(expectLen, 10);
    expect(bins).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Scan-coverage diagnostics (NOT a fit pass/fail — see lib header)
// ---------------------------------------------------------------------------

describe('coverageTrust', () => {
  it('ramps linearly to full trust at the backend sc_full threshold', () => {
    expect(coverageTrust(cyl({ cyl_id: 0, surf_cov: 0 }))).toBe(0);
    expect(coverageTrust(cyl({ cyl_id: 0, surf_cov: SURF_COV_FULL_TRUST }))).toBeCloseTo(1, 10);
    // Saturates at 1 above the threshold; full coverage is still trust 1.
    expect(coverageTrust(cyl({ cyl_id: 0, surf_cov: 1 }))).toBe(1);
    // Half-way to the threshold -> half trust.
    expect(coverageTrust(cyl({ cyl_id: 0, surf_cov: SURF_COV_FULL_TRUST / 2 }))).toBeCloseTo(0.5, 10);
  });

  it('treats null (unmeasured) coverage as zero trust', () => {
    expect(coverageTrust(cyl({ cyl_id: 0, surf_cov: null }))).toBe(0);
  });
});

describe('lowCoveragePredicate', () => {
  it('flags clearly one-sided cylinders, not merely-below-half coverage', () => {
    // A 0.25 surf_cov cylinder is the TLS norm — NOT flagged (the old code did).
    expect(lowCoveragePredicate(cyl({ cyl_id: 0, surf_cov: 0.25 }))).toBe(false);
    // A truly one-sided 0.05 cylinder IS flagged.
    expect(lowCoveragePredicate(cyl({ cyl_id: 0, surf_cov: 0.05 }))).toBe(true);
  });

  it('does not flag null coverage (unmeasured, not bad)', () => {
    expect(lowCoveragePredicate(cyl({ cyl_id: 0, surf_cov: null }))).toBe(false);
  });
});

describe('QA histograms', () => {
  it('surfCovHistogram excludes null surf_cov', () => {
    const cyls = [
      cyl({ cyl_id: 0, surf_cov: 0.9 }),
      cyl({ cyl_id: 1, surf_cov: 0.3 }),
      cyl({ cyl_id: 2, surf_cov: null }),
    ];
    const h = surfCovHistogram(cyls, 20);
    expect(h.total).toBe(2);
    expect(h.excluded).toBe(1);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('madHistogram bins absolute MAD in mm and excludes null mad', () => {
    const cyls = [
      cyl({ cyl_id: 0, mad: 0.002 }),   // 2 mm
      cyl({ cyl_id: 1, mad: null }),
    ];
    const h = madHistogram(cyls, 20, 20); // 0..20mm, 1mm bins
    expect(h.total).toBe(1);
    expect(h.excluded).toBe(1);
    // 2 mm lands in bin index 2.
    expect(h.counts[2]).toBe(1);
  });

  it('madHistogram puts the long tail in the overflow bin', () => {
    // A thin twig with a huge absolute residual (well past the 20mm axis cap).
    const cyls = [cyl({ cyl_id: 0, radius: 0.003, mad: 0.5 })];
    const h = madHistogram(cyls, 20, 20);
    expect(h.counts[19]).toBe(1);
  });
});

describe('qaSummary (coverage, volume-weighted)', () => {
  it('grades a real-TLS-like model HIGH even though raw coverage is modest', () => {
    // The trunk + scaffolds are decently covered; thin twigs are one-sided. This
    // is what a GOOD real model looks like — it must NOT read as the worst grade.
    const cyls = [
      cyl({ cyl_id: 0, radius: 0.10, end: [0, 0, 2], surf_cov: 0.7 }),  // big trunk, well covered
      cyl({ cyl_id: 1, radius: 0.05, end: [0, 0, 1], surf_cov: 0.6 }),  // scaffold
      // Many thin one-sided twigs (tiny volume each).
      ...Array.from({ length: 50 }, (_, i) =>
        cyl({ cyl_id: i + 2, radius: 0.004, end: [0, 0, 0.1], surf_cov: 0.08 })),
    ];
    const qa = qaSummary(cyls);
    // Volume is dominated by the well-covered trunk/scaffold, so the grade is high
    // and most volume is well covered — despite 50/52 cylinders being one-sided.
    expect(qa.grade).toBe('high');
    expect(qa.volMeanTrust).toBeGreaterThan(0.6);
    expect(qa.wellCoveredVolFrac).toBeGreaterThan(0.8);
    // The twigs are a negligible share of volume even though they're most cylinders.
    expect(qa.lowCoverageVolFrac).toBeLessThan(0.05);
    expect(qa.volMedianSurfCov).toBeGreaterThanOrEqual(0.6);
  });

  it('grades a genuinely one-sided model LOW', () => {
    // Even the structural wood is barely seen — the model is mostly inferred.
    const cyls = Array.from({ length: 10 }, (_, i) =>
      cyl({ cyl_id: i, radius: 0.05, end: [0, 0, 1], surf_cov: 0.05 }));
    const qa = qaSummary(cyls);
    expect(qa.grade).toBe('low');
    expect(qa.volMeanTrust).toBeLessThan(0.35);
    expect(qa.lowCoverageVolFrac).toBeCloseTo(1, 6);
  });

  it('reports the median residual in mm and metric coverage', () => {
    const cyls = [
      cyl({ cyl_id: 0, radius: 0.05, mad: 0.002, surf_cov: 0.5 }),
      cyl({ cyl_id: 1, radius: 0.05, mad: 0.002, surf_cov: null }),
    ];
    const qa = qaSummary(cyls);
    expect(qa.volMedianMadMm).toBeCloseTo(2, 6);
    expect(qa.metricCoverageFrac).toBe(0.5); // one of two has surf_cov
  });
});

// ---------------------------------------------------------------------------
// Per-shoot table
// ---------------------------------------------------------------------------

describe('perShootRows', () => {
  it('aggregates length, base diameter, fork angle, children', () => {
    const { cyls, shoots } = smallTree();
    const rows = perShootRows(cyls, shoots);
    expect(rows).toHaveLength(2);

    const trunk = rows.find(r => r.shootId === 0)!;
    expect(trunk.lengthM).toBeCloseTo(3, 10);          // 1+1+1
    expect(Math.round(trunk.baseDiameterMm)).toBe(120); // base cyl radius 0.06
    expect(trunk.branchAngleDeg).toBeNull();            // trunk has no parent
    expect(trunk.childCount).toBe(1);

    const branch = rows.find(r => r.shootId === 1)!;
    expect(branch.lengthM).toBeCloseTo(1, 10);
    expect(branch.branchAngleDeg).toBeCloseTo(90, 6);
    expect(branch.childCount).toBe(0);
  });

  it('reports a volume-weighted coverage so the thick base dominates', () => {
    // A well-covered thick base + a one-sided thin tip. Volume-weighted, the
    // shoot's coverage tracks the base (high), NOT a flat mean of the two.
    const cyls = [
      cyl({ cyl_id: 0, radius: 0.05, end: [0, 0, 1], surf_cov: 0.7, shoot_id: 0 }),
      cyl({ cyl_id: 1, radius: 0.004, start: [0, 0, 1], end: [0, 0, 1.2], surf_cov: 0.05, shoot_id: 0 }),
    ];
    const shoots = [shoot({ shoot_id: 0, cylinder_ids: [0, 1] })];
    const row = perShootRows(cyls, shoots)[0];
    expect(row.surfCov).toBeCloseTo(0.7, 6); // half-mass median lands on the base
    expect(row.lowCoverage).toBe(false);     // base carries the volume → not low
  });

  it('flags a shoot low-coverage only when its structural wood is one-sided', () => {
    const cyls = [
      cyl({ cyl_id: 0, radius: 0.05, end: [0, 0, 1], surf_cov: 0.05, shoot_id: 0 }),
      cyl({ cyl_id: 1, radius: 0.05, start: [0, 0, 1], end: [0, 0, 2], surf_cov: 0.05, shoot_id: 0 }),
    ];
    const shoots = [shoot({ shoot_id: 0, cylinder_ids: [0, 1] })];
    expect(perShootRows(cyls, shoots)[0].lowCoverage).toBe(true);
  });
});
