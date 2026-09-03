import { describe, expect, it } from 'vitest';
import {
  formatFilterBound,
  isIntegerFilterField,
  isNarrowing,
  projectFilters,
  seedFilterInput,
} from './filterFields';
import type { CloudFilters, FilterRange } from './pointCloudTypes';

describe('isIntegerFilterField', () => {
  it('recognises the per-pulse multi-return counters', () => {
    expect(isIntegerFilterField('scalar:target_index')).toBe(true);
    expect(isIntegerFilterField('scalar:target_count')).toBe(true);
  });

  it('recognises the structured-scan raster indices', () => {
    expect(isIntegerFilterField('scalar:row_index')).toBe(true);
    expect(isIntegerFilterField('scalar:column_index')).toBe(true);
  });

  it('matches case-insensitively, like the classification registry', () => {
    expect(isIntegerFilterField('scalar:Target_Index')).toBe(true);
  });

  it('leaves genuinely continuous scalars alone', () => {
    expect(isIntegerFilterField('scalar:reflectance')).toBe(false);
    expect(isIntegerFilterField('scalar:deviation')).toBe(false);
    expect(isIntegerFilterField('scalar:timestamp')).toBe(false);
    // height_above_ground is a real continuous measurement despite the
    // "index"-ish company it keeps in the picker.
    expect(isIntegerFilterField('scalar:height_above_ground')).toBe(false);
  });

  it('is false for coordinates and intensity, which are never scalar: fields', () => {
    expect(isIntegerFilterField('x')).toBe(false);
    expect(isIntegerFilterField('y')).toBe(false);
    expect(isIntegerFilterField('z')).toBe(false);
    expect(isIntegerFilterField('intensity')).toBe(false);
  });

  it('does not match a bare slug without the scalar: prefix', () => {
    // The panel's dropdown values are always encoded; a bare slug reaching
    // here would mean the encoding drifted, and silently treating it as
    // integer would hide that.
    expect(isIntegerFilterField('target_index')).toBe(false);
  });

  it('is false for empty / missing input', () => {
    expect(isIntegerFilterField(undefined)).toBe(false);
    expect(isIntegerFilterField(null)).toBe(false);
    expect(isIntegerFilterField('')).toBe(false);
  });
});

describe('formatFilterBound', () => {
  it('prints integer fields as whole numbers', () => {
    expect(formatFilterBound(1, true)).toBe('1');
    expect(formatFilterBound(3, true)).toBe('3');
  });

  it('rounds float32 drift rather than truncating it', () => {
    // A target_index of 3 stored as float32 and widened to float64 can read
    // 2.9999998; truncation would report a 3-return scan as reaching only 2.
    expect(formatFilterBound(2.9999998, true)).toBe('3');
    expect(formatFilterBound(3.0000002, true)).toBe('3');
  });

  it('keeps two decimals for continuous fields', () => {
    expect(formatFilterBound(1.23456, false)).toBe('1.23');
    expect(formatFilterBound(-0.5, false)).toBe('-0.50');
  });

  it('survives a non-finite bound', () => {
    expect(formatFilterBound(NaN, true)).toBe('0');
    expect(formatFilterBound(Infinity, false)).toBe('0.00');
  });
});

describe('seedFilterInput', () => {
  it('seeds integer inputs without a decimal tail', () => {
    expect(seedFilterInput(2.9999998, true)).toBe('3');
    expect(seedFilterInput(1, true)).toBe('1');
  });

  it('keeps full 4-decimal precision for continuous inputs', () => {
    expect(seedFilterInput(1.23456, false)).toBe('1.2346');
  });

  it('survives a non-finite bound', () => {
    expect(seedFilterInput(NaN, false)).toBe('0.0000');
    expect(seedFilterInput(NaN, true)).toBe('0');
  });
});

describe('isNarrowing', () => {
  const bounds = { min: 0, max: 10 };

  it('is false for a disabled filter', () => {
    expect(isNarrowing({ min: 2, max: 8, enabled: false }, bounds)).toBe(false);
  });

  it('is false for a missing filter', () => {
    expect(isNarrowing(undefined, bounds)).toBe(false);
    expect(isNarrowing(null, bounds)).toBe(false);
  });

  // This is the defect the module exists for: an enabled filter sitting at the
  // field's full extent removes nothing, so the panel must not advertise it.
  it('is false for an enabled filter at the full extent', () => {
    expect(isNarrowing({ min: 0, max: 10, enabled: true }, bounds)).toBe(false);
  });

  it('is true when either end is pulled in', () => {
    expect(isNarrowing({ min: 1, max: 10, enabled: true }, bounds)).toBe(true);
    expect(isNarrowing({ min: 0, max: 9, enabled: true }, bounds)).toBe(true);
    expect(isNarrowing({ min: 3, max: 7, enabled: true }, bounds)).toBe(true);
  });

  it('tolerates the toFixed(4) round-trip the inputs impose', () => {
    // Re-seeding an untouched field prints the extent to 4 decimals and parses
    // it back, so the committed bounds differ in the 5th decimal. Counting that
    // as a filter would re-introduce the bug via the seeding path.
    const utm = { min: 601234.56789, max: 601834.56789 };
    expect(isNarrowing({ min: 601234.5679, max: 601834.5679, enabled: true }, utm)).toBe(false);
  });

  it('still detects a real narrowing that is small relative to a large extent', () => {
    // 1 m off a 600 m easting span is ~0.17% — well above the 0.01% tolerance.
    const utm = { min: 601234.5, max: 601834.5 };
    expect(isNarrowing({ min: 601235.5, max: 601834.5, enabled: true }, utm)).toBe(true);
  });

  it('is false for a degenerate field, which a range cannot narrow', () => {
    // Every point shares one value (a constant column); no range excludes any
    // of them without excluding all of them.
    expect(isNarrowing({ min: 5, max: 5, enabled: true }, { min: 5, max: 5 })).toBe(false);
  });

  it('treats a class filter as narrowing only when a class is dropped', () => {
    const all = { min: 0, max: 2, enabled: true, selectedClasses: [0, 1, 2] };
    const some = { min: 0, max: 2, enabled: true, selectedClasses: [0, 2] };
    expect(isNarrowing(all, { min: 0, max: 2 }, 3)).toBe(false);
    expect(isNarrowing(some, { min: 0, max: 2 }, 3)).toBe(true);
  });

  it('treats an empty class selection as narrowing', () => {
    // Keeping nothing is a legitimate (drastic) filter; the commit path
    // surfaces it as a 0-point result rather than as "no filter set".
    const none = { min: 0, max: 2, enabled: true, selectedClasses: [] };
    expect(isNarrowing(none, { min: 0, max: 2 }, 3)).toBe(true);
  });

  it('assumes narrowing for a class filter with no class total to compare against', () => {
    const f = { min: 0, max: 2, enabled: true, selectedClasses: [0] };
    expect(isNarrowing(f, { min: 0, max: 2 })).toBe(true);
  });
});

describe('projectFilters', () => {
  const range = (min: number, max: number, enabled = false): FilterRange => ({ min, max, enabled });

  // Two scans of the same site: same scalar columns, different spatial extents
  // and different observed intensity.
  const primary: CloudFilters = {
    x: range(0, 10),
    y: range(0, 10),
    z: range(0, 5, true),
    intensity: range(0.2, 0.8, true),
    scalarFields: {
      reflectance: range(-20, 0, true),
      tree_instance: { min: 0, max: 3, enabled: true, selectedClasses: [1, 3] },
    },
  };
  const sibling: CloudFilters = {
    x: range(50, 70),
    y: range(50, 70),
    z: range(-1, 9),
    intensity: range(0, 1),
    scalarFields: {
      reflectance: range(-30, 5),
      tree_instance: { min: 0, max: 7, enabled: false },
    },
  };

  it('carries every enabled criterion onto the sibling', () => {
    const out = projectFilters(primary, sibling);
    expect(out.z).toEqual({ min: 0, max: 5, enabled: true });
    expect(out.intensity).toEqual({ min: 0.2, max: 0.8, enabled: true });
    expect(out.scalarFields.reflectance).toEqual({ min: -20, max: 0, enabled: true });
    expect(out.scalarFields.tree_instance).toEqual({
      min: 0, max: 3, enabled: true, selectedClasses: [1, 3],
    });
  });

  it('leaves un-filtered fields at the SIBLING\'s own extent, not the primary\'s', () => {
    // Inheriting the primary's x/y bounds here would silently crop the sibling
    // to a box it does not occupy — the sibling sits at x∈[50,70].
    const out = projectFilters(primary, sibling);
    expect(out.x).toEqual({ min: 50, max: 70, enabled: false });
    expect(out.y).toEqual({ min: 50, max: 70, enabled: false });
  });

  it('drops a criterion for a field the sibling does not have', () => {
    const noReflectance = { ...sibling, scalarFields: { tree_instance: sibling.scalarFields.tree_instance } };
    const out = projectFilters(primary, noReflectance);
    expect(out.scalarFields.reflectance).toBeUndefined();
    expect(Object.keys(out.scalarFields)).toEqual(['tree_instance']);
  });

  it('drops an intensity criterion when the sibling has no intensity', () => {
    const noIntensity = { ...sibling, intensity: undefined };
    const out = projectFilters(primary, noIntensity);
    expect(out.intensity).toBeUndefined();
  });

  it('mutates neither input', () => {
    const out = projectFilters(primary, sibling);
    expect(sibling.z).toEqual({ min: -1, max: 9, enabled: false });
    expect(primary.scalarFields.tree_instance.selectedClasses).toEqual([1, 3]);
    // and the copies are not shared references back into the source
    out.scalarFields.reflectance.min = 999;
    expect(primary.scalarFields.reflectance.min).toBe(-20);
  });

  it('is an identity when the source has nothing enabled', () => {
    const inert = {
      ...primary,
      z: range(0, 5),
      intensity: range(0.2, 0.8),
      scalarFields: {
        reflectance: range(-20, 0),
        tree_instance: { min: 0, max: 3, enabled: false },
      },
    };
    expect(projectFilters(inert, sibling)).toEqual(sibling);
  });
});

describe('projectFilters screens no-op criteria before carrying them over', () => {
  const range = (min: number, max: number, enabled = false): FilterRange => ({ min, max, enabled });

  // The primary sits at x∈[0,10]; the sibling is a different scan of the same
  // plot at x∈[50,70].
  const sibling: CloudFilters = {
    x: range(50, 70),
    y: range(50, 70),
    z: range(-1, 9),
    scalarFields: { reflectance: range(-30, 5) },
  };

  it('does NOT crop a sibling with an enabled-but-full-extent spatial criterion', () => {
    // This is the trap: the panel enables a field on the first keystroke, so a
    // user who merely SELECTS X and re-types its own range leaves x enabled at
    // [0,10] — a no-op on the primary. Carried over blindly it becomes a real
    // crop to x∈[0,10] on a sibling that occupies x∈[50,70], deleting the whole
    // scan while the user believes they filtered on reflectance alone.
    const primary: CloudFilters = {
      x: range(0, 10, true),          // enabled, but the primary's full extent
      y: range(0, 10),
      z: range(0, 5),
      scalarFields: { reflectance: range(-20, 0, true) },
    };
    // Only reflectance genuinely narrows the primary.
    const narrows = (field: string) => field === 'scalar:reflectance';

    const out = projectFilters(primary, sibling, narrows);
    expect(out.x).toEqual({ min: 50, max: 70, enabled: false });
    expect(out.scalarFields.reflectance).toEqual({ min: -20, max: 0, enabled: true });
  });

  it('still carries a spatial criterion that really narrows', () => {
    const primary: CloudFilters = {
      x: range(2, 8, true),
      y: range(0, 10),
      z: range(0, 5),
      scalarFields: { reflectance: range(-30, 5) },
    };
    const out = projectFilters(primary, sibling, (f) => f === 'x');
    expect(out.x).toEqual({ min: 2, max: 8, enabled: true });
  });

  it('screens a class criterion the predicate reports as a no-op', () => {
    // All classes ticked keeps everything. `isNarrowing` alone cannot see this
    // without a class count, which is why the predicate comes from the caller.
    const primary: CloudFilters = {
      x: range(0, 10),
      y: range(0, 10),
      z: range(0, 5),
      scalarFields: {
        reflectance: { min: 0, max: 3, enabled: true, selectedClasses: [0, 1, 2, 3] },
      },
    };
    const out = projectFilters(primary, sibling, () => false);
    expect(out.scalarFields.reflectance).toEqual({ min: -30, max: 5, enabled: false });
  });

  it('carries every enabled criterion when no predicate is given', () => {
    // The documented fallback, for a caller that has already screened.
    const primary: CloudFilters = {
      x: range(0, 10, true),
      y: range(0, 10),
      z: range(0, 5),
      scalarFields: { reflectance: range(-30, 5) },
    };
    expect(projectFilters(primary, sibling).x).toEqual({ min: 0, max: 10, enabled: true });
  });
});
