import type { Page } from '@playwright/test';

// One wheel "notch" as Chromium reports it for a conventional mouse.
export const WHEEL_NOTCH = 120;

// Scroll `notches` notches' worth of zoom over the current pointer position,
// batched into as few wheel events as `perEvent` allows (negative = zoom in).
//
// Why batch at all: on the headless Linux CI runner every `page.mouse.wheel`
// costs ~4 s — the input ack waits on a software-GL frame — while locally a
// notch is ~20 ms. A "zoom all the way in" burst of 40 single notches therefore
// ran 2.7-2.9 min against a 3 min test budget and timed out on a slow day
// (scene-origin-camera, zoom-outlier-scene, run 33976046164). OrbitControls'
// dolly is linear in |deltaY| (`_getZoomScale`), so five notches in one event
// travel exactly as far as five events of one notch; what changes is only how
// many times the per-event bookkeeping (zoom-to-cursor's depth probe, the
// min-distance clamp) runs along the way, and every burst that uses this
// helper still sends several events past the point where that matters.
//
// Do NOT use this where the test samples the camera between notches — the
// per-notch trajectory specs in zoom-outlier-scene.spec.ts step one notch at
// a time on purpose, and must keep doing so.
export async function wheelNotches(page: Page, notches: number, perEvent = 5): Promise<void> {
  const dir = notches < 0 ? -1 : 1;
  let left = Math.abs(notches);
  while (left > 0) {
    const n = Math.min(perEvent, left);
    await page.mouse.wheel(0, dir * WHEEL_NOTCH * n);
    left -= n;
  }
}
