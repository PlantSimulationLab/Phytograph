import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  encodeProjectScene, decodeProjectScene, toDocValue, fromDocValue, rewireOpenedScene, sceneBackendRefs,
  remapInventoryStateKey,
} from './projectDocument';

describe('scene document round trip', () => {
  it('keeps typed arrays, Maps, Sets, NaN and nesting exactly', () => {
    const doc = {
      meshes: [{
        id: 'm1', name: 'crown',
        data: {
          vertices: new Float32Array([1.5, 2.5, 3.5, -1, 0, 1e-7]),
          indices: new Uint32Array([0, 1, 2, 4294967295]),
          organs: new Uint8Array([1, 2, 3]),
          heights: new Float64Array([612345.123456789, Math.PI]),
        },
      }],
      meshPositions: new Map([['m1', { x: 1, y: 2, z: 3 }]]),
      editStates: new Map([['s1', { erasedIndices: new Set([3, 9, 27]), translation: { x: 0, y: 0, z: 0 } }]]),
      odd: { nan: NaN, inf: -Infinity, nil: null, undef: undefined, flag: false, s: 'ok' },
    };
    const back = decodeProjectScene(encodeProjectScene(doc)) as typeof doc;
    const d = back.meshes[0].data;
    expect(d.vertices).toBeInstanceOf(Float32Array);
    expect([...d.vertices]).toEqual([...doc.meshes[0].data.vertices]);
    expect(d.indices).toBeInstanceOf(Uint32Array);
    expect(d.indices[3]).toBe(4294967295);
    expect(d.organs).toBeInstanceOf(Uint8Array);
    expect(d.heights[0]).toBe(612345.123456789);
    expect(back.meshPositions).toBeInstanceOf(Map);
    expect(back.meshPositions.get('m1')).toEqual({ x: 1, y: 2, z: 3 });
    const es = back.editStates.get('s1')!;
    expect(es.erasedIndices).toBeInstanceOf(Set);
    expect([...es.erasedIndices]).toEqual([3, 9, 27]);
    expect(Number.isNaN(back.odd.nan)).toBe(true);
    expect(back.odd.inf).toBe(-Infinity);
    expect(back.odd.nil).toBeNull();
    expect('undef' in back.odd).toBe(false);
    expect(back.odd.flag).toBe(false);
  });

  it('shares nothing with the source arrays and survives unaligned views', () => {
    const big = new Float32Array(10);
    const view = new Float32Array(big.buffer, 4, 3);   // offset view
    view.set([7, 8, 9]);
    const back = decodeProjectScene(encodeProjectScene({ v: view })) as { v: Float32Array };
    expect([...back.v]).toEqual([7, 8, 9]);
    view[0] = 0;
    expect(back.v[0]).toBe(7);
  });

  it('rejects foreign, truncated and newer data', () => {
    expect(() => decodeProjectScene(new TextEncoder().encode('nope nope'))).toThrow(/Not a Phytograph/);
    const ok = encodeProjectScene({ a: new Float32Array(100) });
    expect(() => decodeProjectScene(ok.slice(0, ok.length - 64))).toThrow(/truncated/);
    const buffers: never[] = [];
    const header = new TextEncoder().encode(JSON.stringify({ version: 99, buffers: [], doc: toDocValue({}, buffers) }));
    const bytes = new Uint8Array(8 + header.length);
    bytes.set(new TextEncoder().encode('PSC1'));
    new DataView(bytes.buffer).setUint32(4, header.length, true);
    bytes.set(header, 8);
    expect(() => decodeProjectScene(bytes)).toThrow(/newer/);
  });

  it('a user string that looks like a tag stays a string', () => {
    const buffers: Float32Array[] = [];
    const v = toDocValue({ label: '$buf', note: { $bufx: 1 } }, buffers);
    expect(fromDocValue(v, buffers)).toEqual({ label: '$buf', note: { $bufx: 1 } });
  });
});

describe('rewireOpenedScene', () => {
  it('maps sessions, marks clouds diverged and drops plant links', () => {
    const scene = {
      scans: [
        { id: 'a', data: { octree: { sessionId: 'old1', cacheId: 'c1' } } },
        { id: 'b', data: { octree: { sessionId: 'old2', cacheId: 'c2' } } },
        { id: 'p', data: null },
      ],
      meshes: [{ plantSessionId: 'plant9' }, {}],
    };
    const { scene: out, missing } = rewireOpenedScene(scene, { old1: 'new1' });
    expect(out.scans[0].data!.octree!.sessionId).toBe('new1');
    expect((out.scans[0].data!.octree as { divergedFromSource?: boolean }).divergedFromSource).toBe(true);
    expect(out.scans[1].data!.octree!.sessionId).toBeUndefined();
    expect(missing).toEqual(['b']);
    expect(out.meshes[0].plantSessionId).toBeUndefined();
    expect(scene.scans[0].data!.octree!.sessionId).toBe('old1');   // input untouched
  });

  it('follows octrees the backend rebuilt on open to their new ids', () => {
    const scene = {
      scans: [
        { id: 'a', data: { octree: { sessionId: 's1', cacheId: 'h1', missOctreeCacheId: 'm1' } } },
        { id: 'b', data: { octree: { sessionId: 's2', cacheId: 'h2', missOctreeCacheId: null } } },
      ],
      meshes: [],
    };
    const { scene: out } = rewireOpenedScene(scene, { s1: 'n1', s2: 'n2' }, { h1: 'H1', m1: 'M1' });
    expect(out.scans[0].data!.octree).toMatchObject({ cacheId: 'H1', missOctreeCacheId: 'M1' });
    // An octree the file embedded keeps its id.
    expect(out.scans[1].data!.octree).toMatchObject({ cacheId: 'h2', missOctreeCacheId: null });
  });
});

describe('sceneBackendRefs', () => {
  it('lists each session and octree once', () => {
    const refs = sceneBackendRefs([
      { id: 'a', data: { octree: { sessionId: 's1', cacheId: 'c1', missOctreeCacheId: 'm1' } } },
      { id: 'b', data: { octree: { sessionId: 's1', cacheId: 'c1' } } },
      { id: 'c', data: { octree: null } },
    ]);
    expect(refs).toEqual({ sessionIds: ['s1'], octreeIds: ['c1', 'm1'] });
  });
});

describe('remapInventoryStateKey', () => {
  it('follows a rebuilt octree id and keeps the edit state', () => {
    const key = ['h1', 3, 0, 0, 0.5, 0, 0, 0].join('|');
    expect(remapInventoryStateKey(key, { h1: 'H1' })).toBe(['H1', 3, 0, 0, 0.5, 0, 0, 0].join('|'));
    // An octree the file embedded (not rebuilt) keeps its key.
    expect(remapInventoryStateKey(key, { other: 'X' })).toBe(key);
    // An inventory on a cloud with no octree id.
    expect(remapInventoryStateKey('|0|0|0|0|0|0|0', { h1: 'H1' })).toBe('|0|0|0|0|0|0|0');
  });
});

describe('uncommitted label strokes', () => {
  it('round-trip as the Map-of-Maps the label overlay reads', () => {
    const pending = new Map([['cloud-1', new Map([['manual_class', {
      strokes: [{ strokeId: 's1', region: { kind: 'box', min: [0, 0, 0], max: [1, 1, 1] }, toClass: 2,
        fromClasses: null }],
      dirty: true,
      palette: { slug: 'manual_class', name: 'Manual', classes: [{ value: 2, name: 'Wood', color: '#8b4513' }] },
    }]])]]);
    const back = decodeProjectScene(encodeProjectScene({ viewer: { labelPending: pending } })) as
      { viewer: { labelPending: Map<string, Map<string, { strokes: unknown[]; dirty: boolean }>> } };
    const entry = back.viewer.labelPending.get('cloud-1')!.get('manual_class')!;
    expect(back.viewer.labelPending).toBeInstanceOf(Map);
    expect(entry.dirty).toBe(true);
    expect(entry.strokes).toEqual(pending.get('cloud-1')!.get('manual_class')!.strokes);
  });
});

describe('reopened cloud bounds', () => {
  it('come back as THREE.Vector3, so .clone() works (Duplicate on a flat cloud)', () => {
    const doc = { scans: [{ id: 'flat', data: { bounds: {
      min: new THREE.Vector3(0, 1, 2), max: new THREE.Vector3(3, 4, 5),
      center: new THREE.Vector3(1.5, 2.5, 3.5), size: new THREE.Vector3(3, 3, 3),
    } } }], meshes: [] };
    const back = decodeProjectScene(encodeProjectScene(doc)) as typeof doc;
    const { scene } = rewireOpenedScene(back, {});
    const b = scene.scans[0].data.bounds;
    expect(b.min).toBeInstanceOf(THREE.Vector3);
    expect(b.max.clone().toArray()).toEqual([3, 4, 5]);
    expect(b.size.clone().toArray()).toEqual([3, 3, 3]);
  });
});
