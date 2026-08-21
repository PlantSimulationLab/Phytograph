import { expect, type Page } from '@playwright/test';

// Guards for tests that click the 3-D viewport at COMPUTED coordinates.
//
// A raw `page.mouse.click(x, y)` reports nothing about what it hit. If some
// floating DOM is over that pixel the click never reaches the R3F picker, and
// the test fails later at whatever it was waiting on — reading as a picking or
// state bug rather than a missed click. That misdirection has cost real time
// more than once:
//
//   - a toast (`fixed bottom-4 right-4 top-4`, z-110, cards pointer-events-auto)
//     swallowing viewport clicks, which looks like "clicked and nothing was
//     selected";
//   - label-slab aiming a centreline at 0.6/0.7 canvas width and landing on the
//     cross-section panel's own Suspend button — it passed locally by luck and
//     failed only on CI, whose window has no title bar (innerHeight 800 vs 772
//     on macOS), so identical fractions resolve to different pixels;
//   - the legend/colorbar overlay, which grows leftward into the panel lane.
//
// Two rules follow, and these helpers encode both: clear toasts before clicking
// the viewport, and assert the target pixel actually belongs to the canvas.

/**
 * Dismiss every visible toast and wait for them to go.
 *
 * Uses a direct DOM click rather than `locator.click()` on purpose: a toast can
 * auto-expire between locator resolution and the click, and Playwright then
 * retries actionability for its full default timeout (measured: 30 s burned,
 * turning a 4 s spec into 34 s). Firing the DOM event is immediate and is a
 * no-op if the node already went away.
 */
export async function dismissToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('[data-testid="toast-close"]')
      .forEach((b) => b.click());
  });
  await expect(page.getByTestId('toast-close')).toHaveCount(0, { timeout: 15_000 });
}

/** What `document.elementFromPoint` reports at a page coordinate. */
async function topmostAt(page: Page, points: Array<{ x: number; y: number }>) {
  return page.evaluate((pts) => pts.map(({ x, y }) => {
    const el = document.elementFromPoint(Math.round(x), Math.round(y)) as HTMLElement | null;
    if (!el) return { tag: 'null', id: '' };
    return { tag: el.tagName.toLowerCase(), id: el.dataset.testid ?? '' };
  }), points);
}

/**
 * Assert every given page coordinate resolves to the viewer canvas.
 *
 * Call this before driving a click/drag at computed coordinates. On failure the
 * message names the offending element and the geometry, so a CI-only failure is
 * diagnosable from the log alone instead of needing a trace.
 *
 * Points you only MEASURE (projecting a box's corners for a silhouette, say)
 * should NOT go through here — they legitimately fall outside the canvas.
 */
export async function expectPointsHitCanvas(
  page: Page,
  points: Array<{ x: number; y: number }>,
  what = 'viewport click',
): Promise<void> {
  const hits = await topmostAt(page, points);
  const blocked = hits
    .map((hit, i) => (hit.tag === 'canvas'
      ? null
      : `(${Math.round(points[i].x)},${Math.round(points[i].y)}) -> ${hit.id || hit.tag}`))
    .filter(Boolean);

  if (blocked.length === 0) return;

  const geometry = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const r = c?.getBoundingClientRect();
    return {
      canvas: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });

  expect(
    blocked,
    `${what}: these points did not reach the canvas — something is over them. ` +
    `canvas=${JSON.stringify(geometry.canvas)} viewport=${JSON.stringify(geometry.viewport)}. ` +
    `Blocked:`,
  ).toEqual([]);
}

/**
 * Clear toasts, assert the point is on the canvas, then click it.
 *
 * The common case. For a drag, call `dismissToasts` +
 * `expectPointsHitCanvas([start, ...waypoints, end])` once and then drive the
 * mouse yourself.
 */
export async function clickCanvasAt(
  page: Page,
  point: { x: number; y: number },
  what = 'viewport click',
): Promise<void> {
  await dismissToasts(page);
  await expectPointsHitCanvas(page, [point], what);
  await page.mouse.click(point.x, point.y);
}
