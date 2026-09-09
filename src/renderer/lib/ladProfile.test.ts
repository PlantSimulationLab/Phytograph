import { describe, it, expect } from 'vitest';
import { computeLadProfile, ladProfileCsv, isMeasured } from './ladProfile';
import type { LADResultEntry, LADVoxel } from './pointCloudTypes';

// Build a voxel at Helios cell index `index`, in a grid whose lattice starts at
// the origin with 1 m cells. Overrides let a test mark it occluded/filled.
function voxel(
  index: number,
  lad: number,
  opts: Partial<LADVoxel> = {},
  nx = 2,
  ny = 2,
  cell = 1,
): LADVoxel {
  const cellsPerLevel = nx * ny;
  const k = Math.floor(index / cellsPerLevel);
  const rem = index % cellsPerLevel;
  const i = rem % nx;
  const j = Math.floor(rem / nx);
  return {
    index,
    center: [(i + 0.5) * cell, (j + 0.5) * cell, (k + 0.5) * cell],
    size: [cell, cell, cell],
    // Leaf area and LAD must agree, since the profile sums area and averages
    // density and the two are checked against each other in the LAI identity.
    leafArea: lad * cell * cell * cell,
    lad,
    gtheta: 0.5,
    hitCount: lad > 0 ? 10 : 0,
    ...opts,
  };
}

function result(voxels: LADVoxel[], over: Partial<LADResultEntry> = {}): LADResultEntry {
  const nx = over.nx ?? 2, ny = over.ny ?? 2, nz = over.nz ?? 3;
  return {
    id: 'r1',
    sourceScanIds: [],
    voxels,
    nx, ny, nz,
    bounds: { min: [0, 0, 0], max: [nx, ny, nz] },
    gridSize: [nx, ny, nz],
    returnMode: 'single',
    visible: true,
    color: '#22c55e',
    hideEmpty: true,
    opacity: 1,
    ...over,
  };
}

describe('computeLadProfile — level assignment', () => {
  it('bins voxels by Helios k-major cell index, not by z coordinate', () => {
    // 2x2x3 grid, one voxel per level, each in a different (i,j) slot.
    const p = computeLadProfile(result([
      voxel(0, 1),    // level 0
      voxel(5, 2),    // level 1
      voxel(10, 3),   // level 2
    ]));
    expect(p.levels.map(l => l.meanLad)).toEqual([1, 2, 3]);
    expect(p.levels.map(l => l.level)).toEqual([0, 1, 2]);
  });

  it('keeps the level assignment when a terrain-following grid lifts a column', () => {
    // Same indices as above, but two columns are lifted 10 m by the terrain.
    // A z-binned profile would scatter these across levels; an index-binned one
    // must not move a single voxel.
    const lifted = [
      voxel(0, 1), voxel(5, 2), voxel(10, 3),
    ].map((v, n) => (n === 1
      ? { ...v, center: [v.center[0], v.center[1], v.center[2] + 10] as [number, number, number] }
      : v));
    const p = computeLadProfile(result(lifted, { terrainFollow: true }));
    expect(p.levels.map(l => l.meanLad)).toEqual([1, 2, 3]);
    expect(p.terrainFollow).toBe(true);
    // The lifted voxel's own height is still reported honestly.
    expect(p.levels[1].height).toBeCloseTo(11.5, 6);
  });

  it('emits one row per nz even for levels holding no voxel at all', () => {
    // A terrain-following grid drops whole columns, so a level can be empty.
    const p = computeLadProfile(result([voxel(0, 1)], { nz: 4 }));
    expect(p.levels).toHaveLength(4);
    expect(p.levels[3].voxelCount).toBe(0);
    expect(p.levels[3].meanLad).toBe(0);
    // Falls back to the nominal lattice height so the axis stays monotonic.
    expect(p.levels[3].height).toBeCloseTo(3.5, 6);
    expect(p.levels.map(l => l.height)).toEqual(
      [...p.levels.map(l => l.height)].sort((a, b) => a - b));
  });

  it('clamps an out-of-range index into the top level rather than dropping it', () => {
    const p = computeLadProfile(result([voxel(99, 5)], { nz: 3 }));
    expect(p.levels[2].measuredCount).toBe(1);
    expect(p.levels[2].meanLad).toBe(5);
  });
});

describe('computeLadProfile — occlusion is excluded, never zeroed', () => {
  it('leaves occluded voxels out of the mean instead of averaging them as zero', () => {
    // Level 0: one measured voxel at LAD 4, three occluded ones Helios wrote as 0.
    const p = computeLadProfile(result([
      voxel(0, 4),
      voxel(1, 0, { underSampled: true }),
      voxel(2, 0, { underSampled: true }),
      voxel(3, 0, { underSampled: true }),
    ]));
    // The whole point: 4, not 4/4 = 1.
    expect(p.levels[0].meanLad).toBe(4);
    expect(p.levels[0].measuredCount).toBe(1);
    expect(p.levels[0].occludedCount).toBe(3);
    expect(p.occludedCount).toBe(3);
  });

  it('excludes an unsolved voxel as well as an under-sampled one', () => {
    const p = computeLadProfile(result([
      voxel(0, 4),
      voxel(1, 0, { solved: false }),
    ]));
    expect(p.levels[0].measuredCount).toBe(1);
    expect(p.levels[0].occludedCount).toBe(1);
  });

  it('treats a genuinely empty measured voxel as a real zero', () => {
    // Empty air is a measurement of zero density and MUST pull the mean down;
    // only unmeasured voxels are excluded.
    const p = computeLadProfile(result([voxel(0, 4), voxel(1, 0)]));
    expect(p.levels[0].meanLad).toBe(2);
    expect(p.levels[0].measuredCount).toBe(2);
    expect(p.occludedCount).toBe(0);
  });

  it('keeps interpolated (kriged) leaf area out of the total and reports it apart', () => {
    const p = computeLadProfile(result([
      voxel(0, 4),
      voxel(1, 3, { underSampled: true, ladFilled: true }),
    ]));
    expect(p.leafArea).toBe(4);              // the filled voxel's 3 m² is not in it
    expect(p.filledLeafArea).toBe(3);
    expect(p.levels[0].filledCount).toBe(1);
    expect(p.laiWithFilled).toBeGreaterThan(p.lai);
  });
});

describe('computeLadProfile — bulk LAI', () => {
  it('divides measured leaf area by the FULL grid footprint', () => {
    // 2x2 footprint of 1 m cells = 4 m². One voxel of 4 m² leaf area => LAI 1.
    const p = computeLadProfile(result([voxel(0, 4)]));
    expect(p.groundArea).toBe(4);
    expect(p.leafArea).toBe(4);
    expect(p.lai).toBe(1);
  });

  it('does not shrink the footprint to the occupied columns', () => {
    // Only one of four columns holds canopy. LAI is per unit GROUND, so the
    // ground under the empty columns still counts — using the occupied
    // footprint instead would inflate LAI 4x here.
    const sparse = computeLadProfile(result([voxel(0, 4)]));
    const dense = computeLadProfile(result([
      voxel(0, 4), voxel(1, 4), voxel(2, 4), voxel(3, 4),
    ]));
    expect(sparse.lai).toBe(1);
    expect(dense.lai).toBe(4);
  });

  it('sums the per-level LAI contributions back to the bulk LAI', () => {
    // The identity that makes the profile and the headline the same measurement.
    const p = computeLadProfile(result([
      voxel(0, 1), voxel(1, 2), voxel(5, 3), voxel(10, 0.5),
      voxel(11, 9, { underSampled: true }),
    ]));
    const summed = p.levels.reduce((a, l) => a + l.laiContribution, 0);
    expect(summed).toBeCloseTo(p.lai, 12);
  });

  it('uses the grid extents for the footprint, not the voxel sizes', () => {
    // A 4x4 m footprint split into 2x2 cells of 2 m: ground is 16 m², not 4.
    const v = voxel(0, 1, {}, 2, 2, 2);
    const p = computeLadProfile(result([v], {
      nx: 2, ny: 2, nz: 2, gridSize: [4, 4, 4], bounds: { min: [0, 0, 0], max: [4, 4, 4] },
    }));
    expect(p.groundArea).toBe(16);
    expect(p.lai).toBeCloseTo(8 / 16, 12);   // one 2m cube at LAD 1 = 8 m² leaf area
  });

  it('reports zero rather than dividing by a degenerate footprint', () => {
    const p = computeLadProfile(result([voxel(0, 4)], {
      nx: 2, ny: 2, nz: 1, gridSize: [0, 0, 1], bounds: { min: [0, 0, 0], max: [0, 0, 1] },
    }));
    expect(p.groundArea).toBe(0);
    expect(p.lai).toBe(0);
    expect(Number.isFinite(p.lai)).toBe(true);
  });
});

describe('computeLadProfile — spread', () => {
  it('reports the population SD of LAD across a level', () => {
    // Values 1 and 3: mean 2, population SD 1.
    const p = computeLadProfile(result([voxel(0, 1), voxel(1, 3)]));
    expect(p.levels[0].meanLad).toBe(2);
    expect(p.levels[0].stdLad).toBeCloseTo(1, 12);
  });

  it('never returns a negative-variance NaN on identical voxels', () => {
    const p = computeLadProfile(result([
      voxel(0, 0.1), voxel(1, 0.1), voxel(2, 0.1), voxel(3, 0.1),
    ]));
    expect(p.levels[0].stdLad).toBe(0);
  });
});

describe('isMeasured', () => {
  it('accepts a legacy voxel carrying none of the flags', () => {
    expect(isMeasured(voxel(0, 1))).toBe(true);
  });
  it('rejects each way a voxel fails to be a measurement', () => {
    expect(isMeasured(voxel(0, 1, { solved: false }))).toBe(false);
    expect(isMeasured(voxel(0, 1, { underSampled: true }))).toBe(false);
    expect(isMeasured(voxel(0, 1, { ladFilled: true }))).toBe(false);
  });
});

describe('ladProfileCsv', () => {
  it('writes one row per level plus the bulk figures', () => {
    const p = computeLadProfile(result([voxel(0, 1), voxel(5, 2)]));
    const csv = ladProfileCsv(p);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('height_m');
    expect(lines[0]).toContain('mean_lad_m2_m3');
    // header + 3 levels
    expect(lines.slice(1, 4).map(l => l.split(',')[0])).toEqual(['0', '1', '2']);
    expect(csv).toContain(`# bulk LAI (measured voxels only),${p.lai.toFixed(6)}`);
    expect(csv).toContain('# occluded voxels excluded,0 of 2');
  });

  it('names the height column as above-ground for a terrain-following grid', () => {
    const p = computeLadProfile(result([voxel(0, 1)], { terrainFollow: true }));
    expect(ladProfileCsv(p)).toContain('mean_height_above_ground_m');
  });
});
