import { describe, it, expect, vi } from 'vitest';
import {
  sceneReducer,
  makeInitialSceneState,
  MAX_HISTORY,
  type SceneState,
} from './sceneStore';
import type { HistoryTransaction, SceneAction } from './sceneActions';
import type { CloudEditState, MeshEntry } from '../lib/pointCloudTypes';
import type { Scan } from '../lib/scan';

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeScan(id: string, overrides: Partial<Scan> = {}): Scan {
  return { id, label: id, visible: true, color: '#fff', ...overrides };
}

function makeMesh(id: string, overrides: Partial<MeshEntry> = {}): MeshEntry {
  return {
    id,
    sourceCloudId: 'c1',
    data: {
      vertices: new Float32Array(),
      indices: new Uint32Array(),
      vertexCount: 0,
      triangleCount: 0,
    },
    visible: true,
    color: '#0f0',
    method: 'delaunay' as MeshEntry['method'],
    ...overrides,
  };
}

function editState(indices: number[], translation = { x: 0, y: 0, z: 0 }): CloudEditState {
  return { translation, erasedIndices: new Set(indices) };
}

function tx(label: string, actions: SceneAction[]): HistoryTransaction {
  return { label, actions };
}

// Convenience: apply a sequence of commands.
function run(state: SceneState, ...commands: Parameters<typeof sceneReducer>[1][]): SceneState {
  return commands.reduce((s, c) => sceneReducer(s, c), state);
}

// ── add / remove round-trips ─────────────────────────────────────────────────

describe('add action', () => {
  it('adds an object; undo removes it; redo re-adds with same id', () => {
    const s0 = makeInitialSceneState();
    const scan = makeScan('s1');
    const s1 = run(s0, { c: 'commit', tx: tx('add', [{ t: 'add', kind: 'scan', id: 's1', object: scan }]) });
    expect(s1.scans).toHaveLength(1);
    expect(s1.scans[0].id).toBe('s1');

    const s2 = run(s1, { c: 'undo' });
    expect(s2.scans).toHaveLength(0);
    expect(s2.future).toHaveLength(1);

    const s3 = run(s2, { c: 'redo' });
    expect(s3.scans).toHaveLength(1);
    expect(s3.scans[0].id).toBe('s1');
    expect(s3.future).toHaveLength(0);
  });

  it('seeds a transform alongside an added mesh', () => {
    const s0 = makeInitialSceneState();
    const mesh = makeMesh('m1');
    const transform = { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    const s1 = run(s0, { c: 'commit', tx: tx('add mesh', [{ t: 'add', kind: 'mesh', id: 'm1', object: mesh, transform }]) });
    expect(s1.meshPositions.get('m1')).toEqual({ x: 1, y: 2, z: 3 });

    const s2 = run(s1, { c: 'undo' });
    expect(s2.meshes).toHaveLength(0);
  });
});

describe('index preservation', () => {
  it('undo of a delete re-inserts the object at its original list position', () => {
    const meshes = [makeMesh('a'), makeMesh('b'), makeMesh('c')];
    let s = makeInitialSceneState();
    s = { ...s, meshes };
    // remove the MIDDLE mesh (index 1)
    const removeAction: SceneAction = { t: 'remove', kind: 'mesh', id: 'b', index: 1, object: meshes[1] };
    s = run(s, { c: 'commit', tx: tx('del b', [removeAction]) });
    expect(s.meshes.map((m) => m.id)).toEqual(['a', 'c']);

    s = run(s, { c: 'undo' });
    // 'b' restored between 'a' and 'c', not appended at the end
    expect(s.meshes.map((m) => m.id)).toEqual(['a', 'b', 'c']);

    // redo removes it again at the right spot
    s = run(s, { c: 'redo' });
    expect(s.meshes.map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('a normal add (no index) appends', () => {
    let s = makeInitialSceneState();
    s = { ...s, meshes: [makeMesh('a')] };
    s = run(s, { c: 'commit', tx: tx('add b', [{ t: 'add', kind: 'mesh', id: 'b', object: makeMesh('b') }]) });
    expect(s.meshes.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('remove action', () => {
  it('removes; undo restores object with editState + filters intact', () => {
    const scan = makeScan('s1');
    const es = editState([4, 5, 6], { x: 7, y: 0, z: 0 });
    let s = makeInitialSceneState();
    s = { ...s, scans: [scan], editStates: new Map([['s1', es]]) };

    const removeAction: SceneAction = {
      t: 'remove',
      kind: 'scan',
      id: 's1',
      index: 0,
      object: scan,
      editState: es,
    };
    const s1 = run(s, { c: 'commit', tx: tx('remove', [removeAction]) });
    expect(s1.scans).toHaveLength(0);

    const s2 = run(s1, { c: 'undo' });
    expect(s2.scans).toHaveLength(1);
    expect(s2.scans[0].id).toBe('s1');
    // editState restored AND is a distinct Set (deep-clone guard)
    const restored = s2.editStates.get('s1')!;
    expect([...restored.erasedIndices].sort()).toEqual([4, 5, 6]);
    expect(restored.erasedIndices).not.toBe(es.erasedIndices);
    expect(restored.translation).toEqual({ x: 7, y: 0, z: 0 });
  });
});

// ── transform / property / maskEdit / replaceObject round-trips ──────────────

describe('transform action', () => {
  it('round-trips mesh position/rotation/scale', () => {
    const before = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    const after = { position: { x: 5, y: 6, z: 7 }, rotation: { x: 0.1, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } };
    let s = makeInitialSceneState();
    s = run(s, { c: 'commit', tx: tx('move', [{ t: 'transform', kind: 'mesh', id: 'm1', before, after }]) });
    expect(s.meshPositions.get('m1')).toEqual({ x: 5, y: 6, z: 7 });
    expect(s.meshScales.get('m1')).toEqual({ x: 2, y: 2, z: 2 });

    s = run(s, { c: 'undo' });
    expect(s.meshPositions.get('m1')).toEqual({ x: 0, y: 0, z: 0 });
    expect(s.meshRotations.get('m1')).toEqual({ x: 0, y: 0, z: 0 });

    s = run(s, { c: 'redo' });
    expect(s.meshPositions.get('m1')).toEqual({ x: 5, y: 6, z: 7 });
  });

  it('cloud transform writes translation into editStates', () => {
    let s = makeInitialSceneState();
    const before = { position: { x: 0, y: 0, z: 0 } };
    const after = { position: { x: 3, y: 0, z: 0 } };
    s = run(s, { c: 'commit', tx: tx('cloud move', [{ t: 'transform', kind: 'cloud', id: 'c1', before, after }]) });
    expect(s.editStates.get('c1')!.translation).toEqual({ x: 3, y: 0, z: 0 });
    s = run(s, { c: 'undo' });
    expect(s.editStates.get('c1')!.translation).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('property action', () => {
  it('round-trips each key', () => {
    let s = makeInitialSceneState();
    s = { ...s, meshes: [makeMesh('m1', { color: '#000', name: 'old' })] };

    // color (on entry)
    s = run(s, { c: 'commit', tx: tx('color', [{ t: 'property', kind: 'mesh', id: 'm1', key: 'color', before: '#000', after: '#f00' }]) });
    expect(s.meshes[0].color).toBe('#f00');
    s = run(s, { c: 'undo' });
    expect(s.meshes[0].color).toBe('#000');

    // opacity (side map)
    s = run(s, { c: 'commit', tx: tx('opacity', [{ t: 'property', kind: 'mesh', id: 'm1', key: 'opacity', before: 1, after: 0.5 }]) });
    expect(s.meshOpacities.get('m1')).toBe(0.5);
    s = run(s, { c: 'undo' });
    expect(s.meshOpacities.get('m1')).toBe(1);

    // colorMode (side map)
    s = run(s, { c: 'commit', tx: tx('cm', [{ t: 'property', kind: 'mesh', id: 'm1', key: 'colorMode', before: 'solid', after: 'inclination' }]) });
    expect(s.meshColorModes.get('m1')).toBe('inclination');
    s = run(s, { c: 'undo' });
    expect(s.meshColorModes.get('m1')).toBe('solid');
  });
});

describe('maskEdit action', () => {
  it('round-trips CloudEditState and preserves pendingDeletes order', () => {
    let s = makeInitialSceneState();
    const before = editState([1]);
    const after: CloudEditState = {
      translation: { x: 0, y: 0, z: 0 },
      erasedIndices: new Set([1, 2, 3]),
      pendingDeletes: [
        { kind: 'box', min: [0, 0, 0], max: [1, 1, 1] },
        { kind: 'box', min: [2, 2, 2], max: [3, 3, 3] },
      ],
    };
    s = run(s, { c: 'commit', tx: tx('erase', [{ t: 'maskEdit', id: 'c1', before, after }]) });
    const got = s.editStates.get('c1')!;
    expect([...got.erasedIndices].sort()).toEqual([1, 2, 3]);
    expect(got.pendingDeletes).toHaveLength(2);
    expect((got.pendingDeletes![0] as { min: number[] }).min).toEqual([0, 0, 0]);
    expect((got.pendingDeletes![1] as { min: number[] }).min).toEqual([2, 2, 2]);

    s = run(s, { c: 'undo' });
    expect([...s.editStates.get('c1')!.erasedIndices]).toEqual([1]);
  });
});

describe('replaceObject action', () => {
  it('round-trips a mesh replacement (morph)', () => {
    let s = makeInitialSceneState();
    const before = makeMesh('m1', { name: 'young' });
    const after = makeMesh('m1', { name: 'old' });
    s = { ...s, meshes: [before] };
    s = run(s, { c: 'commit', tx: tx('morph', [{ t: 'replaceObject', kind: 'mesh', id: 'm1', before, after }]) });
    expect(s.meshes[0].name).toBe('old');
    s = run(s, { c: 'undo' });
    expect(s.meshes[0].name).toBe('young');
  });
});

// ── batching ─────────────────────────────────────────────────────────────────

describe('batched transaction', () => {
  it('one transaction with N removes is a single undo', () => {
    const scans = [makeScan('a'), makeScan('b'), makeScan('c')];
    let s = makeInitialSceneState();
    s = { ...s, scans };
    const actions: SceneAction[] = scans.map((sc, i) => ({
      t: 'remove' as const,
      kind: 'scan' as const,
      id: sc.id,
      index: i,
      object: sc,
    }));
    s = run(s, { c: 'commit', tx: tx('Delete 3 scans', actions) });
    expect(s.scans).toHaveLength(0);
    expect(s.past).toHaveLength(1);

    s = run(s, { c: 'undo' });
    expect(s.scans).toHaveLength(3);
    expect(s.scans.map((x) => x.id).sort()).toEqual(['a', 'b', 'c']);
  });
});

// ── boundary ─────────────────────────────────────────────────────────────────

describe('boundary command', () => {
  it('clears past + future entries that touch the given ids', () => {
    let s = makeInitialSceneState();
    s = { ...s, meshes: [makeMesh('m1')] };
    // a transform on m1 (will be purged), and one on m2 (must survive)
    s = run(
      s,
      { c: 'commit', tx: tx('move m1', [{ t: 'transform', kind: 'mesh', id: 'm1', before: { position: { x: 0, y: 0, z: 0 } }, after: { position: { x: 1, y: 0, z: 0 } } }]) },
      { c: 'commit', tx: tx('move m2', [{ t: 'transform', kind: 'mesh', id: 'm2', before: { position: { x: 0, y: 0, z: 0 } }, after: { position: { x: 9, y: 0, z: 0 } } }]) },
    );
    expect(s.past).toHaveLength(2);

    s = run(s, { c: 'boundary', ids: ['m1'] });
    expect(s.past).toHaveLength(1);
    expect(s.past[0].label).toBe('move m2');

    // a subsequent undo must NOT resurrect m1's pre-boundary state
    s = run(s, { c: 'undo' });
    expect(s.meshPositions.get('m2')).toEqual({ x: 0, y: 0, z: 0 });
    expect(s.past).toHaveLength(0);
  });
});

// ── cap + eviction ───────────────────────────────────────────────────────────

describe('history cap + session eviction', () => {
  it('caps past at MAX_HISTORY and frees the evicted remove-scan session exactly once', () => {
    const freeSession = vi.fn();
    let s = makeInitialSceneState();

    // First transaction is a scan removal carrying a sessionId; it should be the
    // one evicted once we push MAX_HISTORY more transactions on top.
    const removeTx = tx('remove s1', [
      { t: 'remove', kind: 'scan', id: 's1', index: 0, object: makeScan('s1'), sessionId: 'sess-1' },
    ]);
    s = sceneReducer(s, { c: 'commit', tx: removeTx }, { freeSession });

    for (let i = 0; i < MAX_HISTORY; i++) {
      const id = `n${i}`;
      s = sceneReducer(
        s,
        { c: 'commit', tx: tx(id, [{ t: 'add', kind: 'mesh', id, object: makeMesh(id) }]) },
        { freeSession },
      );
    }

    expect(s.past).toHaveLength(MAX_HISTORY);
    expect(freeSession).toHaveBeenCalledTimes(1);
    expect(freeSession).toHaveBeenCalledWith('sess-1');
  });

  it('boundary frees the session of a purged remove', () => {
    const freeSession = vi.fn();
    let s = makeInitialSceneState();
    const removeTx = tx('remove s1', [
      { t: 'remove', kind: 'scan', id: 's1', index: 0, object: makeScan('s1'), sessionId: 'sess-x' },
    ]);
    s = sceneReducer(s, { c: 'commit', tx: removeTx }, { freeSession });
    s = sceneReducer(s, { c: 'boundary', ids: ['s1'] }, { freeSession });
    expect(freeSession).toHaveBeenCalledWith('sess-x');
  });
});

// ── empty-stack guards ───────────────────────────────────────────────────────

describe('guards', () => {
  it('undo/redo on empty stacks are no-ops', () => {
    const s = makeInitialSceneState();
    expect(run(s, { c: 'undo' })).toEqual(s);
    expect(run(s, { c: 'redo' })).toEqual(s);
  });

  it('commit clears the future (no redo after a new branch)', () => {
    let s = makeInitialSceneState();
    s = run(
      s,
      { c: 'commit', tx: tx('a', [{ t: 'add', kind: 'mesh', id: 'm1', object: makeMesh('m1') }]) },
      { c: 'undo' },
    );
    expect(s.future).toHaveLength(1);
    s = run(s, { c: 'commit', tx: tx('b', [{ t: 'add', kind: 'mesh', id: 'm2', object: makeMesh('m2') }]) });
    expect(s.future).toHaveLength(0);
  });
});
