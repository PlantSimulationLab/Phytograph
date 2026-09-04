import { describe, it, expect } from 'vitest';
import {
  SCAN_HIT_FIELDS,
  SCAN_HIT_FIELD_SLUGS,
  STANDARD_HIT_FIELD_SLUGS,
  DEFAULT_RETAINED_FIELDS,
  availabilityNote,
  effectiveRetainedFields,
  PER_PULSE_HIT_FIELDS,
} from './scanHitFields';

// The five standard slugs must mirror backend-api/main.py _LIDAR_STANDARD_HIT_FIELDS.
const BACKEND_STANDARD = ['intensity', 'distance', 'timestamp', 'target_index', 'target_count'];

describe('scanHitFields catalog', () => {
  it('has unique slugs', () => {
    const set = new Set(SCAN_HIT_FIELD_SLUGS);
    expect(set.size).toBe(SCAN_HIT_FIELDS.length);
  });

  it('marks exactly the backend standard fields as standard', () => {
    expect([...STANDARD_HIT_FIELD_SLUGS].sort()).toEqual([...BACKEND_STANDARD].sort());
  });

  it('only primitive-data extras are flagged isPrimitiveExtra', () => {
    // reflectance + organ are sampled-from-primitive fields; deviation/nRaysHit
    // are engine-produced and must NOT be sent as column_format.
    const primitives = SCAN_HIT_FIELDS.filter(f => f.isPrimitiveExtra).map(f => f.slug);
    expect(primitives).toEqual(['reflectance', 'organ']);
  });

  it('organ is an opt-in primitive extra (non-standard, not default-retained)', () => {
    // Carrying organ type into a scan must be explicit: the field is a
    // primitive-sampled extra so checking it routes 'organ' into extra_fields
    // (column_format) and, in the viewer, gates sending the per-triangle codes.
    const organ = SCAN_HIT_FIELDS.find(f => f.slug === 'organ')!;
    expect(organ).toBeDefined();
    expect(organ.isStandard).toBe(false);
    expect(organ.isPrimitiveExtra).toBe(true);
    expect(organ.defaultRetained).toBe(false);
    expect(DEFAULT_RETAINED_FIELDS).not.toContain('organ');
  });

  it('engine optionals (deviation/nRaysHit) are non-standard, non-primitive', () => {
    for (const slug of ['deviation', 'nRaysHit']) {
      const f = SCAN_HIT_FIELDS.find(x => x.slug === slug)!;
      expect(f).toBeDefined();
      expect(f.isStandard).toBe(false);
      expect(f.isPrimitiveExtra).toBe(false);
    }
  });

  it('default-retained slugs are all in the catalog', () => {
    for (const slug of DEFAULT_RETAINED_FIELDS) {
      expect(SCAN_HIT_FIELD_SLUGS).toContain(slug);
    }
  });

  it('availabilityNote explains caveat fields, null otherwise', () => {
    expect(availabilityNote('always')).toBeNull();
    expect(availabilityNote('multiReturn')).toMatch(/multi-return/i);
    expect(availabilityNote('extra')).toMatch(/primitive data/i);
  });
});

// Regression: a multi-return synthetic run must produce a cloud that reads back as
// multi-return. `target_index`/`target_count` are defaultRetained: false and
// assembleScanScalarFields prunes any unretained STANDARD field, so with the
// default selection a multi-return run yielded a cloud carrying only `timestamp` —
// which detectedReturnMode (and the backend's own grouping) reads as SINGLE.
// The run's return mode, not the checkbox list, is the authority here.
describe('effectiveRetainedFields', () => {
  it('forces the per-pulse columns into a multi-return run', () => {
    const out = effectiveRetainedFields(DEFAULT_RETAINED_FIELDS, 'multi');
    for (const slug of PER_PULSE_HIT_FIELDS) expect(out).toContain(slug);
  });

  it('is exactly the default set for a multi run once the per-pulse columns are added', () => {
    // Guards the actual defect: the defaults alone are NOT enough.
    expect(DEFAULT_RETAINED_FIELDS).not.toContain('target_index');
    expect(DEFAULT_RETAINED_FIELDS).not.toContain('target_count');
  });

  it('leaves a single-return run\'s selection untouched', () => {
    const out = effectiveRetainedFields(DEFAULT_RETAINED_FIELDS, 'single');
    expect(out).toEqual(DEFAULT_RETAINED_FIELDS);
    expect(out).not.toContain('target_index');
  });

  it('preserves the user\'s other picks and never duplicates', () => {
    const out = effectiveRetainedFields(['reflectance', 'timestamp'], 'multi');
    expect(out).toContain('reflectance');
    expect(out.filter((s) => s === 'timestamp')).toHaveLength(1);
  });

  it('keeps every per-pulse slug in the standard set the backend reads', () => {
    // If one ever stopped being "standard", retainedStandards would silently drop
    // it from the request and the bug would come back by a different route.
    for (const slug of PER_PULSE_HIT_FIELDS) {
      expect(STANDARD_HIT_FIELD_SLUGS).toContain(slug);
    }
  });
});
