import { describe, it, expect } from 'vitest';
import {
  EMPTY_LABEL_PENDING, pendingFor, prunePending, totalPendingStrokes, updatePending,
  type LabelPendingMap,
} from './labelPending';
import type { LabelStroke } from './pointCloudTypes';

const stroke = (strokeId: string, toClass = 64): LabelStroke =>
  ({ strokeId, region: {} as never, toClass });
const append = (id: string) => (e: typeof EMPTY_LABEL_PENDING) =>
  ({ ...e, strokes: [...e.strokes, stroke(id)], dirty: true });

describe('labelPending', () => {
  it('keeps each cloud and column separate', () => {
    let m: LabelPendingMap = new Map();
    m = updatePending(m, 'A', 'manual_class', append('a1'));
    m = updatePending(m, 'A', 'manual_class', append('a2'));
    m = updatePending(m, 'A', 'wood_class', append('w1'));
    // Cloud B has nothing of A's, on the same column name or any other.
    expect(pendingFor(m, 'B', 'manual_class')).toBe(EMPTY_LABEL_PENDING);
    expect(pendingFor(m, 'A', 'manual_class').strokes.map((s) => s.strokeId)).toEqual(['a1', 'a2']);
    expect(pendingFor(m, 'A', 'wood_class').strokes.map((s) => s.strokeId)).toEqual(['w1']);
    expect(pendingFor(m, 'A', 'manual_class').dirty).toBe(true);
    expect(totalPendingStrokes(m)).toBe(3);
  });

  it('an unchanged update returns the same map', () => {
    const m: LabelPendingMap = new Map();
    expect(updatePending(m, 'A', 'c', (e) => e)).toBe(m);
  });

  it('never mutates the map it was given', () => {
    const m0 = updatePending(new Map(), 'A', 'c', append('1'));
    const m1 = updatePending(m0, 'A', 'c', append('2'));
    expect(pendingFor(m0, 'A', 'c').strokes).toHaveLength(1);
    expect(pendingFor(m1, 'A', 'c').strokes).toHaveLength(2);
  });

  it('prunes clouds that no longer exist, and only those', () => {
    let m: LabelPendingMap = new Map();
    m = updatePending(m, 'A', 'c', append('1'));
    m = updatePending(m, 'B', 'c', append('2'));
    expect(prunePending(m, new Set(['A', 'B']))).toBe(m);
    const pruned = prunePending(m, new Set(['B']));
    expect([...pruned.keys()]).toEqual(['B']);
    expect(totalPendingStrokes(prunePending(m, new Set()))).toBe(0);
  });

  it('a missing cloud or column reads as empty', () => {
    expect(pendingFor(new Map(), undefined, 'c')).toBe(EMPTY_LABEL_PENDING);
    expect(pendingFor(new Map(), 'A', undefined)).toBe(EMPTY_LABEL_PENDING);
  });
});
