import { describe, it, expect } from 'vitest';
import { worldPerPixel } from './screenScale';

const PERSP = { isPerspectiveCamera: true, fov: 60 };
const ORTHO = { isPerspectiveCamera: false, top: 5, bottom: -5, zoom: 1 };
const ORIGIN = { x: 0, y: 0, z: 0 };

describe('worldPerPixel — perspective', () => {
  it('spans the full frustum height across the viewport', () => {
    // At distance d with a 60° vertical FOV the visible height is
    // 2·tan(30°)·d; one pixel is that divided by the pixel height.
    const d = 10;
    const s = worldPerPixel(PERSP, ORIGIN, 500, { x: 0, y: 0, z: d });
    expect(s * 500).toBeCloseTo(2 * Math.tan(Math.PI / 6) * d, 6);
  });

  it('grows linearly with distance (a marker keeps its pixel size as you zoom out)', () => {
    const near = worldPerPixel(PERSP, ORIGIN, 500, { x: 0, y: 0, z: 4 });
    const far = worldPerPixel(PERSP, ORIGIN, 500, { x: 0, y: 0, z: 12 });
    expect(far / near).toBeCloseTo(3, 6);
  });

  it('uses the true 3D distance, not just the depth axis', () => {
    const axis = worldPerPixel(PERSP, ORIGIN, 500, { x: 0, y: 0, z: 5 });
    const diag = worldPerPixel(PERSP, ORIGIN, 500, { x: 3, y: 0, z: 4 }); // |d| = 5
    expect(diag).toBeCloseTo(axis, 12);
  });

  it('shrinks as the viewport gets taller (same world span, more pixels)', () => {
    const short = worldPerPixel(PERSP, ORIGIN, 250, { x: 0, y: 0, z: 10 });
    const tall = worldPerPixel(PERSP, ORIGIN, 1000, { x: 0, y: 0, z: 10 });
    expect(short / tall).toBeCloseTo(4, 6);
  });

  it('is zero at the camera position (nothing to scale to)', () => {
    expect(worldPerPixel(PERSP, ORIGIN, 500, ORIGIN)).toBe(0);
  });
});

describe('worldPerPixel — orthographic', () => {
  it('ignores distance and divides the frustum height by the pixel height', () => {
    const s = worldPerPixel(ORTHO, ORIGIN, 500, { x: 0, y: 0, z: 1000 });
    expect(s).toBeCloseTo(10 / 500, 12);
    expect(worldPerPixel(ORTHO, ORIGIN, 500, { x: 0, y: 0, z: 1 })).toBeCloseTo(s, 12);
  });

  it('scales inversely with zoom', () => {
    const zoomed = worldPerPixel({ ...ORTHO, zoom: 4 }, ORIGIN, 500, ORIGIN);
    expect(zoomed).toBeCloseTo(10 / 4 / 500, 12);
  });
});

describe('worldPerPixel — degenerate inputs return 0 rather than NaN/Infinity', () => {
  it('rejects a zero-height viewport', () => {
    expect(worldPerPixel(PERSP, ORIGIN, 0, { x: 0, y: 0, z: 5 })).toBe(0);
    expect(worldPerPixel(ORTHO, ORIGIN, 0, ORIGIN)).toBe(0);
  });

  it('rejects a non-finite viewport height', () => {
    expect(worldPerPixel(PERSP, ORIGIN, NaN, { x: 0, y: 0, z: 5 })).toBe(0);
  });

  it('rejects a degenerate perspective FOV', () => {
    expect(worldPerPixel({ isPerspectiveCamera: true, fov: 0 }, ORIGIN, 500, { x: 0, y: 0, z: 5 })).toBe(0);
    expect(worldPerPixel({ isPerspectiveCamera: true, fov: 180 }, ORIGIN, 500, { x: 0, y: 0, z: 5 })).toBe(0);
  });

  it('rejects a non-finite point', () => {
    expect(worldPerPixel(PERSP, ORIGIN, 500, { x: NaN, y: 0, z: 5 })).toBe(0);
  });

  it('rejects a collapsed or zero-zoom ortho frustum', () => {
    expect(worldPerPixel({ ...ORTHO, top: 0, bottom: 0 }, ORIGIN, 500, ORIGIN)).toBe(0);
    expect(worldPerPixel({ ...ORTHO, zoom: 0 }, ORIGIN, 500, ORIGIN)).toBe(0);
  });
});
