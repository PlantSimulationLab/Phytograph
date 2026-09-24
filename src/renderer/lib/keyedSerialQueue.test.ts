import { describe, it, expect, vi } from 'vitest';
import { createKeyedSerialQueue } from './keyedSerialQueue';

/** A fake request that takes `ms` and records when it runs and finishes. */
function fake(log: string[], name: string, ms: number, fail = false) {
  return () => new Promise<string>((resolve, reject) => {
    log.push(`start ${name}`);
    setTimeout(() => {
      log.push(`end ${name}`);
      if (fail) reject(new Error(name)); else resolve(name);
    }, ms);
  });
}

describe('createKeyedSerialQueue', () => {
  it('applies one key in submission order even when an earlier job is slower', async () => {
    // Without the queue the fast second stroke reaches the backend first.
    const log: string[] = [];
    const q = createKeyedSerialQueue();
    const a = q.run('cloud', fake(log, 's1', 30));
    const b = q.run('cloud', fake(log, 's2', 1));
    expect(await Promise.all([a, b])).toEqual(['s1', 's2']);
    expect(log).toEqual(['start s1', 'end s1', 'start s2', 'end s2']);
  });

  it('runs different keys concurrently', async () => {
    const log: string[] = [];
    const q = createKeyedSerialQueue();
    await Promise.all([q.run('A', fake(log, 'a', 20)), q.run('B', fake(log, 'b', 1))]);
    expect(log.indexOf('start b')).toBeLessThan(log.indexOf('end a'));
  });

  it('a failed job rejects alone and the chain carries on', async () => {
    const log: string[] = [];
    const q = createKeyedSerialQueue();
    const a = q.run('c', fake(log, 'bad', 5, true));
    const b = q.run('c', fake(log, 'good', 1));
    await expect(a).rejects.toThrow('bad');
    await expect(b).resolves.toBe('good');
  });

  it('counts what is in flight and reports when it drains', async () => {
    const onChange = vi.fn();
    const q = createKeyedSerialQueue(onChange);
    const log: string[] = [];
    void q.run('c', fake(log, '1', 10));
    void q.run('c', fake(log, '2', 10));
    void q.run('d', fake(log, '3', 10));
    expect(q.pending('c')).toBe(2);
    expect(q.pending()).toBe(3);
    await q.idle('c');
    expect(q.pending('c')).toBe(0);
    expect(log).toContain('end 2');
    await q.idle();
    expect(q.pending()).toBe(0);
    expect(onChange).toHaveBeenCalled();
  });

  it('idle waits for a job queued while it was waiting', async () => {
    const log: string[] = [];
    const q = createKeyedSerialQueue();
    void q.run('c', async () => {
      await fake(log, 'first', 5)();
      void q.run('c', fake(log, 'second', 5));
    });
    await q.idle('c');
    expect(log).toContain('end second');
  });
});
