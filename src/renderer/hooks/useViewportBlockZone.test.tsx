import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { useViewportBlockZone } from './useViewportBlockZone';
import type { ScreenPoint } from '../lib/viewportBlockers';

// happy-dom has no layout engine, so geometry is stubbed per element: a viewer
// pane at (0,0) 1000×700 with one blocking panel down its right edge.
const PANE = { left: 0, top: 0, width: 1000, height: 700 };
const PANEL = { left: 700, top: 0, width: 300, height: 700 };

function stub(el: Element, r: { left: number; top: number; width: number; height: number }) {
  (el as HTMLElement).getBoundingClientRect = () => ({
    left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height,
    width: r.width, height: r.height, x: r.left, y: r.top, toJSON: () => ({}),
  }) as DOMRect;
}

interface HarnessProps {
  active: boolean;
  onMove?: (p: ScreenPoint, blocked: boolean) => void;
  onRelease?: (p: ScreenPoint) => void;
  seen: { rects: number; cursor: ScreenPoint | null; blocked: boolean }[];
}

function Harness({ active, onMove, onRelease, seen }: HarnessProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const zone = useViewportBlockZone(active, rootRef, { onMove, onRelease });
  seen.push({ rects: zone.rects.length, cursor: zone.cursor, blocked: zone.blocked });
  return (
    <div ref={el => { if (el) { stub(el, PANE); rootRef.current = el; } }}>
      <div data-testid="panel" style={{ position: 'absolute', zIndex: '30' }} ref={el => { if (el) stub(el, PANEL); }} />
    </div>
  );
}

function move(x: number, y: number) {
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
}

// The hook throttles moves through requestAnimationFrame; drive it explicitly
// instead of waiting on real frames.
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function flushFrames() {
  const queued = frames;
  frames = [];
  act(() => { queued.forEach(cb => cb(0)); });
}

describe('useViewportBlockZone', () => {
  it('reports nothing while inactive, and ignores pointer moves', () => {
    const seen: HarnessProps['seen'] = [];
    const onMove = vi.fn();
    render(<Harness active={false} onMove={onMove} seen={seen} />);

    act(() => move(800, 300));
    flushFrames();

    expect(onMove).not.toHaveBeenCalled();
    expect(seen.at(-1)).toMatchObject({ rects: 0, cursor: null, blocked: false });
  });

  it('measures the blockers as soon as it activates, before any pointer move', async () => {
    const seen: HarnessProps['seen'] = [];
    render(<Harness active seen={seen} />);
    // The zone has to be paintable immediately — a user who hasn't moved the
    // mouse yet still needs to see where they can't draw.
    await waitFor(() => expect(seen.at(-1)?.rects).toBe(1));
    expect(seen.at(-1)?.cursor).toBeNull();
  });

  it('tracks the pointer in pane-local coordinates while it is reachable', async () => {
    const seen: HarnessProps['seen'] = [];
    const onMove = vi.fn();
    render(<Harness active onMove={onMove} seen={seen} />);
    await waitFor(() => expect(seen.at(-1)?.rects).toBe(1));

    act(() => move(300, 200));
    flushFrames();

    expect(onMove).toHaveBeenCalledWith({ x: 300, y: 200 }, false);
    expect(seen.at(-1)).toMatchObject({ cursor: { x: 300, y: 200 }, blocked: false });
  });

  it('flags a pointer on a panel as blocked and clamps the reported point out of it', async () => {
    const seen: HarnessProps['seen'] = [];
    const onMove = vi.fn();
    render(<Harness active onMove={onMove} seen={seen} />);
    await waitFor(() => expect(seen.at(-1)?.rects).toBe(1));

    // Deep inside the panel, nearest its left edge.
    act(() => move(750, 350));
    flushFrames();

    expect(seen.at(-1)?.blocked).toBe(true);
    expect(seen.at(-1)?.cursor).toEqual({ x: 698, y: 350 });
    expect(onMove).toHaveBeenCalledWith({ x: 698, y: 350 }, true);
  });

  it('coalesces a burst of moves into one frame (no per-event re-render storm)', async () => {
    const seen: HarnessProps['seen'] = [];
    const onMove = vi.fn();
    render(<Harness active onMove={onMove} seen={seen} />);
    await waitFor(() => expect(seen.at(-1)?.rects).toBe(1));

    act(() => { move(100, 100); move(200, 150); move(300, 200); });
    flushFrames();

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith({ x: 300, y: 200 }, false); // the latest one
  });

  it('reports a left-button release at the clamped point, even over a panel', async () => {
    const seen: HarnessProps['seen'] = [];
    const onRelease = vi.fn();
    render(<Harness active onRelease={onRelease} seen={seen} />);
    await waitFor(() => expect(seen.at(-1)?.rects).toBe(1));

    // A drag released ON a panel: the overlay never sees this mouseup, which is
    // exactly why the hook listens on the window. The panel is flush with the
    // pane's right edge, so the exit goes LEFT (202px) rather than right (100px
    // but off-screen, where the user would see nothing).
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 900, clientY: 350, button: 0 }));
    });
    expect(onRelease).toHaveBeenCalledWith({ x: 698, y: 350 }, expect.anything());

    // Right-button releases aren't drags — ignored.
    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 300, clientY: 300, button: 2 }));
    });
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('clamps a pointer dragged outside the pane back to its edge', async () => {
    const seen: HarnessProps['seen'] = [];
    render(<Harness active seen={seen} />);
    await waitFor(() => expect(seen.at(-1)?.rects).toBe(1));

    act(() => move(-80, 900));
    flushFrames();

    expect(seen.at(-1)?.cursor).toEqual({ x: 0, y: 700 });
  });

  it('stops listening once the tool is switched off', async () => {
    const seen: HarnessProps['seen'] = [];
    const onMove = vi.fn();
    const { rerender } = render(<Harness active onMove={onMove} seen={seen} />);
    await waitFor(() => expect(seen.at(-1)?.rects).toBe(1));

    rerender(<Harness active={false} onMove={onMove} seen={seen} />);
    act(() => move(300, 200));
    flushFrames();

    expect(onMove).not.toHaveBeenCalled();
    expect(seen.at(-1)).toMatchObject({ rects: 0, cursor: null, blocked: false });
  });
});
