import { describe, it, expect } from 'vitest';
import contract from '../../shared/ladLai.contract.json';
import { computeLadProfile } from './ladProfile';
import type { LADResultEntry, LADVoxel } from './pointCloudTypes';

/**
 * The TypeScript half of the LAI cross-process contract.
 *
 * `src/shared/ladLai.contract.json` is the written-down definition of LAI for a
 * gridded LAD result; `backend-api/tests/test_lad_lai_contract.py` asserts the
 * SAME cases against `_lad_statistics_bytes`, the code that writes the LAI line
 * of the summary export. The viewer shows a bulk LAI and the export writes one;
 * if those two ever disagree the user sees no error, just two numbers, and
 * would reasonably quote either.
 *
 * This calls the shipped `computeLadProfile` — the function the popup uses — so
 * it cannot pass by reimplementing the rule.
 */

interface ContractCell {
  index: number;
  i: number; j: number; k: number;
  lad: number;
  leaf_area: number;
  // Present only on the wood case: the leaf/wood split's per-voxel outputs.
  wad?: number;
  wood_area?: number;
  solved?: boolean;
  under_sampled?: boolean;
  lad_filled?: boolean;
}

interface ContractCase {
  name: string;
  why: string;
  nx: number; ny: number; nz: number;
  // Plain arrays, not tuples: TS infers `number[]` from the imported JSON and
  // will not narrow it to a fixed-length tuple. Indexed by position below.
  origin: number[];
  cell_size: number[];
  cells: ContractCell[];
  expected: {
    measured_leaf_area: number;
    ground_area: number;
    lai: number;
    occluded_count: number;
    // Wood totals, present only on the wood case. WAI applies the SAME
    // measured-voxel rule as LAI, and PAI is their sum.
    measured_wood_area?: number;
    wai?: number;
    pai?: number;
    filled_leaf_area?: number;
    // Per-level mean LAD, asserted on this side only — the Python summary has
    // no per-level output. Same measured-voxel rule as the LAI above.
    level_mean_lad?: number[];
  };
}

/**
 * Contract cells → the renderer's own model.
 *
 * The contract is world-frame, as an export request is. A LADResultEntry is
 * STORED-frame with a `worldShift`, so the shift is set to the contract origin
 * and the centers written relative to it — which also makes the case fail if
 * `computeLadProfile` were ever to start reading world coordinates, since the
 * profile must work off the stored frame it is actually given.
 */
function toResult(c: ContractCase): LADResultEntry {
  const voxels: LADVoxel[] = c.cells.map(cell => ({
    index: cell.index,
    center: [
      c.cell_size[0] * (cell.i + 0.5),
      c.cell_size[1] * (cell.j + 0.5),
      c.cell_size[2] * (cell.k + 0.5),
    ] as [number, number, number],
    size: [...c.cell_size] as [number, number, number],
    leafArea: cell.leaf_area,
    lad: cell.lad,
    gtheta: 0.5,
    hitCount: cell.lad > 0 ? 10 : 0,
    // Absent in the JSON => absent on the voxel, which is exactly the legacy
    // case the contract's fourth entry pins.
    ...(cell.solved !== undefined ? { solved: cell.solved } : {}),
    ...(cell.under_sampled !== undefined ? { underSampled: cell.under_sampled } : {}),
    ...(cell.lad_filled !== undefined ? { ladFilled: cell.lad_filled } : {}),
    // Absent in the JSON => absent on the voxel, which is how a result with no
    // wood/leaf classification looks. The profile must then report no WAI/PAI
    // at all rather than zeros.
    ...(cell.wad !== undefined ? { wad: cell.wad } : {}),
    ...(cell.wood_area !== undefined ? { woodArea: cell.wood_area } : {}),
  }));

  return {
    id: `contract-${c.name}`,
    sourceScanIds: [],
    voxels,
    nx: c.nx, ny: c.ny, nz: c.nz,
    bounds: { min: [0, 0, 0], max: [c.cell_size[0] * c.nx, c.cell_size[1] * c.ny, c.cell_size[2] * c.nz] },
    gridSize: [c.cell_size[0] * c.nx, c.cell_size[1] * c.ny, c.cell_size[2] * c.nz],
    worldShift: [...c.origin] as [number, number, number],
    returnMode: 'single',
    visible: true,
    color: '#22c55e',
    hideEmpty: true,
    opacity: 1,
  };
}

const cases = (contract as { cases: ContractCase[] }).cases;

describe('LAI contract (src/shared/ladLai.contract.json)', () => {
  it('carries the cases the Python side also asserts', () => {
    // A truncated/emptied contract file must fail loudly rather than turn both
    // sides' tests into no-ops that pass.
    expect(cases.length).toBeGreaterThanOrEqual(5);
    // The wood case must be one of them, or the leaf/wood half of the contract
    // silently stops being asserted on either side.
    expect(cases.some(c => c.expected.wai !== undefined)).toBe(true);
  });

  for (const c of cases) {
    it(`${c.name} — ${c.why}`, () => {
      const p = computeLadProfile(toResult(c));
      expect(p.groundArea).toBeCloseTo(c.expected.ground_area, 9);
      expect(p.leafArea).toBeCloseTo(c.expected.measured_leaf_area, 9);
      expect(p.lai).toBeCloseTo(c.expected.lai, 9);
      expect(p.occludedCount).toBe(c.expected.occluded_count);
      if (c.expected.filled_leaf_area !== undefined) {
        expect(p.filledLeafArea).toBeCloseTo(c.expected.filled_leaf_area, 9);
      }

      if (c.expected.wai !== undefined) {
        // Wood obeys the SAME measured-voxel rule. The wood case gives its
        // occluded voxel a large wood area on purpose, so an implementation
        // that excluded occluded LEAF but not occluded WOOD fails here.
        expect(p.woodArea).toBeCloseTo(c.expected.measured_wood_area!, 9);
        expect(p.wai).toBeCloseTo(c.expected.wai, 9);
        expect(p.pai).toBeCloseTo(c.expected.pai!, 9);
        // The identity the two area conventions exist to preserve.
        expect(p.pai!).toBeCloseTo(p.lai + p.wai!, 9);
      } else {
        // No classification => no wood aggregates at all. Reporting 0 would
        // claim there is no wood, which is a different statement.
        expect(p.wai).toBeUndefined();
        expect(p.pai).toBeUndefined();
        expect(p.woodArea).toBeUndefined();
      }
    });

    it(`${c.name} — the profile's per-level mean LAD applies the same rule`, () => {
      // The plot and the headline must agree about what a measurement is. A
      // profile that averaged occluded voxels in would draw a canopy denser
      // than the LAI printed above it, from the same voxels.
      const p = computeLadProfile(toResult(c));
      expect(c.expected.level_mean_lad).toBeDefined();
      expect(p.levels.map(l => l.meanLad)).toHaveLength(c.expected.level_mean_lad!.length);
      p.levels.forEach((l, k) => {
        expect(l.meanLad).toBeCloseTo(c.expected.level_mean_lad![k], 9);
      });
    });

    it(`${c.name} — the per-level LAI contributions sum back to the bulk LAI`, () => {
      // The identity that makes the profile plot and the headline number the
      // same measurement rather than two similar ones.
      const p = computeLadProfile(toResult(c));
      const summed = p.levels.reduce((a, l) => a + l.laiContribution, 0);
      expect(summed).toBeCloseTo(p.lai, 12);
      expect(p.levels).toHaveLength(c.nz);
    });
  }
});
