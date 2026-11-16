import { describe, expect, it } from 'vitest';
import { meshRenderShift, meshVertexOffset, nearbyOrigin, rebaseVec3s, shiftToStored, vec3sRelativeTo } from './meshFrame';

const WS: [number, number, number] = [512_345, 4_271_234, 87];

describe('meshFrame', () => {
  it('a mesh without an offset is world-frame (legacy convention)', () => {
    expect(meshVertexOffset({})).toEqual([0, 0, 0]);
    expect(shiftToStored({}, WS)).toEqual(WS);
  });

  it('a mesh in the cloud\'s stored frame needs no shift', () => {
    expect(shiftToStored({ vertexOffset: WS }, WS)).toEqual([0, 0, 0]);
  });

  it('rebase is an exact pass-through when the frames agree', () => {
    const v = new Float32Array([1.234567, 2.5, -3.75]);
    expect(rebaseVec3s(v, WS, WS)).toBe(v);
  });

  describe('meshRenderShift (what the viewer subtracts to draw a mesh on its cloud)', () => {
    it('draws a mesh kept in its cloud\'s stored frame with no shift', () => {
      // An Open3D triangulation of a shifted cloud: subtracting the cloud's
      // shift again would throw the mesh `worldShift` away from the cloud.
      expect(meshRenderShift({ method: 'ball_pivoting', vertexOffset: WS }, WS)).toEqual([0, 0, 0]);
    });

    it('subtracts the whole shift from a legacy world-frame mesh', () => {
      expect(meshRenderShift({ method: 'crown' }, WS)).toEqual(WS);
    });

    it('subtracts only what separates two frames', () => {
      const other: [number, number, number] = [WS[0] + 10, WS[1] - 5, WS[2]];
      expect(meshRenderShift({ vertexOffset: other }, WS)).toEqual([-10, 5, 0]);
    });

    it('leaves a mesh with no source cloud in its own frame', () => {
      // A Helios mesh of several scans has sourceCloudId 'helios'.
      expect(meshRenderShift({ method: 'helios', vertexOffset: WS }, undefined)).toEqual([0, 0, 0]);
      expect(meshRenderShift({ method: 'helios' }, undefined)).toEqual([0, 0, 0]);
    });

    it('never shifts a DEM, which is built in the stored frame', () => {
      expect(meshRenderShift({ method: 'dem' }, WS)).toEqual([0, 0, 0]);
    });
  });

  describe('vec3sRelativeTo (float64 world coordinates into a float32 buffer)', () => {
    it('keeps sub-millimetre detail that a float32 world buffer snaps to 0.5 m', () => {
      // Two crown vertices 3 cm apart at a UTM northing.
      const world = [WS[0] + 0.123, WS[1] + 0.456, WS[2] + 1.0, WS[0] + 0.123, WS[1] + 0.486, WS[2] + 1.0];
      const local = vec3sRelativeTo(world, WS);
      expect(local[1]).toBeCloseTo(0.456, 5);
      expect(local[4] - local[1]).toBeCloseTo(0.03, 5);
      // What Float32Array.from(world) did: both vertices land on one lattice point.
      const snapped = Float32Array.from(world);
      expect(snapped[4] - snapped[1]).toBe(0);
    });

    it('is a plain cast at a zero origin', () => {
      expect(Array.from(vec3sRelativeTo([1.5, -2, 3], [0, 0, 0]))).toEqual([1.5, -2, 3]);
    });
  });

  describe('nearbyOrigin', () => {
    it('is whole metres near a georeferenced point', () => {
      expect(nearbyOrigin([512_345.75, 4_271_234.2, 87.9])).toEqual([512_345, 4_271_234, 87]);
    });

    it('is zero for small coordinates, which float32 already holds to 0.1 mm', () => {
      expect(nearbyOrigin([12.5, -40, 3])).toEqual([0, 0, 0]);
    });
  });

  it('rebase works in double precision', () => {
    // Local vertices relative to the world shift, re-expressed relative to a
    // nearby origin: the offset is huge, the result is small, and it must come
    // out exact -- adding the shift in float32 first would round to 0.5 m.
    const local = new Float32Array([0.123, 4.567, 1.001]);
    const out = rebaseVec3s(local, WS, [WS[0] + 1, WS[1] - 2, WS[2]]);
    expect(out[0]).toBeCloseTo(0.123 - 1, 6);
    expect(out[1]).toBeCloseTo(4.567 + 2, 6);
    expect(out[2]).toBeCloseTo(1.001, 6);
  });
});
