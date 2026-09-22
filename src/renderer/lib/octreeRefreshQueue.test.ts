// The background display-rebuild queue. What matters here is that it stays
// SERIAL (each entry spawns PotreeConverter), that repeated edits to one cloud
// COALESCE into a single rebuild, and that a failure or a cancel never wedges
// the queue — the mask is still rendering the correct result either way.
import { describe, expect, it, vi } from 'vitest';
import { OctreeRefreshQueue, type OctreeRefreshReason } from './octreeRefreshQueue';

/** A runner whose completions the test controls. */
function deferredRunner() {
  const calls: {
    cloudId: string; sessionId: string; reason: OctreeRefreshReason;
    resolve: () => void; reject: (e: unknown) => void;
  }[] = [];
  const runner = (cloudId: string, sessionId: string, reason: OctreeRefreshReason) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ cloudId, sessionId, reason, resolve, reject });
    });
  return { calls, runner };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('OctreeRefreshQueue', () => {
  it('runs one rebuild at a time', async () => {
    const { calls, runner } = deferredRunner();
    const q = new OctreeRefreshQueue(runner);
    q.enqueue('a', 'sa');
    q.enqueue('b', 'sb');
    await flush();
    expect(calls.map(c => c.cloudId)).toEqual(['a']);
    calls[0].resolve();
    await flush();
    expect(calls.map(c => c.cloudId)).toEqual(['a', 'b']);
  });

  it('coalesces repeated edits to one cloud into a single rebuild', async () => {
    const { calls, runner } = deferredRunner();
    const q = new OctreeRefreshQueue(runner);
    // Three crops on the same cloud in one tick — the runner reads the session's
    // current state, so one rebuild subsumes all three.
    q.enqueue('a', 'sa');
    q.enqueue('a', 'sa');
    q.enqueue('a', 'sa-renamed');
    expect(q.size).toBe(1);
    await flush();
    expect(calls).toHaveLength(1);
    // The latest session id wins, in case an edit re-homed the cloud.
    expect(calls[0].sessionId).toBe('sa-renamed');
    calls[0].resolve();
    await flush();
    expect(calls).toHaveLength(1);
    expect(q.size).toBe(0);
  });

  it('does NOT fold an edit made during a rebuild into the running one', async () => {
    const { calls, runner } = deferredRunner();
    const q = new OctreeRefreshQueue(runner);
    q.enqueue('a', 'sa');
    await flush();
    expect(calls).toHaveLength(1);
    // A second crop lands while the first rebuild is in flight. The running pass
    // captured the session as it was, so this MUST get its own rebuild or the
    // stale result would be installed over a newer mask.
    q.enqueue('a', 'sa');
    expect(q.isPending('a')).toBe(true);
    calls[0].resolve();
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('reports the in-flight cloud as pending, and clears when it lands', async () => {
    const { calls, runner } = deferredRunner();
    const seen: string[][] = [];
    const q = new OctreeRefreshQueue(runner, { onChange: ids => seen.push([...ids]) });
    q.enqueue('a', 'sa');
    await flush();
    expect(q.pendingIds()).toEqual(['a']);
    expect(q.isPending('a')).toBe(true);
    calls[0].resolve();
    await flush();
    expect(q.pendingIds()).toEqual([]);
    expect(seen[seen.length - 1]).toEqual([]);
  });

  it('keeps draining after a rebuild throws, and reports it', async () => {
    const { calls, runner } = deferredRunner();
    const onError = vi.fn();
    const q = new OctreeRefreshQueue(runner, { onError });
    q.enqueue('a', 'sa');
    q.enqueue('b', 'sb');
    await flush();
    calls[0].reject(new Error('converter died'));
    await flush();
    expect(onError).toHaveBeenCalledWith('a', expect.any(Error));
    expect(calls.map(c => c.cloudId)).toEqual(['a', 'b']);
    calls[1].resolve();
    await flush();
    expect(q.size).toBe(0);
  });

  it('settle() resolves for an unknown cloud and after the rebuild lands', async () => {
    const { calls, runner } = deferredRunner();
    const q = new OctreeRefreshQueue(runner);
    await expect(q.settle('nobody')).resolves.toBeUndefined();
    q.enqueue('a', 'sa');
    await flush();
    let settled = false;
    void q.settle('a').then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    calls[0].resolve();
    await flush();
    expect(settled).toBe(true);
  });

  it('cancel drops a queued rebuild and releases its waiters', async () => {
    const { calls, runner } = deferredRunner();
    const q = new OctreeRefreshQueue(runner);
    q.enqueue('a', 'sa');
    q.enqueue('b', 'sb');
    await flush();
    let settled = false;
    void q.settle('b').then(() => { settled = true; });
    q.cancel('b');
    await flush();
    expect(settled).toBe(true);
    calls[0].resolve();
    await flush();
    // 'b' never ran.
    expect(calls.map(c => c.cloudId)).toEqual(['a']);
    expect(q.size).toBe(0);
  });

  it('cancelAll clears the queue without interrupting the in-flight rebuild', async () => {
    const { calls, runner } = deferredRunner();
    const q = new OctreeRefreshQueue(runner);
    q.enqueue('a', 'sa');
    await flush();
    q.enqueue('b', 'sb');
    q.enqueue('c', 'sc');
    q.cancelAll();
    expect(q.pendingIds()).toEqual(['a']);
    calls[0].resolve();
    await flush();
    expect(calls.map(c => c.cloudId)).toEqual(['a']);
    expect(q.size).toBe(0);
  });
});

describe('OctreeRefreshQueue reasons', () => {
  it('hands the label commit through to the runner', async () => {
    const { calls, runner } = deferredRunner();
    const q = new OctreeRefreshQueue(runner);
    q.enqueue('a', 'sa', { labelSlug: 'manual_class', labelSeq: 7 });
    await flush();
    expect(calls[0].reason).toEqual({ labelSlug: 'manual_class', labelSeq: 7 });
  });

  it('a plain refresh queued behind a label commit does not erase it', async () => {
    // The order that breaks it: commit labels, then crop. Both coalesce onto
    // one entry, and one converter run satisfies both — but only if the entry
    // still remembers that a label column needs baking. Dropped, the refresh
    // takes the backend's no-rebuild fast path (a label edit leaves the cache
    // id current) and the labels never reach octree.bin.
    const { calls, runner } = deferredRunner();
    const q = new OctreeRefreshQueue(runner);
    q.enqueue('a', 'sa', { labelSlug: 'manual_class', labelSeq: 1 });
    q.enqueue('a', 'sa');
    expect(q.size).toBe(1);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].reason.labelSlug).toBe('manual_class');
    expect(calls[0].reason.labelSeq).toBe(1);
  });

  it('a later commit on the same cloud supersedes the queued one', async () => {
    const { calls, runner } = deferredRunner();
    const q = new OctreeRefreshQueue(runner);
    q.enqueue('a', 'sa', { labelSlug: 'manual_class', labelSeq: 1 });
    q.enqueue('a', 'sa', { labelSlug: 'row_qc', labelSeq: 2 });
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].reason).toEqual({ labelSlug: 'row_qc', labelSeq: 2 });
  });

  it('a commit made DURING a rebuild gets its own run, with its own seq', async () => {
    // The renderer retires the on-screen strokes by seq, so the second run has
    // to arrive carrying the second seq — otherwise the newer strokes would be
    // dropped by the older run or never retired at all.
    const { calls, runner } = deferredRunner();
    const q = new OctreeRefreshQueue(runner);
    q.enqueue('a', 'sa', { labelSlug: 'manual_class', labelSeq: 1 });
    await flush();
    q.enqueue('a', 'sa', { labelSlug: 'manual_class', labelSeq: 2 });
    calls[0].resolve();
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1].reason.labelSeq).toBe(2);
  });
});
