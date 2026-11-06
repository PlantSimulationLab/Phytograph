// Named colormaps for scalar visualization.
//
// Two kinds:
//   - GRADIENT maps (viridis … grayscale) are evenly-spaced RGB stops in
//     [0,1]^3, stretched over the mapped [min,max]; sampleColormap linearly
//     interpolates between stops.
//   - DISCRETE (label) maps (tab20, glasbey, golden) are for integer label
//     columns — instance ids, segment ids — where a gradient makes neighboring
//     labels nearly the same color. They color by VALUE, cycling: label v gets
//     palette[round(v) mod K], so v and v+1 always differ however many labels
//     there are, and the range sliders don't change any label's color.
//
// Render paths color through `colormapColorForValue(…Into)`, the one function
// that knows the difference; `sampleColormap(name, t)` remains for callers
// that only have a normalized t (previews), where a discrete map draws K flat
// steps.

export type RGB = [number, number, number];

export type ColormapName =
  | 'viridis'
  | 'plasma'
  | 'inferno'
  | 'magma'
  | 'turbo'
  | 'jet'
  | 'grayscale'
  | 'coolwarm'
  | 'tab20'
  | 'glasbey'
  | 'golden';

export const COLORMAP_NAMES: ColormapName[] = [
  'viridis',
  'plasma',
  'inferno',
  'magma',
  'turbo',
  'jet',
  'coolwarm',
  'grayscale',
  'tab20',
  'glasbey',
  'golden',
];

export const COLORMAP_LABELS: Record<ColormapName, string> = {
  viridis: 'Viridis',
  plasma: 'Plasma',
  inferno: 'Inferno',
  magma: 'Magma',
  turbo: 'Turbo',
  jet: 'Jet',
  coolwarm: 'Cool-Warm',
  grayscale: 'Grayscale',
  tab20: 'Tab20 (labels)',
  glasbey: 'Glasbey (labels)',
  golden: 'Golden-angle (labels)',
};

export type DiscreteColormapName = 'tab20' | 'glasbey' | 'golden';

const DISCRETE_NAMES: ReadonlySet<ColormapName> = new Set<ColormapName>(['tab20', 'glasbey', 'golden']);

// True for the label maps, which color by value (cycling) instead of
// stretching a gradient over [min,max].
export function isDiscreteColormap(name: ColormapName): name is DiscreteColormapName {
  return DISCRETE_NAMES.has(name);
}

// Picker groups, rendered as <optgroup>s so the label maps are visibly a
// different kind of thing from the gradients.
export const COLORMAP_GROUPS: ReadonlyArray<{ label: string; names: ColormapName[] }> = [
  { label: 'Gradients', names: COLORMAP_NAMES.filter((n) => !DISCRETE_NAMES.has(n)) },
  { label: 'Labels (discrete)', names: COLORMAP_NAMES.filter((n) => DISCRETE_NAMES.has(n)) },
];

const hexToRgb = (h: string): RGB => [
  parseInt(h.slice(0, 2), 16) / 255,
  parseInt(h.slice(2, 4), 16) / 255,
  parseInt(h.slice(4, 6), 16) / 255,
];

// matplotlib's tab20 (Vega category20): ten hues, each as a dark/light pair.
const TAB20: RGB[] = [
  '1f77b4', 'aec7e8', 'ff7f0e', 'ffbb78', '2ca02c', '98df8a', 'd62728', 'ff9896',
  '9467bd', 'c5b0d5', '8c564b', 'c49c94', 'e377c2', 'f7b6d2', '7f7f7f', 'c7c7c7',
  'bcbd22', 'dbdb8d', '17becf', '9edae5',
].map(hexToRgb);

// colorcet `glasbey` (glasbey_bw_minc_20): 256 maximally distinct colors,
// chosen to stay visible on both black and white backgrounds.
// colorcet 3.1.0, (c) Holoviz, CC-BY 4.0 — https://colorcet.holoviz.org
const GLASBEY: RGB[] = [
  'd70000', '8c3cff', '028800', '00acc7', '98ff00', 'ff7fd1', '6c004f', 'ffa530',
  '583b00', '005759', '0000dd', '00fdcf', 'a1756a', 'bcb7ff', '95b578', 'c004b9',
  '645474', '790000', '0774d8', 'fef590', '004b00', '8f7a00', 'ff7266', 'eeb9b9',
  '5e7e66', '9be4ff', 'ec0077', 'a67bb9', '5a00a4', '04c600', '9e4b00', '9c3b50',
  'cbc400', '718298', '00af8a', '8388ff', '5d373b', '390000', 'fdc0ff', 'bee7c0',
  'db6d01', '93b8b6', 'e452ff', '2f5382', 'c46690', '556220', 'c59f72', '048287',
  '69e780', '802790', '6db4ff', '4e33ff', '86a302', 'fe03cb', 'c2a6c5', 'c55746',
  '76583d', '016842', '00d6d5', 'dae0ff', 'f9ff00', '6a68b0', 'c39800', 'e1cd9c',
  'da96ff', 'bb03fd', '925282', 'a00073', '579b55', 'd38c8f', '374527', '97a5c3',
  '8e8d5f', 'ff4600', 'c8fffa', 'ae6dff', '6ed0a7', 'bfff8c', '8c54b1', '783619',
  'ffa079', 'a9001f', 'ff1c45', '5f1123', '679794', 'ff5f94', '4c6774', '5392cc',
  'aa7131', '02cffe', '00c46c', '61355d', '90d42f', 'bfd57c', '5145a2', '4e230c',
  '7c5a00', 'ffce44', '8302cf', '4dfdff', '89003d', '7b525c', '00749d', 'aa8398',
  '81718f', '6265fe', 'c33489', 'cd2947', 'ff9ab5', 'c35dbb', '216802', '008e65',
  '638023', '8987bf', '98ddd5', 'ce7f58', 'd2b75b', '61006e', '995444', 'b0c7db',
  'f2ffd2', '00ec02', 'cd86bd', '4500c5', '7a9d7f', '727147', '93ffba', '0054c1',
  'ad94ec', '3fa416', '5f3a80', '004c33', '7cb8d3', '982a00', '396e64', 'b8005b',
  'ff803d', 'ffd2e9', '80305a', '213400', 'a15e6f', '4fb5b0', '9f9f46', '337c3d',
  'c24100', 'c7e83e', '6c05e8', '76bc50', 'a5c5a9', 'da546e', 'd88f38', 'fb7cff',
  '4b6449', 'd6c3eb', '7a2e36', '4c8fa5', '4688ff', 'a300c4', 'eaa3d5', 'ffbc78',
  '474800', 'a2c7ff', '91a2ea', '4f6993', 'e75eb2', '9f91b0', '58512b', 'b05ed4',
  '866de1', 'c16e72', 'e400e3', 'b9b78b', '392e00', 'e37ea4', 'ad3b30', 'a9bb4c',
  '69b583', '94d290', 'b08d46', '075f78', '009889', '5a0f02', '5b7d80', '305826',
  'e5653b', '5f4029', '734abc', '4b536b', 'c97add', '9c3291', 'c8e6f2', '05abeb',
  'a76b9a', 'e7b000', '60ff63', 'f2de00', '774401', '602541', '687fcb', '799fb0',
  '0de9a2', '9df8db', '840076', '8e6d49', 'e34130', 'b9496c', '7a4a86', 'ffd0b6',
  '4c5dc7', 'e2b392', 'ff4cee', 'd6f0a5', 'bf6026', 'd7a3b5', 'bd7d00', '886fb2',
  'ff30a1', 'ffe9b0', '33584c', 'b88c7a', '6c8752', 'bc94d2', '1be6fe', 'a13c72',
  'a351a8', '6d0098', '89657b', '5a588b', 'f98f8b', 'e7d77c', '706c01', '1959ff',
  '1726ff', '00d856', 'f8a1fd', '7a963c', 'b1a7d5', '7ed0dd', '00cbb0', '7a473c',
  'daffe6', 'db05b1', 'f3ddff', 'a3e46f', '8a1323', '666883', 'e8fd70', 'd8abe8',
  'e0bad5', 'fe5369', '75ae9b', '9833e0', 'e4737e', '8c5926', '774769', '2f3ea8',
].map(hexToRgb);

function hslToRgb(h: number, s: number, l: number): RGB {
  // h in [0,360), s,l in [0,1]. Standard HSL→sRGB.
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

// Dark gray, deliberately OUTSIDE the golden palette's lightness band (ids are
// saturated hues at L≈0.50–0.62), so id 0 ("unassigned"/ground in a TreeIso
// result) reads as clearly not-an-instance.
const GOLDEN_UNASSIGNED: RGB = [0.22, 0.22, 0.22];
// Golden-angle hue step keeps successive ids far apart on the color wheel.
const GOLDEN_ANGLE_DEG = 137.508;

// The golden-angle instance palette: id ≤ 0 → dark gray; ids 1..N cycle the hue
// wheel by the golden angle, alternating lightness/saturation slightly so even
// hues that wrap around stay distinguishable. Unbounded (never repeats exactly).
// This is THE definition — tree_instance / leaflet_id / generic label schemes
// in classification.ts call it, so the 'golden' colormap matches them exactly.
export function goldenAngleColor(id: number): RGB {
  const i = Math.round(id);
  if (!(i > 0)) return [...GOLDEN_UNASSIGNED] as RGB;
  const hue = ((i - 1) * GOLDEN_ANGLE_DEG) % 360;
  const sat = 0.62 + 0.18 * ((i % 3) / 2);   // 0.62..0.80
  const light = 0.50 + 0.12 * ((i % 2));     // 0.50 or 0.62
  return hslToRgb(hue, sat, light);
}

// Palette table per discrete map; `golden` has none (computed, unbounded).
const DISCRETE_TABLES: Record<Exclude<DiscreteColormapName, 'golden'>, RGB[]> = {
  tab20: TAB20,
  glasbey: GLASBEY,
};

// Number of colors before a discrete map repeats (Infinity for golden).
export function discretePeriod(name: DiscreteColormapName): number {
  return name === 'golden' ? Infinity : DISCRETE_TABLES[name].length;
}

// The color of label `value` under a discrete map: palette[round(v) mod K].
// Negative labels wrap too. A non-finite value takes the first color, matching
// sampleColormap's fallback.
export function discreteColor(name: DiscreteColormapName, value: number): RGB {
  if (name === 'golden') return goldenAngleColor(Number.isFinite(value) ? value : 0);
  const table = DISCRETE_TABLES[name];
  if (!Number.isFinite(value)) return [table[0][0], table[0][1], table[0][2]];
  const K = table.length;
  const c = table[((Math.round(value) % K) + K) % K];
  return [c[0], c[1], c[2]];
}

// THE render-path entry point: the color for raw `value` mapped over [lo,hi].
// A gradient map normalizes and interpolates exactly as before; a discrete map
// ignores [lo,hi] and colors by the value itself.
export function colormapColorForValue(name: ColormapName, value: number, lo: number, hi: number): RGB {
  if (isDiscreteColormap(name)) return discreteColor(name, value);
  return sampleColormap(name, (value - lo) / ((hi - lo) || 1));
}

// Allocation-free twin of colormapColorForValue, for hot per-element loops.
export function colormapColorForValueInto(
  name: ColormapName,
  value: number,
  lo: number,
  hi: number,
  out: Float32Array,
  off: number,
): void {
  if (isDiscreteColormap(name)) {
    const c = discreteColor(name, value);
    out[off] = c[0]; out[off + 1] = c[1]; out[off + 2] = c[2];
    return;
  }
  sampleColormapInto(name, (value - lo) / ((hi - lo) || 1), out, off);
}

// t-only sampling for a discrete map: K flat steps, no interpolation. Golden
// has no period, so a preview shows its first 20 ids (1..20).
const DISCRETE_PREVIEW_STEPS = 20;
function discreteStepColor(name: DiscreteColormapName, t: number): RGB {
  const K = Math.min(discretePeriod(name), DISCRETE_PREVIEW_STEPS);
  const clamped = !isFinite(t) || t <= 0 ? 0 : t >= 1 ? 1 : t;
  const i = Math.min(K - 1, Math.floor(clamped * K));
  return discreteColor(name, name === 'golden' ? i + 1 : i);
}

const STOPS: Record<Exclude<ColormapName, DiscreteColormapName>, RGB[]> = {
  viridis: [
    [0.267, 0.005, 0.329],
    [0.283, 0.157, 0.471],
    [0.244, 0.286, 0.537],
    [0.192, 0.408, 0.557],
    [0.149, 0.510, 0.557],
    [0.122, 0.620, 0.537],
    [0.208, 0.718, 0.475],
    [0.427, 0.804, 0.349],
    [0.706, 0.871, 0.173],
    [0.992, 0.906, 0.145],
  ],
  plasma: [
    [0.051, 0.031, 0.529],
    [0.298, 0.008, 0.631],
    [0.494, 0.012, 0.659],
    [0.663, 0.137, 0.584],
    [0.796, 0.275, 0.475],
    [0.882, 0.392, 0.384],
    [0.945, 0.518, 0.294],
    [0.988, 0.651, 0.212],
    [0.988, 0.808, 0.145],
    [0.941, 0.976, 0.129],
  ],
  inferno: [
    [0.0, 0.0, 0.016],
    [0.106, 0.047, 0.255],
    [0.290, 0.047, 0.420],
    [0.471, 0.110, 0.427],
    [0.647, 0.173, 0.376],
    [0.812, 0.267, 0.275],
    [0.929, 0.412, 0.145],
    [0.984, 0.608, 0.024],
    [0.969, 0.816, 0.235],
    [0.988, 1.0, 0.643],
  ],
  magma: [
    [0.0, 0.0, 0.016],
    [0.094, 0.059, 0.239],
    [0.267, 0.059, 0.463],
    [0.447, 0.122, 0.506],
    [0.620, 0.184, 0.498],
    [0.804, 0.251, 0.443],
    [0.945, 0.376, 0.365],
    [0.992, 0.588, 0.408],
    [0.996, 0.792, 0.553],
    [0.988, 0.992, 0.749],
  ],
  turbo: [
    [0.188, 0.071, 0.235],
    [0.275, 0.282, 0.659],
    [0.275, 0.522, 0.945],
    [0.196, 0.745, 0.937],
    [0.224, 0.890, 0.616],
    [0.557, 0.965, 0.337],
    [0.875, 0.875, 0.196],
    [0.973, 0.580, 0.196],
    [0.812, 0.275, 0.122],
    [0.478, 0.016, 0.008],
  ],
  jet: [
    [0.0, 0.0, 0.5],
    [0.0, 0.0, 0.9],
    [0.0, 0.3, 1.0],
    [0.0, 0.7, 1.0],
    [0.2, 1.0, 0.8],
    [0.5, 1.0, 0.5],
    [0.8, 1.0, 0.2],
    [1.0, 0.7, 0.0],
    [1.0, 0.3, 0.0],
    [0.9, 0.0, 0.0],
    [0.5, 0.0, 0.0],
  ],
  coolwarm: [
    [0.230, 0.299, 0.754],
    [0.355, 0.464, 0.846],
    [0.484, 0.616, 0.916],
    [0.612, 0.737, 0.960],
    [0.731, 0.831, 0.984],
    [0.866, 0.866, 0.866],
    [0.978, 0.804, 0.769],
    [0.949, 0.659, 0.620],
    [0.890, 0.494, 0.464],
    [0.801, 0.310, 0.318],
    [0.706, 0.016, 0.150],
  ],
  grayscale: [
    [0.0, 0.0, 0.0],
    [1.0, 1.0, 1.0],
  ],
};

export function sampleColormap(name: ColormapName, t: number): RGB {
  if (isDiscreteColormap(name)) return discreteStepColor(name, t);
  const stops = (STOPS as Partial<Record<ColormapName, RGB[]>>)[name] ?? STOPS.viridis;
  if (!isFinite(t)) return [stops[0][0], stops[0][1], stops[0][2]];
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const n = stops.length - 1;
  const f = clamped * n;
  const i = Math.min(Math.floor(f), n - 1);
  const u = f - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    a[0] + (b[0] - a[0]) * u,
    a[1] + (b[1] - a[1]) * u,
    a[2] + (b[2] - a[2]) * u,
  ];
}

// Like `sampleColormap` but writes the RGB triplet into `out` at offset `off`,
// avoiding a per-call array allocation. Use this in hot per-element loops
// (e.g. coloring millions of triangles), where the array churn from
// `sampleColormap` floods the GC and can OOM the renderer.
export function sampleColormapInto(
  name: ColormapName,
  t: number,
  out: Float32Array,
  off: number,
): void {
  if (isDiscreteColormap(name)) {
    const c = discreteStepColor(name, t);
    out[off] = c[0]; out[off + 1] = c[1]; out[off + 2] = c[2];
    return;
  }
  const stops = (STOPS as Partial<Record<ColormapName, RGB[]>>)[name] ?? STOPS.viridis;
  if (!isFinite(t)) {
    out[off] = stops[0][0]; out[off + 1] = stops[0][1]; out[off + 2] = stops[0][2];
    return;
  }
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const n = stops.length - 1;
  const f = clamped * n;
  const i = Math.min(Math.floor(f), n - 1);
  const u = f - i;
  const a = stops[i];
  const b = stops[i + 1];
  out[off] = a[0] + (b[0] - a[0]) * u;
  out[off + 1] = a[1] + (b[1] - a[1]) * u;
  out[off + 2] = a[2] + (b[2] - a[2]) * u;
}

// CSS linear-gradient string sampled at evenly-spaced stops. Used by the
// colorbar overlay so the swatch stays in sync with the renderer. A discrete
// map gets HARD stops (each color starts where the previous one ends) over its
// first min(K, 20) colors, so the swatch reads as distinct blocks.
export function colormapToCssGradient(name: ColormapName, samples = 16, direction = 'to top'): string {
  const stops: string[] = [];
  if (isDiscreteColormap(name)) {
    const K = Math.min(discretePeriod(name), DISCRETE_PREVIEW_STEPS);
    for (let i = 0; i < K; i++) {
      const [r, g, b] = discreteColor(name, name === 'golden' ? i + 1 : i);
      const rgb = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
      stops.push(`${rgb} ${((i / K) * 100).toFixed(2)}%`, `${rgb} ${(((i + 1) / K) * 100).toFixed(2)}%`);
    }
    return `linear-gradient(${direction}, ${stops.join(', ')})`;
  }
  for (let i = 0; i < samples; i++) {
    const t = samples === 1 ? 0 : i / (samples - 1);
    const [r, g, b] = sampleColormap(name, t);
    const R = Math.round(r * 255);
    const G = Math.round(g * 255);
    const B = Math.round(b * 255);
    const pct = (t * 100).toFixed(2);
    stops.push(`rgb(${R}, ${G}, ${B}) ${pct}%`);
  }
  return `linear-gradient(${direction}, ${stops.join(', ')})`;
}
