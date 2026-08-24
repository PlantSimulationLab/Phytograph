import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';

import { BakeQueue } from './pendingBakes';

/** A runner whose completion the test controls, so ordering is observable. */
function deferredRunner() {
  const calls: Array<{ cloudId: string; matrix: THREE.Matrix4; release: () => void }> = [];
  const runner = (cloudId: string, matrix: THREE.Matrix4) =>
    new Promise<void>(resolve => {
      calls.push({ cloudId, matrix, release: resolve });
    });
  return { calls, runner };
}

const T = (x: number, y = 0, z = 0) => new THREE.Matrix4().makeTranslation(x, y, z);

/** Wait for the microtask queue to flush so `drain()` can advance. */
const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('BakeQueue', () => {
  it('reports a cloud as pending from the moment it is enqueued', async () => {
    const { runner } = deferredRunner();
    const q = new BakeQueue(runner);
    expect(q.isPending('a')).toBe(false);
    q.enqueue('a', T(1));
    expect(q.isPending('a')).toBe(true);
  });

  it('settle() resolves only after the bake completes', async () => {
    const { calls, runner } = deferredRunner();
    const q = new BakeQueue(runner);
    q.enqueue('a', T(1));

    let settled = false;
    void q.settle('a').then(() => { settled = true; });
    await flush();

    // The bake is in flight; the barrier must still be closed.
    expect(settled).toBe(false);
    expect(calls).toHaveLength(1);

    calls[0].release();
    await flush();
    expect(settled).toBe(true);
    expect(q.isPending('a')).toBe(false);
  });

  it('settle() on a clean cloud resolves immediately', async () => {
    const { runner } = deferredRunner();
    const q = new BakeQueue(runner);
    await expect(q.settle('nothing-queued')).resolves.toBeUndefined();
  });

  it('runs bakes ONE AT A TIME across clouds', async () => {
    const { calls, runner } = deferredRunner();
    const q = new BakeQueue(runner);
    q.enqueue('a', T(1));
    q.enqueue('b', T(2));
    q.enqueue('c', T(3));
    await flush();

    // Concurrency would contend on PotreeConverter and multiply peak memory.
    expect(calls.map(c => c.cloudId)).toEqual(['a']);

    calls[0].release();
    await flush();
    expect(calls.map(c => c.cloudId)).toEqual(['a', 'b']);

    calls[1].release();
    await flush();
    expect(calls.map(c => c.cloudId)).toEqual(['a', 'b', 'c']);
  });

  it('composes repeated moves on one cloud into a single bake, in apply order', async () => {
    const { calls, runner } = deferredRunner();
    const q = new BakeQueue(runner);

    // Enqueue two moves before the first can start draining, so they merge.
    q.enqueue('a', T(1, 0, 0));
    q.enqueue('a', T(0, 10, 0));
    await flush();

    expect(calls).toHaveLength(1);
    // Second move applied after the first: combined translation is (1, 10, 0).
    const p = new THREE.Vector3(0, 0, 0).applyMatrix4(calls[0].matrix);
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(10);
  });

  it('composes in the order the moves were applied, not the reverse', async () => {
    const { calls, runner } = deferredRunner();
    const q = new BakeQueue(runner);

    // Rotate 90 deg about Z, THEN translate +X. Applied to (1,0,0):
    //   rotate -> (0,1,0); translate -> (1,1,0).
    // The reverse order would give (0,2,0) instead, so this distinguishes them.
    const rot = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    q.enqueue('a', rot);
    q.enqueue('a', T(1, 0, 0));
    await flush();

    const p = new THREE.Vector3(1, 0, 0).applyMatrix4(calls[0].matrix);
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(1);
  });

  it('a transform queued DURING a bake is not folded into the in-flight one', async () => {
    const { calls, runner } = deferredRunner();
    const q = new BakeQueue(runner);
    q.enqueue('a', T(1));
    await flush();
    expect(calls).toHaveLength(1);

    // Arrives while the first bake is still running — must become its own bake,
    // otherwise the move would be silently dropped.
    q.enqueue('a', T(5));
    expect(q.isPending('a')).toBe(true);

    calls[0].release();
    await flush();
    expect(calls).toHaveLength(2);
    const p = new THREE.Vector3(0, 0, 0).applyMatrix4(calls[1].matrix);
    expect(p.x).toBeCloseTo(5);
  });

  it('keeps the barrier closed for a move queued during a bake', async () => {
    const { calls, runner } = deferredRunner();
    const q = new BakeQueue(runner);
    q.enqueue('a', T(1));
    await flush();

    q.enqueue('a', T(5));
    let settled = false;
    void q.settle('a').then(() => { settled = true; });

    calls[0].release();
    await flush();
    // First bake done, but the second is outstanding — compute must still wait.
    expect(settled).toBe(false);

    calls[1].release();
    await flush();
    expect(settled).toBe(true);
  });

  it('continues draining after a bake throws, and reports it', async () => {
    const onError = vi.fn();
    const seen: string[] = [];
    const q = new BakeQueue(async (cloudId) => {
      seen.push(cloudId);
      if (cloudId === 'a') throw new Error('backend exploded');
    }, { onError });

    q.enqueue('a', T(1));
    q.enqueue('b', T(2));
    await flush();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBe('a');
    // A failed bake must not wedge the queue.
    expect(seen).toEqual(['a', 'b']);
    expect(q.size).toBe(0);
  });

  it('releases waiters when a bake throws, so compute is never deadlocked', async () => {
    const q = new BakeQueue(async () => { throw new Error('nope'); }, { onError: () => {} });
    q.enqueue('a', T(1));
    await expect(q.settle('a')).resolves.toBeUndefined();
  });

  it('cancel() drops queued work and releases waiters', async () => {
    const { calls, runner } = deferredRunner();
    const q = new BakeQueue(runner);
    q.enqueue('a', T(1));
    await flush();
    q.enqueue('b', T(2));      // queued behind the in-flight 'a'

    let settled = false;
    void q.settle('b').then(() => { settled = true; });

    // 'b' was deleted from the scene: no session left to write to.
    q.cancel('b');
    await flush();
    expect(settled).toBe(true);
    expect(q.isPending('b')).toBe(false);

    calls[0].release();
    await flush();
    // 'b' must never have been baked.
    expect(calls.map(c => c.cloudId)).toEqual(['a']);
  });

  it('settleAll() waits for every outstanding cloud', async () => {
    const { calls, runner } = deferredRunner();
    const q = new BakeQueue(runner);
    q.enqueue('a', T(1));
    q.enqueue('b', T(2));
    await flush();

    let done = false;
    void q.settleAll().then(() => { done = true; });
    await flush();
    expect(done).toBe(false);

    calls[0].release();
    await flush();
    expect(done).toBe(false);   // 'b' still outstanding

    calls[1].release();
    await flush();
    await flush();
    expect(done).toBe(true);
  });

  it('notifies on every change to the outstanding set', async () => {
    const onChange = vi.fn();
    const { calls, runner } = deferredRunner();
    const q = new BakeQueue(runner, { onChange });

    q.enqueue('a', T(1));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)![0]).toContain('a');

    await flush();
    calls[0].release();
    await flush();
    expect(onChange.mock.calls.at(-1)![0]).toEqual([]);
  });
});
