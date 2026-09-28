import { useEffect, useMemo, useRef } from 'react';
import type { SlabRegion } from '../../../lib/crossSection';
import { insetFrame, slabFootprint, type Rect2 } from '../../../lib/sectionInset';

const SIZE = 144;
const PAD = 8;

/**
 * Top-down map of the sectioned cloud with the slab drawn on it.
 *
 * A face-on section shows a thin slice with no sense of where in the cloud it
 * is. Paging through with `,` / `.` makes that worse: every slice looks alike.
 * This is the "you are here" — the cloud's footprint in gray, the slab as a
 * blue band that moves as the section steps. Display-only (pointer-events off)
 * so it never steals a click meant for the viewport.
 */
export function SectionInset({
  slab, bounds, footprint, suspended,
}: {
  slab: SlabRegion;
  bounds: Rect2;
  /** World XY pairs (see sampleOctreeFootprint); empty until tiles load. */
  footprint: Float32Array;
  suspended: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const corners = useMemo(() => slabFootprint(slab), [slab]);
  const frame = useMemo(() => insetFrame(bounds, corners, SIZE, PAD), [bounds, corners]);
  const slabPx = useMemo(() => {
    const px = corners.map((c) => frame.toPx(c.x, c.y));
    return {
      pts: px,
      cx: px.reduce((k, p) => k + p.x, 0) / 4,
      cy: px.reduce((k, p) => k + p.y, 0) / 4,
    };
  }, [corners, frame]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = SIZE * dpr;
    c.height = SIZE * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.fillStyle = 'rgba(163,163,163,0.55)';
    for (let i = 0; i < footprint.length; i += 2) {
      const p = frame.toPx(footprint[i], footprint[i + 1]);
      ctx.fillRect(p.x, p.y, 1, 1);
    }
    // Bounds outline, so an empty footprint (tiles still loading) still reads
    // as "the cloud is here".
    const lo = frame.toPx(bounds.minX, bounds.minY);
    const hi = frame.toPx(bounds.maxX, bounds.maxY);
    ctx.strokeStyle = 'rgba(115,115,115,0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect(lo.x, hi.y, hi.x - lo.x, lo.y - hi.y);
    // The slab — at least 2 px across, or a thin slab over a big cloud vanishes.
    ctx.beginPath();
    slabPx.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = suspended ? 'rgba(56,189,248,0.25)' : 'rgba(56,189,248,0.45)';
    ctx.fill();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [footprint, frame, bounds, slabPx, suspended]);

  return (
    <div
      data-testid="section-inset"
      data-slab-px={`${slabPx.cx.toFixed(1)},${slabPx.cy.toFixed(1)}`}
      data-footprint-points={footprint.length / 2}
      className="absolute bottom-14 left-20 z-20 pointer-events-none bg-neutral-900/85 border border-neutral-700/60 rounded-lg shadow-lg p-1"
      title="Where the section sits in the cloud (top-down)"
    >
      <canvas ref={canvasRef} style={{ width: SIZE, height: SIZE, display: 'block' }} />
    </div>
  );
}
