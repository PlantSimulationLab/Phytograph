import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildRasterGeometry,
  buildMultibeamGeometry,
} from './ScanPatternWireframe';

// Read a geometry's position buffer back as [x, y, z] triples.
function verts(g: THREE.BufferGeometry): Array<[number, number, number]> {
  const a = g.getAttribute('position').array as ArrayLike<number>;
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < a.length; i += 3) out.push([a[i], a[i + 1], a[i + 2]]);
  return out;
}

const R = 2;

describe('buildRasterGeometry', () => {
  it('emits an even number of vertices (line-segment pairs) with a bounding sphere', () => {
    const g = buildRasterGeometry(R, { zMin: 0, zMax: 180, aMin: 0, aMax: 360 });
    const n = g.getAttribute('position').count;
    expect(n).toBeGreaterThan(0);
    expect(n % 2).toBe(0);
    expect(g.boundingSphere).not.toBeNull();
  });

  it('places every vertex on the requested radius', () => {
    const g = buildRasterGeometry(R, { zMin: 0, zMax: 180, aMin: 0, aMax: 360 });
    for (const [x, y, z] of verts(g)) {
      expect(Math.hypot(x, y, z)).toBeCloseTo(R, 5);
    }
  });

  it('a full sphere spans the poles (z from +R to -R)', () => {
    const g = buildRasterGeometry(R, { zMin: 0, zMax: 180, aMin: 0, aMax: 360 });
    const zs = verts(g).map(v => v[2]);
    expect(Math.max(...zs)).toBeCloseTo(R, 5); // zenith 0 → +Z pole
    expect(Math.min(...zs)).toBeCloseTo(-R, 5); // zenith 180 → -Z pole
  });

  it('a banded zenith range drops the caps (z bounded by cos of the band)', () => {
    const g = buildRasterGeometry(R, { zMin: 30, zMax: 130, aMin: 0, aMax: 360 });
    const zs = verts(g).map(v => v[2]);
    expect(Math.max(...zs)).toBeCloseTo(R * Math.cos((30 * Math.PI) / 180), 5);
    expect(Math.min(...zs)).toBeCloseTo(R * Math.cos((130 * Math.PI) / 180), 5);
  });

  it('a narrow azimuth window keeps points within that wedge', () => {
    // Azimuth [0,90] in the local phi-from-+Y frame → sin,cos both ≥ 0, so x≥0 and y≥0.
    const g = buildRasterGeometry(R, { zMin: 0, zMax: 180, aMin: 0, aMax: 90 });
    for (const [x, y] of verts(g)) {
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it('uses the Helios phi convention: phi from +Y toward +X (matches the scan rays)', () => {
    // A degenerate horizon ring (zenith 90, single azimuth) must land where
    // PyHelios sphere2cart puts it: x = R·sin(phi), y = R·cos(phi). This is the
    // regression guard for the 90°-offset wireframe bug — the old from-+X
    // convention (x = R·cos(phi)) would put phi=0 at +X instead of +Y.
    const atPhi = (phiDeg: number): [number, number, number] => {
      const g = buildMultibeamGeometry(R, { elevations: [0], aMin: phiDeg, aMax: phiDeg });
      // Ring points all share the single azimuth; grab the first non-origin vertex.
      return verts(g).find(([x, y, z]) => Math.hypot(x, y, z) > 1e-6)!;
    };
    expect(atPhi(0)).toEqual([
      expect.closeTo(0, 5), expect.closeTo(R, 5), expect.closeTo(0, 5), // phi 0 → +Y
    ]);
    expect(atPhi(90)).toEqual([
      expect.closeTo(R, 5), expect.closeTo(0, 5), expect.closeTo(0, 5), // phi 90 → +X
    ]);
  });
});

describe('buildMultibeamGeometry', () => {
  it('a single 0° beam is a flat disk (all ring points in the z=0 plane)', () => {
    const g = buildMultibeamGeometry(R, { elevations: [0], aMin: 0, aMax: 360 });
    for (const [, , z] of verts(g)) {
      expect(z).toBeCloseTo(0, 5);
    }
  });

  it('includes the apex (origin) among the spoke vertices', () => {
    const g = buildMultibeamGeometry(R, { elevations: [0], aMin: 0, aMax: 360 });
    const hasOrigin = verts(g).some(
      ([x, y, z]) => Math.hypot(x, y, z) < 1e-9,
    );
    expect(hasOrigin).toBe(true);
  });

  it('places each beam ring at the elevation-derived height', () => {
    const g = buildMultibeamGeometry(R, { elevations: [30, -30], aMin: 0, aMax: 360 });
    // Ring (non-origin) points: zenith = 90 − elevation → z = R·cos(zenith).
    const zUp = R * Math.cos((60 * Math.PI) / 180); // +30° → +0.5R
    const zDn = R * Math.cos((120 * Math.PI) / 180); // −30° → −0.5R
    const zs = verts(g)
      .filter(([x, y, z]) => Math.hypot(x, y, z) > 1e-6)
      .map(v => v[2]);
    expect(Math.max(...zs)).toBeCloseTo(zUp, 5);
    expect(Math.min(...zs)).toBeCloseTo(zDn, 5);
  });

  it('emits one ring + spokes per beam (more beams → more vertices)', () => {
    const one = buildMultibeamGeometry(R, { elevations: [0], aMin: 0, aMax: 360 });
    const four = buildMultibeamGeometry(R, {
      elevations: [10, 5, -5, -10],
      aMin: 0,
      aMax: 360,
    });
    expect(four.getAttribute('position').count).toBeGreaterThan(
      one.getAttribute('position').count,
    );
  });
});
