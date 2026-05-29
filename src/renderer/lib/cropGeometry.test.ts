import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  pointInPolygon,
  projectWorldToCanvasPixel,
  worldBoundsUnion,
  polygonRegionFromCamera,
} from './cropGeometry';

describe('pointInPolygon', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('returns true for points strictly inside a convex polygon', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 1, y: 9 }, square)).toBe(true);
  });

  it('returns false for points outside', () => {
    expect(pointInPolygon({ x: -1, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: 11, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: 5, y: 20 }, square)).toBe(false);
  });

  it('handles concave polygons (the classic C shape)', () => {
    const cShape = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 3 },
      { x: 3, y: 3 },
      { x: 3, y: 7 },
      { x: 10, y: 7 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    // Inside the left bar
    expect(pointInPolygon({ x: 1, y: 5 }, cShape)).toBe(true);
    // Inside the carved-out mouth (should be OUTSIDE)
    expect(pointInPolygon({ x: 6, y: 5 }, cShape)).toBe(false);
    // Inside top and bottom bars
    expect(pointInPolygon({ x: 5, y: 1 }, cShape)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 9 }, cShape)).toBe(true);
  });

  it('returns false for degenerate polygons (<3 vertices)', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, [])).toBe(false);
    expect(pointInPolygon({ x: 5, y: 5 }, [{ x: 0, y: 0 }])).toBe(false);
    expect(
      pointInPolygon({ x: 5, y: 5 }, [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toBe(false);
  });
});

describe('projectWorldToCanvasPixel', () => {
  function makeCamera(): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(60, 1, 0.01, 1000);
    cam.up.set(0, 0, 1);
    cam.position.set(0, -10, 0);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    return cam;
  }

  it('maps the world origin to the canvas center for a centered camera', () => {
    const cam = makeCamera();
    const pixel = projectWorldToCanvasPixel(
      { x: 0, y: 0, z: 0 },
      cam.projectionMatrix.toArray(),
      cam.matrixWorldInverse.toArray(),
      { width: 800, height: 600 },
    );
    expect(pixel).not.toBeNull();
    expect(pixel!.x).toBeCloseTo(400, 1);
    expect(pixel!.y).toBeCloseTo(300, 1);
  });

  it('places a point to the right of the camera at x > canvas center', () => {
    const cam = makeCamera();
    const pixel = projectWorldToCanvasPixel(
      { x: 1, y: 0, z: 0 },
      cam.projectionMatrix.toArray(),
      cam.matrixWorldInverse.toArray(),
      { width: 800, height: 600 },
    );
    expect(pixel).not.toBeNull();
    expect(pixel!.x).toBeGreaterThan(400);
  });

  it('returns null for points behind the camera', () => {
    const cam = makeCamera();
    // Camera is at y=-10 looking toward +y. Point at y=-20 is behind it.
    const pixel = projectWorldToCanvasPixel(
      { x: 0, y: -20, z: 0 },
      cam.projectionMatrix.toArray(),
      cam.matrixWorldInverse.toArray(),
      { width: 800, height: 600 },
    );
    expect(pixel).toBeNull();
  });
});

describe('worldBoundsUnion', () => {
  it('returns null for an empty input', () => {
    expect(worldBoundsUnion([])).toBeNull();
  });

  it('expands each cloud by its translation before taking the union', () => {
    const result = worldBoundsUnion([
      {
        bounds: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 1, y: 1, z: 1 },
        },
        translation: { x: 0, y: 0, z: 0 },
      },
      {
        bounds: {
          min: { x: 0, y: 0, z: 0 },
          max: { x: 2, y: 2, z: 2 },
        },
        translation: { x: 10, y: 0, z: 0 },
      },
    ]);
    expect(result).toEqual({
      min: { x: 0, y: 0, z: 0 },
      max: { x: 12, y: 2, z: 2 },
    });
  });
});

describe('polygonRegionFromCamera', () => {
  it('snapshots the camera matrices into a serializable region', () => {
    const cam = new THREE.PerspectiveCamera(60, 1, 0.01, 1000);
    cam.up.set(0, 0, 1);
    cam.position.set(0, -10, 0);
    cam.lookAt(0, 0, 0);
    const region = polygonRegionFromCamera(
      [
        { x: 10, y: 10 },
        { x: 50, y: 10 },
        { x: 30, y: 50 },
      ],
      cam,
      { width: 400, height: 300 },
      false,
    );
    expect(region.mode).toBe('polygon');
    expect(region.points).toHaveLength(3);
    expect(region.projection).toHaveLength(16);
    expect(region.view).toHaveLength(16);
    expect(region.canvasSize).toEqual({ width: 400, height: 300 });
    expect(region.invert).toBe(false);

    // The snapshotted matrices should round-trip: projecting world origin
    // with them should yield the canvas center.
    const pixel = projectWorldToCanvasPixel(
      { x: 0, y: 0, z: 0 },
      region.projection,
      region.view,
      region.canvasSize,
    );
    expect(pixel).not.toBeNull();
    expect(pixel!.x).toBeCloseTo(200, 1);
    expect(pixel!.y).toBeCloseTo(150, 1);
  });
});
