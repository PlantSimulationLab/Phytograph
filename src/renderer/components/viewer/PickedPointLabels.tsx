import { useRef, useState, useCallback, type MutableRefObject } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { X, Copy } from 'lucide-react';
import {
  formatCoord,
  labelOffsetFor,
  pickedPointToText,
  type PickedPoint,
} from '../../lib/pointPick';
import type { Vec3Like } from '../../lib/pointCloudHelpers';

// Floating labels for picked points (the CloudCompare-style bubbles).
//
// Split in two because the camera lives inside the R3F canvas and the bubbles
// are DOM:
//
//   * <PickedPointProjector> mounts INSIDE <Canvas> and, every frame, projects
//     each label's anchor to canvas pixels and writes the result straight into
//     the DOM through a shared element registry. No React state is touched, so
//     orbiting a scene with a dozen labels costs a handful of style writes per
//     frame rather than a dozen re-renders.
//   * <PickedPointLabels> mounts as a DOM SIBLING of <Canvas> and owns the
//     markup: an SVG layer for the anchor dots + leader lines, and one
//     absolutely positioned bubble per label.
//
// The two are wired together by a registry created with usePickedPointOverlay()
// and passed to both. This mirrors the manual-projection pattern already used
// for the trajectory insert button and the tree-seed overlay — the project has
// no drei <Html> / CSS2DRenderer anywhere and this doesn't introduce one.

export interface PickedPointOverlayRegistry {
  bubbles: Map<string, HTMLElement>;
  lines: Map<string, SVGLineElement>;
  dots: Map<string, SVGCircleElement>;
}

export function usePickedPointOverlay(): MutableRefObject<PickedPointOverlayRegistry> {
  const ref = useRef<PickedPointOverlayRegistry | null>(null);
  if (!ref.current) {
    ref.current = { bubbles: new Map(), lines: new Map(), dots: new Map() };
  }
  return ref as MutableRefObject<PickedPointOverlayRegistry>;
}

// ── In-canvas projector ────────────────────────────────────────────────────

export function PickedPointProjector({
  points,
  displayOffset,
  registry,
}: {
  points: PickedPoint[];
  // The scene renders at (local − displayOffset) — a cloud's persistent
  // `worldShift` is baked into the stored points and is NOT part of the render
  // frame, so anchors project from `local`, never from `world`. (On an
  // unshifted cloud the two are equal, which is why getting this wrong is
  // invisible until a UTM-scale import.)
  displayOffset: Vec3Like;
  registry: MutableRefObject<PickedPointOverlayRegistry>;
}) {
  const { camera, size } = useThree();
  const v = useRef(new THREE.Vector3()).current;

  useFrame(() => {
    const { bubbles, lines, dots } = registry.current;
    if (bubbles.size === 0 && dots.size === 0) return;

    // Pass 1 — project every anchor and measure every bubble. Batched so the
    // layout reads (offsetWidth/Height) happen before any style writes; mixing
    // them would force a reflow per label, every frame.
    type Placement = {
      p: PickedPoint;
      bubble: HTMLElement | undefined;
      line: SVGLineElement | undefined;
      dot: SVGCircleElement | undefined;
      x: number; y: number;          // anchor, in canvas pixels
      bx: number; by: number;        // bubble's bottom-left corner
      w: number; h: number;
      visible: boolean;
    };
    const items: Placement[] = [];
    for (const p of points) {
      const bubble = bubbles.get(p.id);
      const line = lines.get(p.id);
      const dot = dots.get(p.id);
      if (!bubble && !line && !dot) continue;

      v.set(
        p.local[0] - displayOffset.x,
        p.local[1] - displayOffset.y,
        p.local[2] - displayOffset.z,
      );
      v.project(camera);
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((-v.y + 1) / 2) * size.height;
      // z > 1 means the anchor is behind the camera; projecting it would put
      // the bubble at a mirrored position on screen.
      const visible = v.z <= 1 && isFinite(x) && isFinite(y);
      const { dx, dy } = labelOffsetFor(p.seq);
      items.push({
        p, bubble, line, dot, x, y,
        bx: x + dx, by: y + dy,
        w: bubble?.offsetWidth ?? 0,
        h: bubble?.offsetHeight ?? 0,
        visible,
      });
    }

    // Pass 2 — place each bubble in a free slot near its anchor. Points a few
    // centimetres apart project to bubbles that sit on top of each other, and
    // the top one then swallows the buttons of everything underneath, making
    // the earlier labels impossible to dismiss or read.
    //
    // For each label (in pick order, so the newest is the one that moves) try a
    // small fixed set of slots around the anchor — the default up-right corner
    // first, then the other three quadrants, then one bubble-height further out
    // in each — and take the first that is free. When every slot is blocked,
    // take the least-covered one rather than oscillating: an imperfect position
    // beats a label that jitters or lands off-screen.
    const placed: Array<{ l: number; t: number; r: number; b: number }> = [];
    for (const it of items) {
      if (!it.visible || !it.bubble) continue;

      const step = it.h + LABEL_GAP_PX;
      const outX = it.bx - it.x;            // the seq-staggered base offset
      const outY = it.by - it.y;
      const slots: Array<{ dx: number; dy: number }> = [];
      for (const ring of [0, 1, 2]) {
        for (const right of [true, false]) {
          const dx = right ? outX : -outX - it.w;
          slots.push({ dx, dy: outY - ring * step });          // above the anchor
          if (ring > 0) slots.push({ dx, dy: outY + ring * step + it.h }); // below
        }
      }

      let best: { box: typeof placed[number]; cover: number } | null = null;
      for (const slot of slots) {
        // Clamp into the canvas first, so a slot is scored where it would
        // actually be drawn — an unreachable label is worse than a stacked one.
        const l = Math.min(
          Math.max(it.x + slot.dx, LABEL_MARGIN_PX),
          Math.max(LABEL_MARGIN_PX, size.width - LABEL_MARGIN_PX - it.w),
        );
        const b = Math.min(
          Math.max(it.y + slot.dy, LABEL_MARGIN_PX + it.h),
          Math.max(LABEL_MARGIN_PX + it.h, size.height - LABEL_MARGIN_PX),
        );
        const box = { l, t: b - it.h, r: l + it.w, b };
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
      it.by = best.box.b;
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
        // The extra -100% Y puts the bubble's BOTTOM-left corner on the leader
        // line's far end, so the line meets the box instead of crossing it.
        bubble.style.transform = `translate3d(${it.bx}px, ${it.by}px, 0) translateY(-100%)`;
      }
    }
  });

  return null;
}

// Vertical breathing room left between two de-overlapped bubbles, and the
// keep-out margin from the canvas edges.
const LABEL_GAP_PX = 4;
const LABEL_MARGIN_PX = 8;

// ── DOM overlay ────────────────────────────────────────────────────────────

// Transient "Copied" acknowledgement, matching the 600 ms flash the viewer's
// other copy-to-clipboard buttons use.
function useCopyFlash(): [string | null, (id: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((id: string) => {
    setCopied(id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 600);
  }, []);
  return [copied, flash];
}

function CoordRow({ axis, world, local, hasShift }: {
  axis: string; world: number; local: number; hasShift: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 tabular-nums">
      <span className="w-3 text-neutral-500">{axis}</span>
      <span className="flex-1 text-right text-neutral-100">{formatCoord(world)}</span>
      {hasShift && <span className="text-right text-neutral-500">({formatCoord(local)})</span>}
    </div>
  );
}

export function PickedPointLabels({
  points,
  registry,
  onDismiss,
}: {
  points: PickedPoint[];
  registry: MutableRefObject<PickedPointOverlayRegistry>;
  onDismiss: (id: string) => void;
}) {
  const [copiedId, flashCopied] = useCopyFlash();

  // Ref callbacks register/unregister each element so the projector can find
  // it. Identity-stable per id so React doesn't re-run them every render.
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

  if (points.length === 0) return null;

  return (
    <>
      {/* Anchor dots + leader lines. An <svg> without explicit width/height
          collapses to its 300x150 intrinsic size regardless of CSS inset-0. */}
      <svg
        className="absolute inset-0 z-[45] pointer-events-none"
        width="100%"
        height="100%"
        data-testid="picked-point-leaders"
      >
        {points.map((p) => (
          <g key={p.id}>
            <line
              ref={lineRef(p.id)}
              stroke="#a3e635"
              strokeWidth={1}
              strokeDasharray="3 2"
              opacity={0.8}
              style={{ display: 'none' }}
            />
            <circle
              ref={dotRef(p.id)}
              r={3.5}
              fill="#a3e635"
              stroke="#1c1917"
              strokeWidth={1}
              style={{ display: 'none' }}
            />
          </g>
        ))}
      </svg>

      {points.map((p) => (
        <div
          key={p.id}
          ref={bubbleRef(p.id)}
          data-testid="picked-point-label"
          data-cloud-id={p.cloudId}
          // Positioned entirely by the projector; starts hidden so a fresh
          // label never flashes at the top-left before the first frame runs.
          style={{ position: 'absolute', left: 0, top: 0, display: 'none', willChange: 'transform' }}
          className="z-[46] w-max max-w-[16rem] bg-neutral-800/95 backdrop-blur-sm rounded-lg shadow-lg
                     border border-neutral-700/50 text-[11px] text-neutral-300 select-none"
        >
          <div className="flex items-center gap-2 px-2 py-1 border-b border-neutral-700/50">
            <span
              className="flex-1 truncate text-neutral-200 font-medium"
              title={p.cloudLabel}
              data-testid="picked-point-scan"
            >
              {p.cloudLabel}
            </span>
            <button
              type="button"
              onClick={() => { navigator.clipboard.writeText(pickedPointToText(p)); flashCopied(p.id); }}
              title="Copy this point"
              data-testid="picked-point-copy"
              className="p-0.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200"
            >
              <Copy className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => onDismiss(p.id)}
              title="Dismiss this label"
              data-testid="picked-point-dismiss"
              className="p-0.5 rounded hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200"
            >
              <X className="w-3 h-3" />
            </button>
          </div>

          <div className="px-2 py-1 space-y-0.5" data-testid="picked-point-coords">
            {p.hasShift && (
              <div className="flex items-baseline gap-2 text-[9px] uppercase tracking-wide text-neutral-500">
                <span className="w-3" />
                <span className="flex-1 text-right">world</span>
                <span className="text-right">(local)</span>
              </div>
            )}
            <CoordRow axis="X" world={p.world[0]} local={p.local[0]} hasShift={p.hasShift} />
            <CoordRow axis="Y" world={p.world[1]} local={p.local[1]} hasShift={p.hasShift} />
            <CoordRow axis="Z" world={p.world[2]} local={p.local[2]} hasShift={p.hasShift} />
          </div>

          {(p.attributes.length > 0 || p.sourceIndex !== undefined) && (
            <div
              className="px-2 py-1 border-t border-neutral-700/50 space-y-0.5"
              data-testid="picked-point-attributes"
            >
              {p.sourceIndex !== undefined && (
                <div
                  className="flex items-baseline gap-3 tabular-nums"
                  data-testid="picked-point-attribute"
                  data-slug="index"
                >
                  <span className="flex-1 truncate text-neutral-500">index</span>
                  <span className="text-neutral-100">{p.sourceIndex}</span>
                </div>
              )}
              {p.attributes.map((a) => (
                <div
                  key={a.slug}
                  className="flex items-baseline gap-3 tabular-nums"
                  data-testid="picked-point-attribute"
                  data-slug={a.slug}
                >
                  <span className="flex-1 truncate text-neutral-500" title={a.label}>{a.label}</span>
                  <span className="text-neutral-100">{a.display}</span>
                </div>
              ))}
            </div>
          )}

          {copiedId === p.id && <div className="px-2 pb-1 text-[10px] text-lime-400">Copied</div>}
        </div>
      ))}
    </>
  );
}
