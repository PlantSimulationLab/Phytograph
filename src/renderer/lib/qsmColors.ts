// QSM appearance: the color modes and the palette/hue math behind them.
//
// This module is deliberately three.js-free so BOTH the viewport renderer
// (components/viewer/renderers/QSM3D) and the OBJ/MTL exporter (lib/qsmExport)
// can share one definition. That sharing is the point: the exporter has to write
// the colors the user is actually looking at, and a second copy of the palette
// here would drift from the viewport the first time someone tweaked a hue --
// exactly how the OBJ ended up shipping no materials at all.
//
// Colors here are plain [r, g, b] triples in 0..1, in **sRGB** — the space a hex
// swatch, a color picker and an MTL `Kd` line are all written in. That matters:
// three.js has color management on, so `new THREE.Color('#b08d57')` does NOT hold
// 0.69,0.55,0.34 — it converts to LINEAR and holds 0.43,0.27,0.10. Writing a
// three.js color's channels straight into `Kd` would therefore export a visibly
// darker, desaturated tree. So the shared values stay sRGB (correct for the MTL),
// and the viewport's wrappers in QSM3D convert to linear on the way into three.js.

export type QSMColorMode = 'rank' | 'shoot' | 'color' | 'texture';

export type Rgb = [number, number, number];

// Rank palette: trunk (0) dark/woody -> outward orders brighten. Index by rank,
// clamped. Each adjacent rank pair must be clearly DISTINGUISHABLE (every
// adjacent pair RGB dist >= 0.42) while staying bright enough for the dark
// viewport background.
export const RANK_COLOR_HEXES = [
  '#b08d57', // rank 0 trunk - neutral wood tan
  '#e8552d', // rank 1 scaffold - red-orange (distinct from trunk)
  '#3e9bff', // rank 2 - blue
  '#2fcf6b', // rank 3 - green
  '#b76bff', // rank 4 - violet
  '#ff5fa8', // rank 5+ - pink
];

/** Parse '#rrggbb' (or '#rgb') into an 0..1 RGB triple. Unparseable -> mid grey. */
export function hexToRgb(hex: string): Rgb {
  const h = hex.trim().replace(/^#/, '');
  const full =
    h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0.5, 0.5, 0.5];
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

/** HSL -> RGB, all channels 0..1. Matches THREE.Color.setHSL. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 1) + 1) % 1;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * 6 * (2 / 3 - tt);
    return p;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}

/**
 * sRGB -> linear-sRGB, per the sRGB transfer function. This is exactly what
 * three.js's color management applies when it parses a hex string, so a value
 * pushed through here reproduces `new THREE.Color(hex)` channel-for-channel.
 */
export function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

export function rankColorRgb(rank: number): Rgb {
  const idx = Math.min(Math.max(rank, 0), RANK_COLOR_HEXES.length - 1);
  return hexToRgb(RANK_COLOR_HEXES[idx]);
}

// Deterministic distinct color per shoot id via the golden-ratio hue rotation
// (so adjacent shoot ids look clearly different, and the same id always maps to
// the same color across renders). At equal HSL lightness, reds (~0deg) and blues
// (~0.66) look much darker than yellows/greens, so we add lightness back for
// those hues so no shoot color comes out dark/muddy.
export function shootColorRgb(shootId: number): Rgb {
  const hue = (shootId * 0.61803398875) % 1.0;
  const redLift = Math.cos(hue * 2 * Math.PI) * 0.5 + 0.5; // 1 at red, 0 at cyan
  const blueLift = Math.cos((hue - 0.66) * 2 * Math.PI) * 0.5 + 0.5; // 1 at blue
  const lightness = 0.54 + 0.06 * Math.max(redLift, blueLift); // 0.54..0.60
  return hslToRgb(hue, 0.7, lightness);
}

/**
 * linear-sRGB -> sRGB, the inverse of `srgbToLinear`.
 */
export function linearToSrgb(c: number): number {
  return c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055;
}

/**
 * The rank palette as three.js holds it (linear working space), for the viewport.
 * `new THREE.Color(hex)` converts sRGB -> linear, so this reproduces exactly what
 * the renderer showed before the palette moved into this module.
 */
export function rankColorLinear(rank: number): Rgb {
  const [r, g, b] = rankColorRgb(rank);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/**
 * The shoot hue as an MTL `Kd` wants it (sRGB).
 *
 * Measured, not assumed: `THREE.Color.setHSL` stores the HSL conversion's output
 * VERBATIM — unlike the hex parser, it applies no color-space conversion (probed
 * against three.js: setHSL(0.3,0.7,0.55) holds 0.361/0.865/0.235, exactly
 * `hslToRgb`'s output). So the viewport's shoot colors sit in three.js's LINEAR
 * working space, and the sRGB value an MTL needs is the inverse transfer applied
 * to them. Feeding the raw HSL numbers into `Kd` would export washed-out pastels.
 */
export function shootColorSrgb(shootId: number): Rgb {
  const [r, g, b] = shootColorRgb(shootId);
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}
