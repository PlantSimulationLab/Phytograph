import { describe, it, expect } from 'vitest';
import {
  resolveDisplayPointBudget, parseDisplayPointBudgetDraft,
  DEFAULT_DISPLAY_POINT_BUDGET, MIN_DISPLAY_POINT_BUDGET, MAX_DISPLAY_POINT_BUDGET,
} from './displayPointBudget';

describe('resolveDisplayPointBudget', () => {
  it('falls back to the default when the setting is blank or invalid', () => {
    expect(resolveDisplayPointBudget(null)).toBe(DEFAULT_DISPLAY_POINT_BUDGET);
    expect(resolveDisplayPointBudget(undefined)).toBe(DEFAULT_DISPLAY_POINT_BUDGET);
    expect(resolveDisplayPointBudget(0)).toBe(DEFAULT_DISPLAY_POINT_BUDGET);
    expect(resolveDisplayPointBudget(-3)).toBe(DEFAULT_DISPLAY_POINT_BUDGET);
    expect(resolveDisplayPointBudget(NaN)).toBe(DEFAULT_DISPLAY_POINT_BUDGET);
    expect(resolveDisplayPointBudget(null, 4_000_000)).toBe(4_000_000);
  });

  it('converts millions to points and clamps to the sane range', () => {
    expect(resolveDisplayPointBudget(2)).toBe(2_000_000);
    expect(resolveDisplayPointBudget(0.5)).toBe(500_000);
    expect(resolveDisplayPointBudget(10)).toBe(10_000_000);
    expect(resolveDisplayPointBudget(0.01)).toBe(MIN_DISPLAY_POINT_BUDGET);
    expect(resolveDisplayPointBudget(1000)).toBe(MAX_DISPLAY_POINT_BUDGET);
  });

  it('parses the settings draft: blank is the default, junk is rejected', () => {
    expect(parseDisplayPointBudgetDraft('')).toBeNull();
    expect(parseDisplayPointBudgetDraft('   ')).toBeNull();
    expect(parseDisplayPointBudgetDraft('abc')).toBeNull();
    expect(parseDisplayPointBudgetDraft('-1')).toBeNull();
    expect(parseDisplayPointBudgetDraft('2.5')).toBe(2.5);
    expect(parseDisplayPointBudgetDraft(' 8 ')).toBe(8);
  });
});
