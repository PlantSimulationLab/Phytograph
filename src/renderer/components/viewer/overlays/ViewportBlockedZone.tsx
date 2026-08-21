import type { BlockedRect, ScreenPoint } from '../../../lib/viewportBlockers';

interface ViewportBlockedZoneProps {
  /** Panel rects (viewer-local px) the active tool's clicks can't reach. */
  rects: BlockedRect[];
  /** Clamped pointer position — where the ⊘ marker goes while blocked. */
  cursor: ScreenPoint | null;
  /** True while the real pointer is on a blocker. */
  blocked: boolean;
  testId: string;
}

/**
 * The "can't draw here" feedback for the viewport's screen-space tools.
 *
 * The crop lasso / rect / trunk-seed overlays sit at z-10, under every floating
 * panel, so those panels take the clicks. That used to be invisible: the preview
 * froze on entering a panel and clicks there did nothing, with no explanation.
 *
 * The feedback is deliberately confined to the MOMENT of refusal — a ⊘ at the
 * clamped cursor while the pointer is over a panel — rather than a standing
 * hatch over the panels. That a panel takes its own clicks is self-evident from
 * looking at it; painting the whole occluded region amounts to explaining
 * something the user already knows, and it does so by covering the panels in
 * amber for the entire draw. The rects still drive the clamping (the rubber-band
 * stops at the panel edge instead of freezing) — they just aren't painted.
 *
 * It's `pointer-events-none` so the panels stay fully clickable — the point is
 * to explain the occlusion, not to add another layer of it. z-[120] puts the
 * marker above everything it describes: panels (20–55) and the toast stack (110).
 */
export function ViewportBlockedZone({
  rects,
  cursor,
  blocked,
  testId,
}: ViewportBlockedZoneProps) {
  if (rects.length === 0) return null;

  return (
    <svg
      data-testid={testId}
      data-zone-count={rects.length}
      data-cursor-blocked={blocked ? 'true' : 'false'}
      // The measured blockers, in viewer-local px. Nothing paints them any more,
      // so this is how a test reads the geometry the clamping actually uses —
      // notably that the right-hand stack contributes only its real panels.
      data-zone-rects={JSON.stringify(
        rects.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]),
      )}
      className="absolute inset-0 z-[120]"
      width="100%"
      height="100%"
      style={{ pointerEvents: 'none' }}
    >
      {/* Refused-cursor marker at the clamped point (drawn above the panels so
          it stays visible however deep the pointer goes). */}
      {blocked && cursor && (
        <g>
          <circle
            cx={cursor.x}
            cy={cursor.y}
            r={7}
            fill="rgba(23,23,23,0.6)"
            stroke="#f59e0b"
            strokeWidth={2}
          />
          <line
            x1={cursor.x - 5}
            y1={cursor.y + 5}
            x2={cursor.x + 5}
            y2={cursor.y - 5}
            stroke="#f59e0b"
            strokeWidth={2}
          />
        </g>
      )}
    </svg>
  );
}
