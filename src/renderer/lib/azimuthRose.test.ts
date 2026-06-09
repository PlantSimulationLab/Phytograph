import { describe, it, expect } from 'vitest';
import { polarToXY, buildRoseGeometry } from './azimuthRose';

describe('polarToXY screen mapping', () => {
  const cx = 100, cy = 100, r = 50;

  it('places 0° straight up (compass north)', () => {
    const p = polarToXY(0, r, cx, cy);
    expect(p.x).toBeCloseTo(cx, 6);
    expect(p.y).toBeCloseTo(cy - r, 6); // up = smaller y
  });

  it('places 90° to the right (east), 180° down, 270° left', () => {
    expect(polarToXY(90, r, cx, cy).x).toBeCloseTo(cx + r, 6);
    expect(polarToXY(90, r, cx, cy).y).toBeCloseTo(cy, 6);
    expect(polarToXY(180, r, cx, cy).y).toBeCloseTo(cy + r, 6);
    expect(polarToXY(270, r, cx, cy).x).toBeCloseTo(cx - r, 6);
  });

  it('radius 0 maps to the center', () => {
    const p = polarToXY(123, 0, cx, cy);
    expect(p.x).toBeCloseTo(cx, 6);
    expect(p.y).toBeCloseTo(cy, 6);
  });
});

describe('buildRoseGeometry', () => {
  const binCenters = Array.from({ length: 36 }, (_, i) => i * 10 + 5);

  it('produces ringCount rings out to the radius', () => {
    const density = new Array(36).fill(1);
    const g = buildRoseGeometry(density, binCenters, 100, 100, 60, { ringCount: 3 });
    expect(g.rings).toHaveLength(3);
    expect(g.rings[2]).toBeCloseTo(60, 6);
    expect(g.rings[0]).toBeCloseTo(20, 6);
  });

  it('emits 8 compass spokes by default', () => {
    const g = buildRoseGeometry([1], [0], 100, 100, 60);
    expect(g.spokes.map(s => s.label)).toEqual(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
    // The N spoke is straight up.
    expect(g.spokes[0].outer.y).toBeCloseTo(40, 6); // cy - r = 100 - 60
  });

  it('scales the petal radius by density / maxDensity', () => {
    // One bin at full density, rest zero → that bin reaches the outer radius.
    const density = new Array(36).fill(0);
    density[9] = 2; // azimuth 95° (~east) at density 2
    const g = buildRoseGeometry(density, binCenters, 0, 0, 50, { maxDensity: 2 });
    // The path is a closed M…L…Z; the bin-9 vertex should sit at radius 50.
    expect(g.path.startsWith('M')).toBe(true);
    expect(g.path.trimEnd().endsWith('Z')).toBe(true);
    // Reconstruct bin 9's point and check its distance from center ≈ 50.
    const p = polarToXY(binCenters[9], (density[9] / 2) * 50, 0, 0);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(50, 6);
  });

  it('empty density yields an empty (non-Z) path', () => {
    const g = buildRoseGeometry([], [], 0, 0, 50);
    expect(g.path).toBe('');
  });

  it('shared maxDensity makes two cells comparable', () => {
    const big = new Array(36).fill(0); big[0] = 4;
    const small = new Array(36).fill(0); small[0] = 1;
    const gBig = buildRoseGeometry(big, binCenters, 0, 0, 50, { maxDensity: 4 });
    const gSmall = buildRoseGeometry(small, binCenters, 0, 0, 50, { maxDensity: 4 });
    // Bin 0 (azimuth 5°): big reaches full radius, small a quarter.
    const rBig = Math.hypot(...Object.values(polarToXY(5, (4 / 4) * 50, 0, 0)));
    const rSmall = Math.hypot(...Object.values(polarToXY(5, (1 / 4) * 50, 0, 0)));
    expect(rBig).toBeCloseTo(50, 6);
    expect(rSmall).toBeCloseTo(12.5, 6);
    expect(gBig.path).not.toBe(gSmall.path);
  });
});
