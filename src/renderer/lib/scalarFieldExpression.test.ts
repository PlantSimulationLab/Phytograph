import { describe, it, expect } from 'vitest';
import {
  checkExpression,
  checkSlug,
  closestMatch,
  identifiers,
  suggestSlug,
  MAX_SLUG_LEN,
  type ExpressionVocabulary,
} from './scalarFieldExpression';

const VOCAB: ExpressionVocabulary = {
  fields: ['x', 'y', 'z', 'intensity', 'curvature', 'height_above_ground'],
  functions: ['sqrt', 'abs', 'log', 'atan2', 'ifelse', 'clamp', 'min', 'max'],
  aggregates: ['mean', 'std', 'median', 'percentile'],
  constants: ['pi', 'e', 'nan', 'inf'],
};

describe('checkExpression', () => {
  it('accepts well-formed expressions over known names', () => {
    for (const expr of [
      'intensity * 2',
      'sqrt(x**2 + y**2)',
      '(intensity - mean(intensity)) / std(intensity)',
      'ifelse(curvature > 0.1, 1, 2)',
      'clamp(z, 0, 10)',
      'percentile(intensity, 95)',
      'pi * 2',
    ]) {
      expect(checkExpression(expr, VOCAB), expr).toBeNull();
    }
  });

  it('treats a blank expression as the starting state, not an error', () => {
    // The Run button is what should be disabled; a red box on an empty field
    // greets the user with a complaint before they have typed anything.
    expect(checkExpression('', VOCAB)).toBeNull();
    expect(checkExpression('   ', VOCAB)).toBeNull();
  });

  it('catches an unclosed parenthesis at the opener', () => {
    const p = checkExpression('sqrt(x + y', VOCAB);
    expect(p?.message).toBe('Unclosed parenthesis.');
    expect(p?.col).toBe('sqrt'.length);
  });

  it('catches an unmatched closing parenthesis at the offender', () => {
    const p = checkExpression('x + y)', VOCAB);
    expect(p?.message).toBe('Unmatched closing parenthesis.');
    expect(p?.col).toBe(5);
  });

  it('flags an unknown name with its offset', () => {
    const p = checkExpression('intensity + bogusfield', VOCAB);
    expect(p?.message).toContain('bogusfield');
    expect(p?.col).toBe('intensity + '.length);
  });

  it('suggests the closest match for a typo', () => {
    expect(checkExpression('intensty * 2', VOCAB)?.suggestion).toBe('intensity');
    expect(checkExpression('sqrtt(x)', VOCAB)?.suggestion).toBe('sqrt');
    expect(checkExpression('Intensity * 2', VOCAB)?.suggestion).toBe('intensity');
  });

  it('allows Python keywords that are part of the grammar', () => {
    // The backend accepts the native ternary and boolean operators.
    expect(checkExpression('1 if z > 2 else 0', VOCAB)).toBeNull();
    expect(checkExpression('z > 1 and z < 4', VOCAB)).toBeNull();
    expect(checkExpression('not z', VOCAB)).toBeNull();
  });

  it('does not mistake a number exponent for the constant e', () => {
    expect(checkExpression('intensity * 1e5', VOCAB)).toBeNull();
    expect(checkExpression('intensity * 2.5E-3', VOCAB)).toBeNull();
  });

  it('leaves grammar the backend owns alone', () => {
    // Wrong arity and a misplaced aggregate are both real errors, but they are
    // the AST walker's to report — duplicating its rules here would be a second
    // source of truth that drifts, and drift shows up as the panel greying out
    // a formula that would have worked.
    expect(checkExpression('sqrt(x, y)', VOCAB)).toBeNull();
    expect(checkExpression('mean(3)', VOCAB)).toBeNull();
  });
});

describe('identifiers', () => {
  it('returns each identifier with its offset', () => {
    expect(identifiers('a + bc')).toEqual([
      { name: 'a', col: 0 },
      { name: 'bc', col: 4 },
    ]);
  });

  it('skips exponent markers inside numeric literals', () => {
    expect(identifiers('1e5 + 2.5E-3')).toEqual([]);
  });

  it('does not split an identifier containing digits', () => {
    expect(identifiers('atan2(y, x)').map(i => i.name)).toEqual(['atan2', 'y', 'x']);
  });
});

describe('closestMatch', () => {
  it('prefers an exact case-insensitive match', () => {
    expect(closestMatch('INTENSITY', ['intensity', 'intensive'])).toBe('intensity');
  });

  it('scales its tolerance with name length', () => {
    // One edit for a short name...
    expect(closestMatch('p', ['pi'])).toBe('pi');
    // ...two for a longer one, which is what `intensty` needs.
    expect(closestMatch('intensty', ['intensity'])).toBe('intensity');
  });

  it('returns nothing when no candidate is close', () => {
    expect(closestMatch('completely_different', ['pi', 'e'])).toBeUndefined();
    expect(closestMatch('xyzzy', ['intensity'])).toBeUndefined();
  });
});

describe('suggestSlug', () => {
  it('derives a legal slug from the expression', () => {
    expect(suggestSlug('intensity * 2')).toBe('intensity_2');
    expect(suggestSlug('sqrt(x**2 + y**2)')).toBe('sqrt_x_2_y_2');
  });

  it('never returns something checkSlug would reject', () => {
    for (const expr of ['2 * 3', '((()))', '   ', '1e5', '!!!']) {
      const slug = suggestSlug(expr);
      expect(checkSlug(slug), `${expr} -> ${slug}`).toBeNull();
    }
  });

  it('disambiguates against names already on the cloud', () => {
    expect(suggestSlug('intensity * 2', ['intensity_2'])).toBe('intensity_2_2');
  });

  it('falls back when nothing usable survives', () => {
    expect(suggestSlug('+++')).toBe('field');
  });

  it('truncates within the slug limit', () => {
    expect(suggestSlug('a'.repeat(100)).length).toBeLessThanOrEqual(MAX_SLUG_LEN);
  });
});

describe('checkSlug', () => {
  it('accepts legal names', () => {
    for (const s of ['ndvi', 'my_field', '_x', 'a1', 'A'.repeat(MAX_SLUG_LEN)]) {
      expect(checkSlug(s), s).toBeNull();
    }
  });

  it('rejects malformed names with a reason', () => {
    expect(checkSlug('')).toContain('Enter a name');
    expect(checkSlug('1abc')).toContain('start with a letter');
    expect(checkSlug('has space')).toContain('letters, digits and underscores');
    expect(checkSlug('has-dash')).toContain('letters, digits and underscores');
    expect(checkSlug('a'.repeat(MAX_SLUG_LEN + 1))).toContain('limit is');
  });

  it('rejects a name already on the cloud', () => {
    expect(checkSlug('intensity', ['intensity'])).toContain('already has a field');
  });
});
