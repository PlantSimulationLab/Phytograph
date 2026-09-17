import { useState } from 'react';
import {
  histogramBars,
  histogramTicks,
  outsideCaption,
  formatStat,
  formatCount,
  type ScalarHistogramData,
} from '../../lib/scalarFieldStats';

// A read-only distribution plot for one scalar field.
//
// Inline SVG rather than a charting library: the app has no chart dependency
// and this needs one primitive (a rect) plus three text labels. `QSMResultsPopup`
// and `LeafAnglePlotPopup` already draw their distributions the same way, so
// this matches what is here rather than introducing a bundle for it.
//
// Bars are laid out in a 0..1 unit box by `histogramBars` and scaled by the
// viewBox, so the component has no opinion about pixel size — the panel sets
// the width and this fills it.

interface ScalarHistogramProps {
  data: ScalarHistogramData | undefined;
  /** Drawn under the axis when the field's values are whole numbers. */
  integer?: boolean;
  height?: number;
  testId?: string;
}

// The unit box the bars are drawn into. Width is arbitrary (the SVG scales to
// its container); height sets the bar-height resolution.
const VB_W = 1000;
const VB_H = 100;

export function ScalarHistogram({
  data,
  integer = false,
  height = 96,
  testId = 'scalar-histogram',
}: ScalarHistogramProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const bars = histogramBars(data);
  const ticks = histogramTicks(data);
  const outside = outsideCaption(data);

  if (bars.length === 0) {
    return (
      <div
        data-testid={`${testId}-empty`}
        className="flex items-center justify-center text-[10px] text-neutral-500 bg-neutral-900/50 rounded"
        style={{ height }}
      >
        {data?.degenerate
          ? 'Every point has the same value'
          : 'No distribution to show'}
      </div>
    );
  }

  const active = hovered !== null ? bars[hovered] : null;

  return (
    <div data-testid={testId} data-bin-count={bars.length}>
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        style={{ height, width: '100%', display: 'block' }}
        className="bg-neutral-900/50 rounded"
        // `onMouseLeave` on the SVG rather than per-bar: a gap between bars
        // would otherwise leave the tooltip stuck on the last one hovered.
        onMouseLeave={() => setHovered(null)}
      >
        {bars.map((b, i) => (
          <rect
            key={i}
            data-testid={`${testId}-bar`}
            data-count={b.count}
            x={b.x * VB_W}
            width={b.width * VB_W}
            // A non-empty bin always gets at least one unit of height, so a
            // sparse tail is visible rather than rounding away to nothing —
            // which is usually the part of the distribution worth seeing.
            y={VB_H - Math.max(b.height * VB_H, b.count > 0 ? 1 : 0)}
            height={Math.max(b.height * VB_H, b.count > 0 ? 1 : 0)}
            className={i === hovered ? 'fill-lime-300' : 'fill-lime-500/70'}
            onMouseEnter={() => setHovered(i)}
          />
        ))}
      </svg>

      {/* Axis labels. Reserved height even when idle so the panel does not
          reflow as the pointer moves across the chart. */}
      <div className="flex justify-between text-[9px] text-neutral-500 mt-0.5 h-3">
        {ticks.map((t, i) => (
          <span key={i}>{formatStat(t, integer)}</span>
        ))}
      </div>

      <div className="text-[10px] text-neutral-400 h-4 mt-0.5" data-testid={`${testId}-readout`}>
        {active
          ? `${formatStat(active.from, integer)} – ${formatStat(active.to, integer)}: `
            + `${formatCount(active.count)} pts`
          : (outside ?? '')}
      </div>
    </div>
  );
}
