import { describe, expect, it } from 'vitest';
import { meshVertexOffset, rebaseVec3s, shiftToStored } from './meshFrame';

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
