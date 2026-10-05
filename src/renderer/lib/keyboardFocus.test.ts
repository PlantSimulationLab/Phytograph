import { describe, expect, it } from 'vitest';
import { isTypingTarget } from './keyboardFocus';

function input(type?: string): HTMLInputElement {
  const el = document.createElement('input');
  if (type) el.type = type;
  return el;
}

describe('isTypingTarget', () => {
  it('does not treat a checkbox or radio as typing', () => {
    // The regression: a picker checkbox keeps focus after the click that
    // toggles it, and the transform shortcuts were suppressed behind it.
    expect(isTypingTarget(input('checkbox'))).toBe(false);
    expect(isTypingTarget(input('radio'))).toBe(false);
  });

  it('does not treat button-like inputs as typing', () => {
    for (const type of ['button', 'submit', 'reset', 'file', 'color']) {
      expect(isTypingTarget(input(type)), type).toBe(false);
    }
  });

  it('treats text-entry inputs as typing', () => {
    expect(isTypingTarget(input())).toBe(true);
    for (const type of ['text', 'number', 'search', 'email', 'password', 'url', 'tel']) {
      expect(isTypingTarget(input(type)), type).toBe(true);
    }
  });

  it('treats a slider as typing, since it consumes the arrow keys', () => {
    expect(isTypingTarget(input('range'))).toBe(true);
  });

  it('treats textarea, select and contenteditable as typing', () => {
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
    const div = document.createElement('div');
    div.contentEditable = 'true';
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isTypingTarget(div)).toBe(true);
  });

  it('treats non-form elements and nothing-focused as not typing', () => {
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
  });
});
