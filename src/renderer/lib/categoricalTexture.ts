// Class colors as a texture the point shader can sample WITHOUT blending.
//
// potree-core turns a material's `gradient` stops into a 64-pixel canvas with
// linear filtering, and the INTENSITY_GRADIENT shader samples it at
// t = (v - lo) / span. That is fine for a color ramp and wrong for classes:
// once a column has more than ~64 classes in range, several classes share a
// pixel and LinearFilter averages their colors, so neighboring classes (tree
// 41 and tree 42) draw as one blended color. A large tree segmentation or an
// instance palette hits this immediately.
//
// So for class coloring we build the texture ourselves: wide enough that
// every class's sample point lands in its own texel, NEAREST-filtered so no
// texel is ever averaged with its neighbor, each texel taking the color of
// the class whose sample point is closest (the same midpoint cells
// `buildCategoricalGradientStops` lays out).

import type { CategoricalScheme } from './classification';
import type { RGB } from './colormaps';

/** Texture widths are powers of two from 256 up to the caller's `maxWidth`
 *  (the GPU's MAX_TEXTURE_SIZE; WebGL2 guarantees only 2048, desktop GPUs
 *  report 16384). Past it, classes closer than a texel would share one. */
export const CATEGORICAL_TEXTURE_MIN = 256;
export const CATEGORICAL_TEXTURE_MAX = 16384;

export interface CategoricalTexels {
  width: number;
  /** RGBA8, `width` texels. */
  data: Uint8Array;
}

/**
 * Rasterize `scheme` over `range` into one row of texels.
 *
 * The width is chosen so the closest pair of class sample points is at least
 * two texels apart (then `floor(t * width)` of each lands in its own cell),
 * rounded up to a power of two and clamped to the range above.
 */
export function categoricalTexels(
  scheme: CategoricalScheme, range: [number, number], unknown: RGB,
  maxWidth: number = CATEGORICAL_TEXTURE_MAX,
): CategoricalTexels {
  const [lo, hi] = range;
  const span = hi - lo || 1;
  const pts = [...scheme.classes]
    .map((c) => ({ t: (c.value - lo) / span, color: c.color }))
    .filter((p) => p.t >= -1e-9 && p.t <= 1 + 1e-9)
    .sort((a, b) => a.t - b.t);

  let minGap = 1;
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i].t - pts[i - 1].t;
    if (gap > 0) minGap = Math.min(minGap, gap);
  }
  let width = CATEGORICAL_TEXTURE_MIN;
  const cap = Math.max(CATEGORICAL_TEXTURE_MIN, Math.min(CATEGORICAL_TEXTURE_MAX, maxWidth));
  while (width < cap && width * minGap < 2) width *= 2;

  const data = new Uint8Array(width * 4);
  const put = (i: number, c: RGB) => {
    data[4 * i] = Math.round(Math.max(0, Math.min(1, c[0])) * 255);
    data[4 * i + 1] = Math.round(Math.max(0, Math.min(1, c[1])) * 255);
    data[4 * i + 2] = Math.round(Math.max(0, Math.min(1, c[2])) * 255);
    data[4 * i + 3] = 255;
  };
  if (pts.length === 0) {
    for (let i = 0; i < width; i++) put(i, unknown);
    return { width, data };
  }
  // Walk the texels left to right, advancing to the next class once the texel
  // center passes the midpoint between the two sample points.
  let k = 0;
  for (let i = 0; i < width; i++) {
    const tc = (i + 0.5) / width;
    while (k < pts.length - 1 && tc > (pts[k].t + pts[k + 1].t) / 2) k++;
    put(i, pts[k].color);
  }
  // Each class owns the texel its sample point falls in, even when two sample
  // points are closer than the midpoint rule can separate at this width.
  for (const p of pts) put(Math.min(width - 1, Math.max(0, Math.floor(p.t * width))), p.color);
  return { width, data };
}
