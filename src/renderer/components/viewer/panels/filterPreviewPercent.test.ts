import { describe, it, expect } from 'vitest';
import { formatShownPercent } from './FilterPanel';

// The panel reports the live preview as a PROPORTION rather than a count: the
// mask only sees the tiles the octree LOD has streamed in, so an absolute
// number would be a sample of the current view presented as an answer. What
// this formatter has to get right is the two ends, where plain rounding lies
// exactly where a user is most likely to act on it.
describe('formatShownPercent', () => {
  it('rounds an ordinary fraction to whole percent', () => {
    expect(formatShownPercent(0.5)).toBe('50%');
    expect(formatShownPercent(0.6)).toBe('60%');
    expect(formatShownPercent(0.333)).toBe('33%');
  });

  it('shows exact emptiness and exact completeness', () => {
    expect(formatShownPercent(0)).toBe('0%');
    expect(formatShownPercent(1)).toBe('100%');
  });

  it('never rounds a NON-empty result down to 0%', () => {
    // 3 points in 10 million still survive; "0% kept" would read as "this
    // removes everything".
    expect(formatShownPercent(3 / 10_000_000)).toBe('<1%');
    expect(formatShownPercent(0.004)).toBe('<1%');
  });

  it('never rounds an INCOMPLETE result up to 100%', () => {
    // A filter about to delete points must not read as a no-op.
    expect(formatShownPercent(1 - 3 / 10_000_000)).toBe('>99%');
    expect(formatShownPercent(0.999)).toBe('>99%');
  });

  it('handles a non-finite fraction without rendering NaN', () => {
    expect(formatShownPercent(NaN)).toBe('—');
    expect(formatShownPercent(Infinity)).toBe('—');
  });
});
