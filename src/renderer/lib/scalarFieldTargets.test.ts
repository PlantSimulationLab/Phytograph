import { describe, it, expect } from 'vitest';
import {
  intersectScalarFields,
  poolingCaution,
  sharedFailureReason,
  UNPOOLABLE_SLUGS,
} from './scalarFieldTargets';
import type { ScalarFieldInfo, ScalarFieldListResult } from '../utils/backendApi';
import type { ScalarStats } from './scalarFieldStats';

function field(slug: string, over: Partial<ScalarFieldInfo> = {}): ScalarFieldInfo {
  return {
    slug,
    label: over.label ?? slug,
    kind: over.kind ?? 'extra',
    editable: over.editable ?? true,
    reserved: over.reserved ?? false,
    expression: over.expression ?? null,
  };
}

/** A listing whose built-ins mirror what the backend always reports. */
function listing(
  sessionId: string, fields: ScalarFieldInfo[],
  over: Partial<ScalarFieldListResult> = {},
): ScalarFieldListResult {
  return {
    session_id: sessionId,
    fields,
    point_count: over.point_count ?? 100,
    visible_count: over.visible_count ?? 90,
    functions: over.functions ?? ['sqrt', 'abs'],
    aggregates: over.aggregates ?? ['mean'],
    constants: over.constants ?? ['pi'],
  };
}

const XYZ = () => ['x', 'y', 'z'].map(s => field(s, { kind: 'builtin', editable: false, reserved: true }));

describe('intersectScalarFields', () => {
  it('returns an empty result for no listings, without throwing', () => {
    const out = intersectScalarFields([], 0);
    expect(out.fields).toEqual([]);
    expect(out.omitted).toEqual([]);
    expect(out.pointCount).toBe(0);
    expect(out.vocabulary.fields).toEqual([]);
  });

  it('passes a single listing through unchanged', () => {
    const out = intersectScalarFields(
      [listing('a', [field('band'), ...XYZ()])], 1);
    expect(out.fields.map(f => f.slug)).toEqual(['band', 'x', 'y', 'z']);
    expect(out.omitted).toEqual([]);
    expect(out.blocked).toEqual([]);
    expect(out.pointCount).toBe(100);
    expect(out.visibleCount).toBe(90);
  });

  it('keeps only the fields every cloud carries, and reports the rest', () => {
    const out = intersectScalarFields([
      listing('a', [field('band'), field('only_a')]),
      listing('b', [field('band'), field('only_b')]),
    ], 2);
    expect(out.fields.map(f => f.slug)).toEqual(['band']);
    expect(out.omitted.sort()).toEqual(['only_a', 'only_b']);
  });

  it('preserves the first listing’s field order', () => {
    const out = intersectScalarFields([
      listing('a', [field('c'), field('a'), field('b')]),
      listing('b', [field('a'), field('b'), field('c')]),
    ], 2);
    expect(out.fields.map(f => f.slug)).toEqual(['c', 'a', 'b']);
  });

  it('sums point and visible counts across clouds', () => {
    const out = intersectScalarFields([
      listing('a', [field('band')], { point_count: 1000, visible_count: 900 }),
      listing('b', [field('band')], { point_count: 500, visible_count: 450 }),
    ], 2);
    expect(out.pointCount).toBe(1500);
    expect(out.visibleCount).toBe(1350);
  });

  describe('metadata reconciliation', () => {
    it('demotes a field to builtin when any cloud calls it builtin', () => {
      // `intensity` is a dedicated array on one cloud and an imported column on
      // the other. Offering rename/delete would 404 on the first.
      const out = intersectScalarFields([
        listing('a', [field('intensity', { kind: 'builtin', editable: false })]),
        listing('b', [field('intensity', { kind: 'extra', editable: true })]),
      ], 2);
      expect(out.fields[0].kind).toBe('builtin');
      expect(out.fields[0].editable).toBe(false);
    });

    it('ANDs editability, so a field editable on only some clouds is locked', () => {
      const out = intersectScalarFields([
        listing('a', [field('band', { editable: true })]),
        listing('b', [field('band', { editable: false })]),
      ], 2);
      expect(out.fields[0].editable).toBe(false);
    });

    it('ORs the reserved flag', () => {
      const out = intersectScalarFields([
        listing('a', [field('band', { reserved: false })]),
        listing('b', [field('band', { reserved: true })]),
      ], 2);
      expect(out.fields[0].reserved).toBe(true);
    });

    it('takes the first cloud’s label and records the disagreement', () => {
      const out = intersectScalarFields([
        listing('a', [field('refl', { label: 'Reflectance [dB]' })]),
        listing('b', [field('refl', { label: 'refl' })]),
      ], 2);
      expect(out.fields[0].label).toBe('Reflectance [dB]');
      expect(out.labelConflicts).toEqual(['refl']);
    });

    it('reports no conflict when the labels agree', () => {
      const out = intersectScalarFields([
        listing('a', [field('refl', { label: 'Reflectance' })]),
        listing('b', [field('refl', { label: 'Reflectance' })]),
      ], 2);
      expect(out.labelConflicts).toEqual([]);
    });

    it('keeps a derived expression only when every cloud derived it the same way', () => {
      const same = intersectScalarFields([
        listing('a', [field('d', { expression: 'band * 2' })]),
        listing('b', [field('d', { expression: 'band * 2' })]),
      ], 2);
      expect(same.fields[0].expression).toBe('band * 2');

      const differing = intersectScalarFields([
        listing('a', [field('d', { expression: 'band * 2' })]),
        listing('b', [field('d', { expression: 'band * 3' })]),
      ], 2);
      expect(differing.fields[0].expression).toBeNull();

      const partial = intersectScalarFields([
        listing('a', [field('d', { expression: 'band * 2' })]),
        listing('b', [field('d', { expression: null })]),
      ], 2);
      expect(partial.fields[0].expression).toBeNull();
    });
  });

  describe('coordinate pooling block', () => {
    it.each(UNPOOLABLE_SLUGS)('blocks %s across several clouds', (slug) => {
      const out = intersectScalarFields([
        listing('a', [field('band'), ...XYZ()]),
        listing('b', [field('band'), ...XYZ()]),
      ], 2);
      expect(out.fields.map(f => f.slug)).not.toContain(slug);
      expect(out.blocked.map(b => b.field.slug)).toContain(slug);
      expect(out.blocked[0].reason).toMatch(/frame/i);
    });

    it('leaves coordinates measurable on a single cloud', () => {
      const out = intersectScalarFields([listing('a', [field('band'), ...XYZ()])], 1);
      expect(out.fields.map(f => f.slug)).toContain('z');
      expect(out.blocked).toEqual([]);
    });

    it('keeps blocked coordinates in the expression vocabulary', () => {
      // Compute runs per cloud, so `z - band` never crosses frames and must
      // stay writable even while `z` is unmeasurable as a pooled statistic.
      const out = intersectScalarFields([
        listing('a', [field('band'), ...XYZ()]),
        listing('b', [field('band'), ...XYZ()]),
      ], 2);
      expect(out.vocabulary.fields).toContain('z');
      expect(out.vocabulary.fields).toContain('band');
    });

    it('keys the block off the checked count, not the listings that arrived', () => {
      // A second cloud is checked but its listing is still in flight. `z` must
      // not be briefly offered as measurable.
      const out = intersectScalarFields([listing('a', [...XYZ()])], 2);
      expect(out.fields.map(f => f.slug)).not.toContain('z');
      expect(out.blocked).toHaveLength(3);
    });
  });

  describe('vocabulary', () => {
    it('intersects functions, aggregates and constants', () => {
      const out = intersectScalarFields([
        listing('a', [field('band')],
          { functions: ['sqrt', 'abs'], aggregates: ['mean', 'std'], constants: ['pi', 'e'] }),
        listing('b', [field('band')],
          { functions: ['sqrt'], aggregates: ['mean'], constants: ['pi'] }),
      ], 2);
      expect(out.vocabulary.functions).toEqual(['sqrt']);
      expect(out.vocabulary.aggregates).toEqual(['mean']);
      expect(out.vocabulary.constants).toEqual(['pi']);
    });

    it('never offers a field only some clouds carry', () => {
      const out = intersectScalarFields([
        listing('a', [field('band'), field('only_a')]),
        listing('b', [field('band')]),
      ], 2);
      expect(out.vocabulary.fields).not.toContain('only_a');
    });
  });
});

function stats(over: Partial<ScalarStats>): ScalarStats {
  return {
    count: 100, finite_count: 100, nan_count: 0, inf_count: 0,
    ...over,
  };
}

describe('poolingCaution', () => {
  it('says nothing for a single cloud', () => {
    expect(poolingCaution('tree_instance', stats({ min: 1, max: 5 }), 1)).toBeNull();
  });

  it('says nothing without statistics to judge', () => {
    expect(poolingCaution('band', null, 3)).toBeNull();
  });

  it('warns that class ids are assigned per cloud', () => {
    const msg = poolingCaution('tree_instance', stats({ min: 1, max: 40 }), 2);
    expect(msg).toMatch(/per cloud/i);
    expect(msg).toMatch(/histogram/i);
  });

  it('warns about an integer-valued column with a small span', () => {
    const msg = poolingCaution('band', stats({ min: 1, max: 10, median: 5 }), 2);
    expect(msg).toMatch(/class column/i);
  });

  it('stays quiet for a continuous measurement', () => {
    expect(poolingCaution('reflectance', stats({ min: -12.4, max: 3.7, median: -2.1 }), 2))
      .toBeNull();
  });

  it('stays quiet for an integer column spanning too wide to be a class list', () => {
    expect(poolingCaution('point_id', stats({ min: 0, max: 1_000_000, median: 500_000 }), 2))
      .toBeNull();
  });

  it('stays quiet when the column has no finite values', () => {
    expect(poolingCaution('empty', stats({}), 2)).toBeNull();
  });
});

describe('sharedFailureReason', () => {
  it('returns the reason when every cloud failed the same way', () => {
    const msg = "'time' is how an imported column of that meaning is named";
    expect(sharedFailureReason([{ message: msg }, { message: msg }])).toBe(msg);
  });
  it('returns null when the reasons differ, or nothing failed', () => {
    expect(sharedFailureReason([{ message: 'a' }, { message: 'b' }])).toBeNull();
    expect(sharedFailureReason([])).toBeNull();
  });
});
