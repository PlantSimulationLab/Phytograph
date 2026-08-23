// The global shift must be SHARED across scans imported together.
//
// It is auto-suggested per file as floor(min) per axis, so scans of one site
// get different values -- measured [-20018,-20000], [-19993,-20001] and
// [-19990,-20001] on a three-scan vineyard, purely because the scanners stood
// 25-28 m apart. Clouds render at `world - displayOffset - worldShift`, so
// scans that disagree are drawn in different frames: registration aligns them
// correctly in world coordinates and the viewport re-separates them by the
// difference. A correct alignment then looks metres wrong.
import { describe, expect, it } from 'vitest';

/** The batch rule: take the smallest suggestion seen so far, per axis. */
function sharedShift(suggestions: ([number, number] | null)[]): [number, number] | null {
  return suggestions.reduce<[number, number] | null>((acc, s) => {
    if (!s) return acc;
    return acc ? [Math.min(acc[0], s[0]), Math.min(acc[1], s[1])] : [s[0], s[1]];
  }, null);
}

describe('shared global shift across a batch', () => {
  it('gives every scan of a site one frame', () => {
    // The real GrapeX suggestions.
    const suggestions: [number, number][] = [
      [-20018, -20000], [-19993, -20001], [-19990, -20001],
    ];
    const shared = sharedShift(suggestions)!;
    // Every scan uses the same value, so no pair is displaced relative to
    // another however far apart the scanners stood.
    for (const s of suggestions) {
      expect(sharedShift([s, ...suggestions])).toEqual(shared);
    }
  });

  it('stays at or below every scan own floor(min), keeping coords positive', () => {
    const suggestions: [number, number][] = [
      [-20018, -20000], [-19993, -20001], [-19990, -20001],
    ];
    const shared = sharedShift(suggestions)!;
    for (const s of suggestions) {
      expect(shared[0]).toBeLessThanOrEqual(s[0]);
      expect(shared[1]).toBeLessThanOrEqual(s[1]);
    }
  });

  it('does not depend on the order previews finish in', () => {
    // Previews resolve concurrently, so an order-dependent rule would give a
    // different frame run to run.
    const a: [number, number][] = [[-20018, -20000], [-19993, -20001], [-19990, -20001]];
    const b = [a[2], a[0], a[1]];
    const c = [a[1], a[2], a[0]];
    expect(sharedShift(b)).toEqual(sharedShift(a));
    expect(sharedShift(c)).toEqual(sharedShift(a));
  });

  it('leaves a batch with no suggestions unshifted', () => {
    // Small local coordinates (the peach case) need no shift at all.
    expect(sharedShift([null, null, null])).toBeNull();
  });

  it('would have separated the vineyard scans if left per-file', () => {
    // Guards the premise: if per-file shifts were harmless this test is moot.
    const perFile: [number, number][] = [[-20018, -20000], [-19993, -20001]];
    const gap = Math.hypot(perFile[0][0] - perFile[1][0], perFile[0][1] - perFile[1][1]);
    expect(gap).toBeGreaterThan(20);
  });
});


// The rule above is only useful if the wizard actually applies it, and if
// "apply to all" carries the shift. Both are one-line reverts away, and neither
// is reachable in a unit test without mounting the wizard, so pin the source.
describe('wizard call sites', () => {
  it('apply-to-all propagates the shift, not just the columns', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(process.cwd(), 'src/renderer/components/PointCloudImportWizard.tsx'), 'utf8');

    const block = src.slice(
      src.indexOf('const applyCurrentToAll = useCallback'),
      src.indexOf('// Whenever applyToAll is toggled on'));
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('shiftEnabled: src.shiftEnabled');
    expect(block).toContain('shift: { ...src.shift }');
  });

  it('a hand-edited shift is not overwritten by a later preview', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(process.cwd(), 'src/renderer/components/PointCloudImportWizard.tsx'), 'utf8');

    // Previews resolve one per file, so seeding must skip configs the user
    // already touched or their choice is silently reverted mid-import.
    expect(src).toContain('base.shiftTouched');
    expect(src).toContain('shiftTouched: true');
  });
});
