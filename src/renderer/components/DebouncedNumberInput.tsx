import { useCallback, useEffect, useId, useRef, useState } from 'react';

interface DebouncedNumberInputProps {
  value: number;
  // Called only with a parsed, validated value — never the raw typing.
  // Fires on Enter, blur, or after `debounceMs` of no input.
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  step?: number | string;
  debounceMs?: number;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  // Test/automation hooks copied through to the underlying <input>.
  id?: string;
  'data-testid'?: string;
  'aria-label'?: string;
  // Allow callers to integer-parse or constrain in their own way.
  parse?: (raw: string) => number;
  // How to render the current numeric value as a string. Useful for fixed
  // decimal places. Default: String(value), with NaN/Infinity rendered blank.
  format?: (n: number) => string;
}

// Number input that doesn't fire onCommit on every keystroke. Used in the
// viewer's color-range, point-size, filter, etc. inputs where every parent
// re-render rebuilds a multi-million-point geometry, which is intolerable
// to do per keystroke on large clouds.
//
// Commits happen on:
//   - Enter pressed
//   - Blur (tab away / click out)
//   - `debounceMs` (default 400ms) of no further input
//
// While the input is focused, parent value changes don't clobber the local
// draft; once blurred, the draft re-syncs from the parent. This avoids the
// cursor-jumping problem when the parent normalises the value on commit.
export function DebouncedNumberInput({
  value,
  onCommit,
  min,
  max,
  step,
  debounceMs = 400,
  disabled,
  placeholder,
  className,
  id,
  parse = parseFloat,
  format = defaultFormat,
  ...rest
}: DebouncedNumberInputProps) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const [draft, setDraft] = useState(() => format(value));
  const [focused, setFocused] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-sync the visible string with the parent's value when not actively
  // editing. The focus guard prevents a parent re-render mid-typing from
  // overwriting partial input like "1." while you're typing "1.5".
  useEffect(() => {
    if (!focused) setDraft(format(value));
  }, [value, focused, format]);

  const cancelDebounce = useCallback(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  // Cancel any pending debounce on unmount so we don't fire onCommit after
  // the input has gone away.
  useEffect(() => () => cancelDebounce(), [cancelDebounce]);

  const tryCommit = useCallback((raw: string) => {
    cancelDebounce();
    const parsed = parse(raw);
    if (!Number.isFinite(parsed)) return;
    // Clamp to bounds if both are supplied. We don't snap to `step` — the
    // step attribute is purely a UI hint for arrow keys.
    let next = parsed;
    if (typeof min === 'number') next = Math.max(min, next);
    if (typeof max === 'number') next = Math.min(max, next);
    if (next !== value) onCommit(next);
  }, [cancelDebounce, max, min, onCommit, parse, value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setDraft(raw);
    cancelDebounce();
    debounceRef.current = setTimeout(() => tryCommit(raw), debounceMs);
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    setFocused(false);
    tryCommit(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // Stop propagation so global keydown handlers (e.g. the crop
      // panel's Enter-to-apply shortcut) don't fire on top of the
      // input's own commit. Otherwise typing a coordinate and hitting
      // Enter would commit AND apply the crop in the same keystroke.
      e.preventDefault();
      e.stopPropagation();
      tryCommit((e.target as HTMLInputElement).value);
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      // Discard the draft and restore the committed value.
      e.preventDefault();
      e.stopPropagation();
      cancelDebounce();
      setDraft(format(value));
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <input
      id={inputId}
      // type="text" + inputMode="decimal" gives us a plain numeric input
      // with no native spinner arrows (which look out of place in a
      // precision-typing app) and the correct soft keypad on mobile.
      // Validation/clamping is all JS-side in tryCommit. Auto-select on
      // focus is handled by a global listener in App.tsx.
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={handleChange}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      step={step}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
      data-testid={rest['data-testid']}
      aria-label={rest['aria-label']}
    />
  );
}

function defaultFormat(n: number): string {
  return Number.isFinite(n) ? String(n) : '';
}
