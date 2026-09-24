import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

/** The x/y/z rows of an ASCII point fixture (comment lines skipped). */
export function fixturePoints(path: string): Array<[number, number, number]> {
  return readFileSync(path, 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.trim().split(/\s+/).slice(0, 3).map(Number) as [number, number, number]);
}

/**
 * How many of `points` are DRAWN in `hex`, read from a screenshot at each
 * point's own projected position (`__worldToScreen`), so swatches of the same
 * colour in panels and legends cannot be counted. A point counts when any
 * pixel within 3 px of it is within `tol` (RGB distance) of the colour. Points
 * under an element matching `skip` (e.g. an open panel) are not sampled.
 */
export async function pointsDrawnIn(
  page: Page, points: Array<[number, number, number]>, hex: string,
  tol = 40, skip = '[data-testid="label-panel"]',
): Promise<{ matched: number; sampled: number }> {
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const png = await canvas.screenshot();
  return page.evaluate(async ({ src, box, points, hex, tol, skip }) => {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(); img.src = src; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const sx = c.width / box.width; const sy = c.height / box.height;
    const [er, eg, eb] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const covers = [...document.querySelectorAll(skip)].map((e) => e.getBoundingClientRect());
    let matched = 0; let sampled = 0;
    for (const w of points) {
      const p = (window as any).__worldToScreen(w);
      if (!p.visible) continue;
      if (covers.some((r) => p.x >= r.left - 6 && p.x <= r.right + 6
          && p.y >= r.top - 6 && p.y <= r.bottom + 6)) continue;
      sampled++;
      const cx = Math.round((p.x - box.x) * sx); const cy = Math.round((p.y - box.y) * sy);
      let best = Infinity;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const x = cx + dx; const y = cy + dy;
        if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
        const i = (y * c.width + x) * 4;
        best = Math.min(best, Math.hypot(d[i] - er, d[i + 1] - eg, d[i + 2] - eb));
      }
      if (best <= tol) matched++;
    }
    return { matched, sampled };
  }, { src: `data:image/png;base64,${png.toString('base64')}`, box, points, hex, tol, skip });
}
