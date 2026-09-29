import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

const pickMock = vi.fn();
vi.mock('potree-core', () => ({ Potree: { pick: (...args: unknown[]) => pickMock(...args) } }));

import {
  batchPickNodes,
  nodesOnRay,
  pickAcrossOctrees,
  MAX_PICK_NODES_PER_PASS,
} from './octreeMultiPick';

// Minimal stand-ins: the helper reads only `visibleNodes[].boundingSphere` and
// `matrixWorld` off an octree, and gl's autoClear / render-target / scissor.
function fakeOctree(name: string, nodeCount: number, onRay = true) {
  const center = onRay ? new THREE.Vector3(0, 0, -10) : new THREE.Vector3(100, 0, -10);
  const visibleNodes = Array.from({ length: nodeCount }, (_, i) => ({
    name: `${name}-${i}`,
    boundingSphere: new THREE.Sphere(center.clone(), 1),
  }));
  return { name, visibleNodes, matrixWorld: new THREE.Matrix4() } as any;
}

function fakeGl() {
  return {
    autoClear: true,
    getRenderTarget: vi.fn(() => null),
    setRenderTarget: vi.fn(),
    setScissorTest: vi.fn(),
  } as any;
}

function camera() {
  const c = new THREE.PerspectiveCamera();
  c.position.set(0, 0, 0);
  c.lookAt(0, 0, -1);
  c.updateMatrixWorld();
  return c;
}

const ray = new THREE.Ray(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1));

describe('batchPickNodes', () => {
  it('keeps everything in one batch under the limit', () => {
    const a = fakeOctree('a', 100);
    const b = fakeOctree('b', 100);
    const batches = batchPickNodes([
      { octree: a, nodes: a.visibleNodes },
      { octree: b, nodes: b.visibleNodes },
    ]);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((e) => e.nodes.length)).toEqual([100, 100]);
  });

  it('never puts more than 255 nodes in a batch, splitting one octree if needed', () => {
    const entries = Array.from({ length: 9 }, (_, i) => {
      const o = fakeOctree(`s${i}`, 60);
      return { octree: o, nodes: o.visibleNodes };
    });
    const batches = batchPickNodes(entries);
    for (const b of batches) {
      expect(b.reduce((n, e) => n + e.nodes.length, 0)).toBeLessThanOrEqual(MAX_PICK_NODES_PER_PASS);
    }
    // Every node is picked exactly once.
    const all = batches.flat().flatMap((e) => e.nodes.map((n: any) => n.name));
    expect(all).toHaveLength(540);
    expect(new Set(all).size).toBe(540);
  });

  it('splits a single octree larger than the limit', () => {
    const big = fakeOctree('big', 600);
    const batches = batchPickNodes([{ octree: big, nodes: big.visibleNodes }]);
    expect(batches.map((b) => b[0].nodes.length)).toEqual([255, 255, 90]);
  });
});

describe('nodesOnRay', () => {
  it('keeps only nodes whose bounding sphere the ray crosses', () => {
    const on = fakeOctree('on', 3, true);
    const off = fakeOctree('off', 3, false);
    expect(nodesOnRay(on, ray)).toHaveLength(3);
    expect(nodesOnRay(off, ray)).toHaveLength(0);
  });
});

describe('pickAcrossOctrees', () => {
  beforeEach(() => { pickMock.mockReset(); });

  it('holds autoClear OFF while potree renders, then restores it', () => {
    // The bug: with autoClear on, potree's per-cloud render() clears the pick
    // window, so only the last cloud survived.
    const gl = fakeGl();
    let seen: boolean | undefined;
    pickMock.mockImplementation(() => {
      seen = gl.autoClear;
      return null;
    });
    pickAcrossOctrees([fakeOctree('a', 2), fakeOctree('b', 2)], gl, camera(), ray);
    expect(seen).toBe(false);
    expect(gl.autoClear).toBe(true);
  });

  it('passes every on-ray cloud to ONE pick when under the node limit', () => {
    const a = fakeOctree('a', 2);
    const b = fakeOctree('b', 2);
    const off = fakeOctree('off', 2, false);
    pickMock.mockReturnValue(null);
    pickAcrossOctrees([a, off, b], fakeGl(), camera(), ray);
    expect(pickMock).toHaveBeenCalledTimes(1);
    expect(pickMock.mock.calls[0][0]).toEqual([a, b]);
  });

  it('over the limit, picks per batch and returns the NEAREST hit across batches', () => {
    const clouds = Array.from({ length: 9 }, (_, i) => fakeOctree(`s${i}`, 60));
    const before = clouds.map((c) => c.visibleNodes);
    const depths = [30, 12, 20]; // batch 1 wins
    let call = 0;
    pickMock.mockImplementation((octs: any[]) => {
      const n = octs.reduce((k: number, o: any) => k + o.visibleNodes.length, 0);
      expect(n).toBeLessThanOrEqual(MAX_PICK_NODES_PER_PASS);
      const d = depths[call++];
      return { position: new THREE.Vector3(0, 0, -d), pointCloud: octs[0] };
    });
    const hit = pickAcrossOctrees(clouds, fakeGl(), camera(), ray);
    expect(pickMock).toHaveBeenCalledTimes(3);
    expect(hit?.position?.z).toBeCloseTo(-12);
    // visibleNodes narrowed only for the duration of each pick.
    clouds.forEach((c, i) => expect(c.visibleNodes).toBe(before[i]));
  });

  it('survives a throwing batch and resets the render target and scissor', () => {
    const gl = fakeGl();
    pickMock.mockImplementation(() => { throw new Error('More than 255 nodes'); });
    const hit = pickAcrossOctrees([fakeOctree('a', 2)], gl, camera(), ray);
    expect(hit).toBeNull();
    expect(gl.setScissorTest).toHaveBeenCalledWith(false);
    expect(gl.setRenderTarget).toHaveBeenCalledWith(null);
    expect(gl.autoClear).toBe(true);
  });
});
