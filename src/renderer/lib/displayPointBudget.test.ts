import { describe, it, expect } from 'vitest';
import {
  resolveDisplayPointBudget, parseDisplayPointBudgetDraft,
  resolveCropPreviewPointBudget, CROP_PREVIEW_BUDGET_FRACTION,
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

describe('resolveCropPreviewPointBudget', () => {
  // The bug this function exists to fix: the crop preview used a flat 150_000,
  // which is BELOW the app's own MIN_DISPLAY_POINT_BUDGET — the threshold this
  // module documents as where a large cloud degrades to scattered dots. Box
  // mode was the one place that went there deliberately, and it is what made
  // the cloud "almost non-viewable" while cropping.
  it('never returns less than the viewability floor', () => {
    expect(resolveCropPreviewPointBudget(DEFAULT_DISPLAY_POINT_BUDGET))
      .toBeGreaterThanOrEqual(MIN_DISPLAY_POINT_BUDGET);
    // The exact case that regressed: a quarter of the default is 500k, but
    // even a user sitting at the minimum must not be pushed under it.
    expect(resolveCropPreviewPointBudget(MIN_DISPLAY_POINT_BUDGET))
      .toBe(MIN_DISPLAY_POINT_BUDGET);
    expect(resolveCropPreviewPointBudget(400_000)).toBe(MIN_DISPLAY_POINT_BUDGET);
    // Pinned against the old constant so it can't creep back.
    expect(resolveCropPreviewPointBudget(DEFAULT_DISPLAY_POINT_BUDGET))
      .toBeGreaterThan(150_000);
  });

  // The second half of the bug: the old constant ignored the setting, so a
  // workstation configured for 10M still fell to 150k on entering Box mode.
  it('scales with the user’s budget instead of ignoring it', () => {
    expect(resolveCropPreviewPointBudget(2_000_000)).toBe(500_000);
    expect(resolveCropPreviewPointBudget(10_000_000)).toBe(2_500_000);
    expect(resolveCropPreviewPointBudget(MAX_DISPLAY_POINT_BUDGET))
      .toBe(MAX_DISPLAY_POINT_BUDGET * CROP_PREVIEW_BUDGET_FRACTION);
    // Strictly monotone: a bigger setting always previews with more points.
    const budgets = [500_000, 2_000_000, 8_000_000, 30_000_000];
    const previews = budgets.map(resolveCropPreviewPointBudget);
    for (let i = 1; i < previews.length; i++) {
      expect(previews[i]).toBeGreaterThan(previews[i - 1]);
    }
  });

  // It must stay a REDUCTION — the whole point is guarding fragment overdraw
  // from the clip volume's `discard`. A preview richer than normal viewing
  // would be worse than no guard at all.
  it('never hands out more points than normal viewing', () => {
    for (const b of [MIN_DISPLAY_POINT_BUDGET, 300_000, 1_000_000, 30_000_000]) {
      expect(resolveCropPreviewPointBudget(b)).toBeLessThanOrEqual(b);
    }
    // And it is a real cut wherever the floor isn't binding.
    expect(resolveCropPreviewPointBudget(2_000_000)).toBeLessThan(2_000_000);
  });

  it('falls back to the floor on a junk budget rather than returning NaN', () => {
    expect(resolveCropPreviewPointBudget(0)).toBe(MIN_DISPLAY_POINT_BUDGET);
    expect(resolveCropPreviewPointBudget(-1)).toBe(MIN_DISPLAY_POINT_BUDGET);
    expect(resolveCropPreviewPointBudget(NaN)).toBe(MIN_DISPLAY_POINT_BUDGET);
    expect(resolveCropPreviewPointBudget(Infinity)).toBe(MIN_DISPLAY_POINT_BUDGET);
  });
});
