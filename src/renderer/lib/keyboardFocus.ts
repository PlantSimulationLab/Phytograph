// Decides whether a single-key shortcut must stand down because the keystroke
// belongs to a focused form control.
//
// The test is "would this control consume a typed character", NOT "is this an
// <input>". A checkbox or radio is an <input> too, and it KEEPS focus after a
// click — so the tag-name test this replaced swallowed every shortcut pressed
// right after checking an object in a panel's picker (t / s / r in the
// Transform tool did nothing until the user clicked somewhere else).

// <input> types that take no typed text. `range` is deliberately absent: a
// slider consumes the arrow keys, which the section-step shortcut also binds.
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'color',
]);

export function isTypingTarget(target: EventTarget | null | undefined): boolean {
  const el = target as HTMLElement | null | undefined;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !NON_TEXT_INPUT_TYPES.has(((el as HTMLInputElement).type || 'text').toLowerCase());
}
