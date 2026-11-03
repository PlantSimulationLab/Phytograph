import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { onRenderActivity } from '../../../lib/renderActivity';
import { potreeIsStreaming } from '../potreeManager';

// How long after the last activity the loop keeps running flat out. Long enough
// for OrbitControls' damping to settle after the user lets go.
export const IDLE_AFTER_MS = 2000;
// The loop's rate once idle.
export const IDLE_TICK_MS = 1000;

// Slows the render loop when nothing is happening.
//
// Left alone the viewer redraws up to the whole point budget (2 M points) at the
// display's refresh rate with the camera still, plus potree's traversal and each
// cloud's per-frame sync, which is GPU and battery spent on an identical image.
//
// Not plain `frameloop="demand"`, deliberately. That needs every scene change to
// call invalidate(), and this viewer changes the scene imperatively in hundreds
// of places (uniforms, masks, tile visibility), so any one that was missed would
// leave a silently stale picture. Here the fast loop is the default, and the
// governor only leaves it after IDLE_AFTER_MS with no input, no fetch, no React
// render and no tiles streaming. It then ticks at 1 Hz rather than stopping, so
// a change nothing reported still appears within a second.
//
// Waking needs nothing but setFrameloop('always'); R3F's Canvas also resets it on
// each of its own renders, since it passes the default on every configure.
export function IdleFrameGovernor({ animating }: { animating: boolean }) {
  const setFrameloop = useThree((s) => s.setFrameloop);
  const invalidate = useThree((s) => s.invalidate);
  const lastActivity = useRef(performance.now());
  const idle = useRef(false);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const animatingRef = useRef(animating);
  animatingRef.current = animating;

  const wakeRef = useRef(() => {});
  wakeRef.current = () => {
    lastActivity.current = performance.now();
    if (!idle.current) return;
    idle.current = false;
    if (tick.current !== null) clearInterval(tick.current);
    tick.current = null;
    setFrameloop('always');
  };

  // No dependency list on purpose: the parent viewer re-rendering IS activity.
  useEffect(() => { wakeRef.current(); });

  useEffect(() => {
    const wake = () => wakeRef.current();
    const events = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup', 'focus', 'resize'];
    for (const name of events) window.addEventListener(name, wake, { capture: true, passive: true });
    const stopActivity = onRenderActivity(wake);
    return () => {
      for (const name of events) window.removeEventListener(name, wake, { capture: true });
      stopActivity();
      if (tick.current !== null) clearInterval(tick.current);
      tick.current = null;
      setFrameloop('always');
    };
  }, [setFrameloop]);

  useFrame(() => {
    const g = globalThis as { __renderFrames?: number; __renderIdle?: boolean };
    g.__renderFrames = (g.__renderFrames ?? 0) + 1;
    g.__renderIdle = idle.current;
    if (animatingRef.current || potreeIsStreaming()) {
      wakeRef.current();
      return;
    }
    if (idle.current || performance.now() - lastActivity.current < IDLE_AFTER_MS) return;
    idle.current = true;
    setFrameloop('demand');
    tick.current = setInterval(() => invalidate(), IDLE_TICK_MS);
  });

  return null;
}
