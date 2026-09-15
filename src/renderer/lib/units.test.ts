import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UNIT_TO_METRES,
  UNIT_LABELS,
  UNIT_ORDER,
  DEFAULT_UNIT,
  isLengthUnit,
  metresPerUnit,
  unitLabel,
  wouldConvert,
  unitSummary,
  type LengthUnit,
} from './units';

describe('the unit table', () => {
  it('has metres as exactly 1', () => {
    expect(UNIT_TO_METRES.m).toBe(1.0);
  });

  it('keeps the two feet distinct', () => {
    // ~2 mm over a 1 km survey. US State Plane zones use the survey foot, so
    // collapsing them would be a silent error in exactly the datasets that
    // bother to declare the difference.
    expect(UNIT_TO_METRES.ftUS).not.toBe(UNIT_TO_METRES.ft);
    expect(UNIT_TO_METRES.ftUS).toBeCloseTo(0.30480060960121924, 15);
    expect(UNIT_TO_METRES.ft).toBe(0.3048);
  });

  it('labels and orders every unit it can convert', () => {
    const slugs = Object.keys(UNIT_TO_METRES).sort();
    expect(Object.keys(UNIT_LABELS).sort()).toEqual(slugs);
    expect([...UNIT_ORDER].sort()).toEqual(slugs);
  });

  it('offers metres first, since it is the default', () => {
    expect(UNIT_ORDER[0]).toBe('m');
    expect(DEFAULT_UNIT).toBe('m');
  });
});

describe('the backend contract', () => {
  // The renderer selects a unit and the BACKEND applies it. If the two tables
  // disagree, a cloud is scaled by one factor and labelled with another — a
  // silent, data-corrupting mismatch that no single-language test can see.
  // So this reads main.py's table and asserts agreement, the same way
  // octreeCacheRoot is asserted from both sides.
  const mainPy = readFileSync(
    join(__dirname, '..', '..', '..', 'backend-api', 'main.py'),
    'utf8',
  );

  function backendTable(): Record<string, number> {
    const block = mainPy.match(/_UNIT_TO_METRES:\s*Dict\[str,\s*float\]\s*=\s*\{([\s\S]*?)\n\}/);
    if (!block) throw new Error('could not find _UNIT_TO_METRES in main.py');
    const out: Record<string, number> = {};
    for (const line of block[1].split('\n')) {
      const m = line.match(/^\s*"([A-Za-z]+)":\s*([^,]+),/);
      if (!m) continue;
      // Values are literals or a simple ratio (1200.0 / 3937.0).
      const expr = m[2].trim();
      const ratio = expr.match(/^([\d.]+)\s*\/\s*([\d.]+)$/);
      out[m[1]] = ratio
        ? parseFloat(ratio[1]) / parseFloat(ratio[2])
        : parseFloat(expr);
    }
    return out;
  }

  it('finds a parseable table in main.py', () => {
    // Guards the parser itself: an empty result would make every assertion
    // below vacuously pass.
    const t = backendTable();
    expect(Object.keys(t).length).toBeGreaterThanOrEqual(7);
  });

  it('defines exactly the same units as the backend', () => {
    expect(Object.keys(backendTable()).sort()).toEqual(Object.keys(UNIT_TO_METRES).sort());
  });

  it('agrees with the backend on every conversion factor', () => {
    const t = backendTable();
    for (const [slug, factor] of Object.entries(t)) {
      expect(
        UNIT_TO_METRES[slug as LengthUnit],
        `factor for "${slug}" differs between units.ts and main.py`,
      ).toBeCloseTo(factor, 15);
    }
  });
});

describe('metresPerUnit', () => {
  it('converts the units it knows', () => {
    expect(metresPerUnit('mm')).toBe(0.001);
    expect(metresPerUnit('km')).toBe(1000);
  });

  it('returns null rather than a silent 1.0 for an unknown unit', () => {
    // Defaulting an unrecognised slug to metres is how a wrong scale ships
    // unnoticed; the caller must handle the null.
    expect(metresPerUnit('furlong')).toBeNull();
    expect(metresPerUnit(null)).toBeNull();
    expect(metresPerUnit(undefined)).toBeNull();
    expect(metresPerUnit('')).toBeNull();
  });
});

describe('isLengthUnit', () => {
  it('accepts every table key and rejects anything else', () => {
    for (const slug of UNIT_ORDER) expect(isLengthUnit(slug)).toBe(true);
    expect(isLengthUnit('furlong')).toBe(false);
    expect(isLengthUnit(3)).toBe(false);
    expect(isLengthUnit(null)).toBe(false);
    // Not fooled by inherited Object properties.
    expect(isLengthUnit('toString')).toBe(false);
    expect(isLengthUnit('constructor')).toBe(false);
  });
});

describe('wouldConvert', () => {
  it('is false for metres and for anything unrecognised', () => {
    expect(wouldConvert('m')).toBe(false);
    expect(wouldConvert('furlong')).toBe(false);
    expect(wouldConvert(null)).toBe(false);
  });

  it('is true for every non-metre unit', () => {
    for (const slug of UNIT_ORDER) {
      if (slug === 'm') continue;
      expect(wouldConvert(slug), `${slug} should convert`).toBe(true);
    }
  });
});

describe('unitSummary', () => {
  it('states the fact when the format declared the unit', () => {
    expect(unitSummary('ftUS', true)).toContain('This file declares');
    expect(unitSummary('ftUS', true)).toContain('converted to metres');
  });

  it('frames it as the user’s choice when the format could not say', () => {
    const s = unitSummary('mm', false);
    expect(s).toContain('read as');
    expect(s).not.toContain('This file declares');
  });

  it('does not offer to convert metres into metres', () => {
    expect(unitSummary('m', true)).not.toContain('converted');
    expect(unitSummary('m', false)).not.toContain('converted');
  });
});

describe('unitLabel', () => {
  it('names the two feet distinguishably', () => {
    expect(unitLabel('ft')).not.toBe(unitLabel('ftUS'));
    expect(unitLabel('ft')).toContain('international');
    expect(unitLabel('ftUS')).toContain('US survey');
  });

  it('falls back to the raw slug rather than throwing', () => {
    expect(unitLabel('furlong')).toBe('furlong');
    expect(unitLabel(null)).toBe('');
  });
});
