import { describe, it, expect } from 'vitest';
import { demDefaultsForExtent } from './demDefaults';

describe('demDefaultsForExtent', () => {
  it('reduces to the plant-scale floor at close range (~1.5 m extent)', () => {
    // extent/100 = 0.015, clamped up to CELL_MIN (0.02).
    expect(demDefaultsForExtent(1.5).cellSize).toBe(0.02);
  });

  it('scales linearly in the mid range', () => {
    expect(demDefaultsForExtent(20).cellSize).toBe(0.2);
    expect(demDefaultsForExtent(50).cellSize).toBe(0.5);
  });

  it('clamps to the max cell size for an enormous extent', () => {
    expect(demDefaultsForExtent(1000).cellSize).toBe(2); // CELL_MAX
  });

  it('falls back to the plant-scale default for a non-finite or zero extent', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      // 1.5 * 1/100 = 0.015 → clamped to CELL_MIN 0.02
      expect(demDefaultsForExtent(bad).cellSize).toBe(0.02);
    }
  });
});
