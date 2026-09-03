import { describe, it, expect, vi, afterEach } from 'vitest';
import { hasLiveTextSelection, stopClickAfterTextSelection } from './textSelection';

const selection = (text: string) => ({ isCollapsed: text.length === 0, toString: () => text });

describe('hasLiveTextSelection', () => {
  it('is false with no selection object at all', () => {
    expect(hasLiveTextSelection(null)).toBe(false);
  });

  it('is false for a collapsed caret — a plain click, not a drag', () => {
    expect(hasLiveTextSelection(selection(''))).toBe(false);
  });

  // A selection can be non-collapsed and still carry no text (a range spanning
  // only an element boundary). That is not something a user meant to copy, so
  // it must not swallow the click.
  it('is false for a non-collapsed range that yields no text', () => {
    expect(hasLiveTextSelection({ isCollapsed: false, toString: () => '' })).toBe(false);
  });

  it('is true once real text is highlighted', () => {
    expect(hasLiveTextSelection(selection('x: 1.234'))).toBe(true);
  });
});

describe('stopClickAfterTextSelection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lets a plain click through to the row so it still selects', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue(selection('') as unknown as Selection);
    const e = { stopPropagation: vi.fn() };
    stopClickAfterTextSelection(e);
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it('swallows the mouse-up that ends a highlight drag', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue(selection('extent: 1.00') as unknown as Selection);
    const e = { stopPropagation: vi.fn() };
    stopClickAfterTextSelection(e);
    expect(e.stopPropagation).toHaveBeenCalledTimes(1);
  });
});
