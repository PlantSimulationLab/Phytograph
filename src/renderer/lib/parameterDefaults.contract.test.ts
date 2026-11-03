// Pins the TypeScript tool-default seeds to src/shared/parameterDefaults.contract.json,
// which backend-api/tests/test_param_defaults.py pins the Python copy
// (backend-api/param_defaults.py, used by the scripting client) to as well.
import { describe, it, expect } from 'vitest';
import contract from '../../shared/parameterDefaults.contract.json';
import { groundSegmentDefaultsForExtent } from './groundSegmentDefaults';
import { demDefaultsForExtent } from './demDefaults';
import { treeSegmentDefaultsForExtent } from './treeSegmentDefaults';

type Case = { args: (number | null)[]; expected: Record<string, number | boolean> };

describe('parameter defaults contract', () => {
  it.each(contract.ground as Case[])('ground %j', ({ args, expected }) => {
    const [ext, relief, spacing] = args;
    const d = groundSegmentDefaultsForExtent(ext as number, relief as number, spacing ?? undefined);
    expect({
      cloth_resolution: d.clothResolution,
      class_threshold: d.classThreshold,
      rigidness: d.rigidness,
      slope_smooth: d.slopeSmooth,
    }).toEqual(expected);
  });

  it.each(contract.dem as Case[])('dem %j', ({ args, expected }) => {
    expect({ cell_size: demDefaultsForExtent(args[0] as number).cellSize }).toEqual(expected);
  });

  it.each(contract.tree as Case[])('tree %j', ({ args, expected }) => {
    const d = treeSegmentDefaultsForExtent(args[0] as number);
    expect({
      decimate_res1: d.decimateRes1,
      decimate_res2: d.decimateRes2,
      max_gap: d.maxGap,
      max_outlier_gap: d.maxOutlierGap,
    }).toEqual(expected);
  });
});
