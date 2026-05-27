// Named colormaps for scalar visualization.
// Each map is a list of evenly-spaced RGB stops in [0,1]^3; sampleColormap
// linearly interpolates between stops.

export type RGB = [number, number, number];

export type ColormapName =
  | 'viridis'
  | 'plasma'
  | 'inferno'
  | 'magma'
  | 'turbo'
  | 'jet'
  | 'grayscale'
  | 'coolwarm';

export const COLORMAP_NAMES: ColormapName[] = [
  'viridis',
  'plasma',
  'inferno',
  'magma',
  'turbo',
  'jet',
  'coolwarm',
  'grayscale',
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
};

const STOPS: Record<ColormapName, RGB[]> = {
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
  const stops = STOPS[name] ?? STOPS.viridis;
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

// CSS linear-gradient string sampled at evenly-spaced stops. Used by the
// colorbar overlay so the swatch stays in sync with the renderer.
export function colormapToCssGradient(name: ColormapName, samples = 16, direction = 'to top'): string {
  const stops: string[] = [];
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
