import { describe, expect, it, vi } from 'vitest';
import { createDisplayIndicesCache } from './displayIndicesCache';

const compute = () => null;

function inputs(over: Partial<{ erased: Set<number>; tx: number; preview: boolean; compute: unknown }> = {}) {
  return { compute, erased: ERASED, tx: 0, ty: 0, tz: 0, preview: true, ...over };
}
const ERASED = new Set([1, 2]);

describe('createDisplayIndicesCache', () => {
  it('returns the SAME array for an unchanged cloud, without recomputing', () => {
    // A new array identity is a new GPU index buffer; an unrelated re-render
    // must not produce one.
    const cached = createDisplayIndicesCache<object, unknown>();
    const data = {};
    const run = vi.fn(() => new Uint32Array([0, 3]));
    const a = cached(data, inputs(), run);
    const b = cached(data, inputs(), run);
    expect(b).toBe(a);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['erase set', { erased: new Set([1]) }],
    ['translation', { tx: 0.5 }],
    ['crop preview flag', { preview: false }],
    ['crop inputs (compute identity)', { compute: () => null }],
  ])('recomputes when the %s changes', (_name, change) => {
    const cached = createDisplayIndicesCache<object, unknown>();
    const data = {};
    const run = vi.fn(() => new Uint32Array([0]));
    cached(data, inputs(), run);
    cached(data, inputs(change), run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps clouds apart', () => {
    const cached = createDisplayIndicesCache<object, unknown>();
    const run = vi.fn(() => new Uint32Array([0]));
    cached({}, inputs(), run);
    cached({}, inputs(), run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('caches a null ("draw everything") result too', () => {
    const cached = createDisplayIndicesCache<object, unknown>();
    const data = {};
    const run = vi.fn(() => null);
    expect(cached(data, inputs(), run)).toBeNull();
    expect(cached(data, inputs(), run)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
