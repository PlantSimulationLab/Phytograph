// Run async jobs one at a time PER KEY, in submission order.
//
// Label strokes are painted optimistically and their requests sent without
// waiting for the previous one. Two strokes in flight at once could reach the
// backend in either order, and strokes are order-dependent (the second repaints
// what the first painted), so the session could end up different from the
// preview. Chaining each cloud's requests makes the backend's apply order the
// order the user drew them. Different keys (clouds) still run concurrently.

export interface KeyedSerialQueue {
  /** Queue `job` behind every earlier job on `key`. A failed job rejects its
   *  own promise only; the jobs after it still run. */
  run<T>(key: string, job: () => Promise<T>): Promise<T>;
  /** Jobs queued or running on `key` (all keys when omitted). */
  pending(key?: string): number;
  /** Resolves once `key` (every key when omitted) has nothing queued. */
  idle(key?: string): Promise<void>;
}

export function createKeyedSerialQueue(onChange?: () => void): KeyedSerialQueue {
  const tails = new Map<string, Promise<unknown>>();
  const counts = new Map<string, number>();
  const bump = (key: string, d: number) => {
    const n = (counts.get(key) ?? 0) + d;
    if (n > 0) counts.set(key, n); else counts.delete(key);
    onChange?.();
  };
  return {
    run(key, job) {
      bump(key, +1);
      const prev = tails.get(key) ?? Promise.resolve();
      const result = prev.then(job);   // tails never reject
      const tail = result.then(() => undefined, () => undefined)
        .finally(() => {
          bump(key, -1);
          if (tails.get(key) === tail) tails.delete(key);
        });
      tails.set(key, tail);
      return result;
    },
    pending(key) {
      if (key !== undefined) return counts.get(key) ?? 0;
      let n = 0;
      for (const c of counts.values()) n += c;
      return n;
    },
    async idle(key) {
      // Loop: a job can queue another while we wait on the current tail.
      for (;;) {
        const waits = key !== undefined
          ? [tails.get(key)].filter(Boolean)
          : [...tails.values()];
        if (waits.length === 0) return;
        await Promise.all(waits);
      }
    },
  };
}
