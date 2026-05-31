import { describe, it, expect } from 'vitest';
import { compactLabels, mergeTrees, splitTreeByGaps } from './treeEdit';

const u = (labels: number[]) =>
  Array.from(new Set(labels.filter((v) => v > 0))).sort((a, b) => a - b);

describe('compactLabels', () => {
  it('renumbers non-zero ids to contiguous 1..K, preserving 0', () => {
    const out = Array.from(compactLabels(Float32Array.from([0, 3, 3, 7, 0, 10])));
    expect(out).toEqual([0, 1, 1, 2, 0, 3]);
  });
});

describe('mergeTrees', () => {
  it('merges ids into the smallest, then compacts', () => {
    // trees 1,2,3 → merge {2,3} → {1, 2(was2/3)} → compact stays 1,2
    const out = Array.from(mergeTrees(Float32Array.from([1, 2, 3, 3, 2, 1]), [2, 3]));
    expect(u(out)).toEqual([1, 2]);
    // every point that was 2 or 3 now shares one id
    expect(out[1]).toBe(out[2]);
    expect(out[2]).toBe(out[3]);
    expect(out[0]).not.toBe(out[1]); // tree 1 distinct
  });

  it('is a no-op (compacted) when fewer than 2 ids given', () => {
    const out = Array.from(mergeTrees(Float32Array.from([1, 2, 0]), [2]));
    expect(out).toEqual([1, 2, 0]);
  });
});

describe('splitTreeByGaps', () => {
  it('splits a tree into spatially-disconnected components', () => {
    // Two clusters of tree-1 points, far apart (> maxGap); one tree-2 point.
    const positions = Float32Array.from([
      0, 0, 0,   0.1, 0, 0,   // cluster A (tree 1)
      10, 0, 0,  10.1, 0, 0,  // cluster B (tree 1), 10 m away
      0, 5, 0,                // tree 2 (untouched)
    ]);
    const labels = Float32Array.from([1, 1, 1, 1, 2]);
    const out = Array.from(splitTreeByGaps(positions, labels, 1, 1.0));
    // tree 1 became two trees; tree 2 still present → 3 ids total
    expect(u(out).length).toBe(3);
    expect(out[0]).toBe(out[1]);   // cluster A shares an id
    expect(out[2]).toBe(out[3]);   // cluster B shares an id
    expect(out[0]).not.toBe(out[2]); // A and B differ
    expect(out[4]).not.toBe(out[0]);
    expect(out[4]).not.toBe(out[2]); // tree 2 distinct from both
  });

  it('leaves an already-connected tree unchanged (compacted)', () => {
    const positions = Float32Array.from([0, 0, 0, 0.1, 0, 0, 0.2, 0, 0]);
    const labels = Float32Array.from([1, 1, 1]);
    const out = Array.from(splitTreeByGaps(positions, labels, 1, 1.0));
    expect(u(out)).toEqual([1]);
  });
});
