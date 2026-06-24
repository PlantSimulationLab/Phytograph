import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';

// A small question-mark icon that reveals an explanatory pop-up on hover or
// keyboard focus. Drop it next to a control's label to explain what the control
// does.
//
// The pop-up is rendered through a portal to <body> with `position: fixed`, so
// it floats above everything and — crucially — never contributes to the scroll
// overflow of an ancestor panel. (An earlier CSS-only version positioned the
// pop-up absolutely *inside* the panel; in a scrollable panel like Tree
// Segmentation that grew the scrollable area and spawned stray scrollbars.)
//
// It opens below the icon, left-aligned by default (`align="left"`, keeps it
// inside a right-docked tool panel); pass `align="right"` to right-align when
// the icon sits near a left edge. Both axes are clamped to the viewport and the
// pop-up flips above the icon when there isn't room below. It's
// `pointer-events-none` so it never intercepts clicks on controls beneath.
interface InfoHintProps {
  // The explanatory text shown in the pop-up.
  text: string;
  // Accessible label for the icon button (e.g. the parameter name).
  label: string;
  align?: 'left' | 'right';
  'data-testid'?: string;
}

export function InfoHint({ text, label, align = 'left', ...rest }: InfoHintProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  // Anchor rect captured when the pop-up opens; null when closed.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  // Final viewport coords, computed once the pop-up has measurable size.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const open = useCallback(() => {
    if (btnRef.current) setAnchor(btnRef.current.getBoundingClientRect());
  }, []);
  const close = useCallback(() => {
    setAnchor(null);
    setPos(null);
  }, []);

  // Position the pop-up from the anchor and its own measured size: clamp to the
  // viewport horizontally, flip above the icon if it would overflow the bottom.
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return;
    const tip = tipRef.current.getBoundingClientRect();
    const margin = 8;
    let left = align === 'right' ? anchor.right - tip.width : anchor.left;
    left = Math.max(margin, Math.min(left, window.innerWidth - tip.width - margin));
    let top = anchor.bottom + 4;
    if (top + tip.height > window.innerHeight - margin) {
      top = Math.max(margin, anchor.top - tip.height - 4);
    }
    setPos({ top, left });
  }, [anchor, align]);

  return (
    <span className="relative inline-flex align-middle">
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        data-testid={rest['data-testid']}
        // Don't submit forms / trigger parent handlers; this is hover-only help.
        onClick={(e) => e.preventDefault()}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        className="text-neutral-500 hover:text-neutral-300 focus:text-neutral-300 focus:outline-none transition-colors"
      >
        <HelpCircle className="w-3 h-3" />
      </button>
      {anchor &&
        createPortal(
          <span
            ref={tipRef}
            role="tooltip"
            style={{
              position: 'fixed',
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              // Hidden until positioned so it never flashes at the origin.
              visibility: pos ? 'visible' : 'hidden',
            }}
            className="pointer-events-none z-50 w-52 rounded border border-neutral-600 bg-neutral-900 p-2 text-[10px] leading-snug text-neutral-200 shadow-lg"
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
