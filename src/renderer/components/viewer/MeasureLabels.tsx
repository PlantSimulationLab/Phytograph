import { useRef, useCallback, type MutableRefObject } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { X, Copy } from 'lucide-react';
import {
  labelAnchor,
  segmentLengths,
  totalLength,
  measurementAngle,
  deltas,
  formatLength,
  formatAngle,
  formatDelta,
  kindLabel,
  measurementToText,
  type Measurement,
} from '../../lib/measure';
import { useCopyFlash } from './PickedPointLabels';
import type { Vec3Like } from '../../lib/pointCloudHelpers';

// Readouts for placed measurements.
//
// Same two-part split as PickedPointLabels, and for the same reason: the camera
// lives inside the R3F canvas but the bubbles are DOM.
//
//   * <MeasureProjector> mounts INSIDE <Canvas> and, every frame, projects each
//     measurement's anchor to canvas pixels and writes the result straight into
//     the DOM through a shared registry. No React state is touched, so orbiting
//     a scene full of measurements costs a few style writes per frame.
//   * <MeasureLabels> mounts as a DOM SIBLING of <Canvas> and owns the markup.
//
// This deliberately does NOT reuse the picked-point registry: the two overlays
// are placed independently and a shared registry would let a measurement bubble
// and a point bubble de-overlap against each other only by accident of which
// projector ran last. Separate registries, same mechanism.

export interface MeasureOverlayRegistry {
  bubbles: Map<string, HTMLElement>;
  lines: Map<string, SVGLineElement>;
  dots: Map<string, SVGCircleElement>;
}

export function useMeasureOverlay(): MutableRefObject<MeasureOverlayRegistry> {
  const ref = useRef<MeasureOverlayRegistry | null>(null);
  if (!ref.current) {
    ref.current = { bubbles: new Map(), lines: new Map(), dots: new Map() };
  }
  return ref as MutableRefObject<MeasureOverlayRegistry>;
}

// Bubble offset from its anchor, and the de-overlap spacing. Measurement labels
// sit BELOW-right of their anchor by default, where picked-point bubbles sit
// above-right, so the two tools' labels don't pile onto the same pixels when a
// user inspects and measures the same region.
const LABEL_BASE = { dx: 22, dy: 30 };
const LABEL_GAP_PX = 4;
const LABEL_MARGIN_PX = 8;

// ── In-canvas projector ────────────────────────────────────────────────────

export function MeasureProjector({
  measurements,
  displayOffset,
  registry,
}: {
  measurements: Measurement[];
  // The scene renders at (local − displayOffset). Anchors come from `local`,
  // never `world` — see labelAnchor and the note in PickedPointLabels.
  displayOffset: Vec3Like;
  registry: MutableRefObject<MeasureOverlayRegistry>;
}) {
  const { camera, size } = useThree();
  const v = useRef(new THREE.Vector3()).current;

  useFrame(() => {
    const { bubbles, lines, dots } = registry.current;
    if (bubbles.size === 0 && dots.size === 0) return;

    type Placement = {
      bubble: HTMLElement | undefined;
      line: SVGLineElement | undefined;
      dot: SVGCircleElement | undefined;
      x: number; y: number;
      bx: number; by: number;
      w: number; h: number;
      visible: boolean;
    };

    // Pass 1 — project and measure. Batched so every layout read happens before
    // any style write; interleaving them forces a reflow per label per frame.
    const items: Placement[] = [];
    for (const m of measurements) {
      const bubble = bubbles.get(m.id);
      const line = lines.get(m.id);
      const dot = dots.get(m.id);
      if (!bubble && !line && !dot) continue;

      const anchor = labelAnchor(m);
      if (!anchor) continue;

      v.set(
        anchor[0] - displayOffset.x,
        anchor[1] - displayOffset.y,
        anchor[2] - displayOffset.z,
      );
      v.project(camera);
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((-v.y + 1) / 2) * size.height;
      // z > 1 puts the anchor behind the camera, where projecting it would
      // mirror the bubble to the wrong side of the screen.
      const visible = v.z <= 1 && isFinite(x) && isFinite(y);

      items.push({
        bubble, line, dot, x, y,
        bx: x + LABEL_BASE.dx,
        by: y + LABEL_BASE.dy,
        w: bubble?.offsetWidth ?? 0,
        h: bubble?.offsetHeight ?? 0,
        visible,
      });
    }

    // Pass 2 — de-overlap. Two measurements a few centimetres apart project to
    // bubbles that cover each other, and the top one swallows the buttons of
    // everything beneath it. Try a small ring of slots and take the first free
    // one; when all are blocked take the least-covered rather than oscillating.
    const placed: Array<{ l: number; t: number; r: number; b: number }> = [];
    for (const it of items) {
      if (!it.visible || !it.bubble) continue;
      const step = it.h + LABEL_GAP_PX;
      const slots: Array<{ dx: number; dy: number }> = [];
      for (const ring of [0, 1, 2]) {
        for (const right of [true, false]) {
          const dx = right ? LABEL_BASE.dx : -LABEL_BASE.dx - it.w;
          slots.push({ dx, dy: LABEL_BASE.dy + ring * step });
          if (ring > 0) slots.push({ dx, dy: LABEL_BASE.dy - ring * step });
        }
      }

      let best: { box: typeof placed[number]; cover: number } | null = null;
      for (const slot of slots) {
        // Clamp into the canvas first, so a slot is scored where it would
        // actually be drawn — an off-screen label is worse than a stacked one.
        const l = Math.min(
          Math.max(it.x + slot.dx, LABEL_MARGIN_PX),
          Math.max(LABEL_MARGIN_PX, size.width - LABEL_MARGIN_PX - it.w),
        );
        const t = Math.min(
          Math.max(it.y + slot.dy, LABEL_MARGIN_PX),
          Math.max(LABEL_MARGIN_PX, size.height - LABEL_MARGIN_PX - it.h),
        );
        const box = { l, t, r: l + it.w, b: t + it.h };
        let cover = 0;
        for (const q of placed) {
          const ox = Math.min(box.r, q.r) - Math.max(box.l, q.l);
          const oy = Math.min(box.b, q.b) - Math.max(box.t, q.t);
          if (ox > 0 && oy > 0) cover += ox * oy;
        }
        if (cover === 0) { best = { box, cover }; break; }
        if (!best || cover < best.cover) best = { box, cover };
      }
      if (!best) continue;
      it.bx = best.box.l;
      it.by = best.box.t;
      placed.push(best.box);
    }

    // Pass 3 — write.
    for (const it of items) {
      const { bubble, line, dot, visible } = it;
      if (dot) dot.style.display = visible ? '' : 'none';
      if (line) line.style.display = visible ? '' : 'none';
      if (bubble) bubble.style.display = visible ? '' : 'none';
      if (!visible) continue;
      if (dot) {
        dot.setAttribute('cx', String(it.x));
        dot.setAttribute('cy', String(it.y));
      }
      if (line) {
        line.setAttribute('x1', String(it.x));
        line.setAttribute('y1', String(it.y));
        line.setAttribute('x2', String(it.bx));
        line.setAttribute('y2', String(it.by));
      }
      if (bubble) {
        bubble.style.transform = `translate3d(${it.bx}px, ${it.by}px, 0)`;
      }
    }
  });

  return null;
}

// ── DOM overlay ────────────────────────────────────────────────────────────

function ValueRow({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex items-baseline gap-3 tabular-nums" data-testid={testId}>
      <span className="flex-1 truncate text-neutral-500">{label}</span>
      <span className="text-neutral-100">{value}</span>
    </div>
  );
}

// The body of a bubble, by measurement kind.
function MeasureBody({ m }: { m: Measurement }) {
  if (m.kind === 'angle') {
    const arms = segmentLengths(m.vertices);
    return (
      <>
        <div
          className="text-[15px] leading-tight text-lime-400 tabular-nums"
          data-testid="measure-value"
        >
          {formatAngle(measurementAngle(m))}°
        </div>
        <div className="mt-1 space-y-0.5">
          {arms.map((a, i) => (
            <ValueRow key={i} label={`arm ${i + 1}`} value={formatLength(a)} />
          ))}
        </div>
      </>
    );
  }

  if (m.kind === 'polyline') {
    const segs = segmentLengths(m.vertices);
    return (
      <>
        <div
          className="text-[15px] leading-tight text-lime-400 tabular-nums"
          data-testid="measure-value"
        >
          {formatLength(totalLength(m.vertices))}
        </div>
        <div className="mt-1 space-y-0.5">
          <ValueRow label="segments" value={String(segs.length)} testId="measure-segment-count" />
          {segs.map((s, i) => (
            <ValueRow key={i} label={`seg ${i + 1}`} value={formatLength(s)} testId="measure-segment" />
          ))}
        </div>
      </>
    );
  }

  const d = m.vertices.length >= 2
    ? deltas(m.vertices[0].world, m.vertices[1].world)
    : null;
  return (
    <>
      <div
        className="text-[15px] leading-tight text-lime-400 tabular-nums"
        data-testid="measure-value"
      >
        {formatLength(totalLength(m.vertices))}
      </div>
      {d && (
        <div className="mt-1 space-y-0.5">
          <ValueRow label="ΔX" value={formatDelta(d.dx)} testId="measure-dx" />
          <ValueRow label="ΔY" value={formatDelta(d.dy)} testId="measure-dy" />
          <ValueRow label="ΔZ" value={formatDelta(d.dz)} testId="measure-dz" />
        </div>
      )}
    </>
  );
}

export function MeasureLabels({
  measurements,
  registry,
  onDismiss,
}: {
  measurements: Measurement[];
  registry: MutableRefObject<MeasureOverlayRegistry>;
  onDismiss: (id: string) => void;
}) {
  const [copiedId, flashCopied] = useCopyFlash();

  const bubbleRef = useCallback((id: string) => (el: HTMLDivElement | null) => {
    if (el) registry.current.bubbles.set(id, el);
    else registry.current.bubbles.delete(id);
  }, [registry]);
  const lineRef = useCallback((id: string) => (el: SVGLineElement | null) => {
    if (el) registry.current.lines.set(id, el);
    else registry.current.lines.delete(id);
  }, [registry]);
  const dotRef = useCallback((id: string) => (el: SVGCircleElement | null) => {
    if (el) registry.current.dots.set(id, el);
    else registry.current.dots.delete(id);
  }, [registry]);

  if (measurements.length === 0) return null;

  return (
    <>
      {/* Anchor dots + leader lines. An <svg> without explicit width/height
          collapses to its 300x150 intrinsic size regardless of CSS inset-0. */}
      <svg
        className="absolute inset-0 z-[45] pointer-events-none"
        width="100%"
        height="100%"
        data-testid="measure-leaders"
      >
        {measurements.map((m) => (
          <g key={m.id}>
            <line
              ref={lineRef(m.id)}
              stroke="#a3e635"
              strokeWidth={1}
              strokeDasharray="3 2"
              opacity={0.8}
              style={{ display: 'none' }}
            />
            <circle
              ref={dotRef(m.id)}
              r={3}
              fill="#a3e635"
              stroke="#1c1917"
              strokeWidth={1}
              style={{ display: 'none' }}
            />
          </g>
        ))}
      </svg>

      {measurements.map((m) => (
        <div
          key={m.id}
          ref={bubbleRef(m.id)}
          data-testid="measure-label"
          data-kind={m.kind}
          // Positioned entirely by the projector; starts hidden so a fresh label
          // never flashes at the top-left before the first frame runs.
          style={{ position: 'absolute', left: 0, top: 0, display: 'none', willChange: 'transform' }}
          className="z-[46] w-max max-w-[14rem] bg-neutral-800/95 backdrop-blur-sm rounded-lg shadow-lg
                     border border-neutral-700/50 text-[11px] text-neutral-300 select-none"
        >
          <div className="flex items-center gap-2 px-2 py-1 border-b border-neutral-700/50">
            <span className="flex-1 truncate text-neutral-200 font-medium">
              {kindLabel(m.kind)}
            </span>
            <button
              type="button"
              onClick={() => { navigator.clipboard.writeText(measurementToText(m)); flashCopied(m.id); }}
              title="Copy this measurement"
              data-testid="measure-copy"
              className="p-0.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200"
            >
              <Copy className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => onDismiss(m.id)}
              title="Delete this measurement"
              data-testid="measure-dismiss"
              className="p-0.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200"
            >
              <X className="w-3 h-3" />
            </button>
          </div>

          <div className="px-2 py-1.5">
            <MeasureBody m={m} />
          </div>

          {copiedId === m.id && <div className="px-2 pb-1 text-[10px] text-lime-400">Copied</div>}
        </div>
      ))}
    </>
  );
}
