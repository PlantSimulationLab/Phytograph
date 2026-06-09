// SVG geometry for the azimuth "rose" (polar) plot in the leaf-angle window.
//
// Pure math only (returns coordinates / path strings) so the React component
// stays a thin renderer and the geometry is unit-tested. The plot is a polar
// histogram: each azimuth bin's area-weighted density becomes a radius, and the
// bins form a closed petal/rose polygon over a concentric grid.
//
// Screen mapping: SVG y grows downward, so we place azimuth 0deg at the TOP and
// increase CLOCKWISE (compass-style), which is how a viewer reads a bearing.
// The data azimuth convention (0deg = +X/east, from the face-normal bearing) is
// preserved as the *value*; this module only decides where on screen it lands.
// A point at azimuth `a` (deg) and radius `r` maps to:
//   screenAngle = a - 90deg  (so 0deg -> straight up), then x = cx + r·cos,
//   y = cy + r·sin — with the -90 offset, 0deg is up and 90deg is to the right.

export interface RosePoint { x: number; y: number }

// Map a polar (azimuthDeg, radius) to SVG coordinates around center (cx, cy).
export function polarToXY(
  azimuthDeg: number,
  radius: number,
  cx: number,
  cy: number,
): RosePoint {
  const a = ((azimuthDeg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
}

export interface RoseGeometry {
  cx: number;
  cy: number;
  rMax: number;
  // Concentric grid ring radii (excludes 0), e.g. [r/3, 2r/3, r].
  rings: number[];
  // Spoke endpoints at the outer ring, one per `spokeCount` (default 8: N, NE,…).
  spokes: { label: string; outer: RosePoint }[];
  // Closed polygon path ("M … L … Z") tracing the per-bin density radii.
  path: string;
}

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Build the rose geometry for one azimuth histogram. `density` is the per-bin
// value (e.g. from computeAzimuthHistogram); `binCenters` their azimuth
// midpoints (deg). `radius` is the outer plotting radius in px; `maxDensity`
// pins the scale (pass the max across all overlaid cells so they're comparable)
// — defaults to this histogram's own max.
export function buildRoseGeometry(
  density: number[],
  binCenters: number[],
  cx: number,
  cy: number,
  radius: number,
  opts: { maxDensity?: number; ringCount?: number; spokeCount?: number } = {},
): RoseGeometry {
  const ringCount = opts.ringCount ?? 3;
  const spokeCount = opts.spokeCount ?? 8;
  const maxDensity = opts.maxDensity ?? Math.max(1e-30, ...density);

  const rings: number[] = [];
  for (let i = 1; i <= ringCount; i++) rings.push((radius * i) / ringCount);

  const spokes = Array.from({ length: spokeCount }, (_, i) => {
    const azimuth = (360 / spokeCount) * i;
    const label = spokeCount === 8 ? COMPASS_8[i] : `${azimuth}°`;
    return { label, outer: polarToXY(azimuth, radius, cx, cy) };
  });

  // Closed petal polygon: each bin center at radius ∝ density.
  let path = '';
  for (let b = 0; b < density.length; b++) {
    const r = (density[b] / maxDensity) * radius;
    const p = polarToXY(binCenters[b], r, cx, cy);
    path += (b === 0 ? 'M' : 'L') + p.x.toFixed(2) + ' ' + p.y.toFixed(2) + ' ';
  }
  if (density.length > 0) path += 'Z';

  return { cx, cy, rMax: radius, rings, spokes, path };
}
