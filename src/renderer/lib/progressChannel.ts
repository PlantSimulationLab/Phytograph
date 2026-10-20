/**
 * A progress value that lives OUTSIDE React state.
 *
 * A long operation's progress pill is drawn by PointCloudViewer, and some
 * operations animate their bar from a timer (the synthetic-scan creep ticks at
 * 25 Hz, the backfill creep at 10 Hz). Held in the viewer's own useState, every
 * tick re-rendered the entire viewer (~400 hooks and its whole JSX tree, plus
 * per-cloud work hanging off it) for the full length of the run, just to move
 * one bar. The viewer now owns only the channel; the pill subscribes to it
 * (`useSyncExternalStore`), so a tick re-renders the pill alone.
 */
export interface Progress {
  label: string;
  value: number | null;
}

export interface ProgressChannel {
  get(): Progress | null;
  /** Publish a new value. A value equal to the current one notifies nobody. */
  set(next: Progress | null): void;
  subscribe(listener: () => void): () => void;
}

export function createProgressChannel(): ProgressChannel {
  let current: Progress | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      if (next === current) return;
      if (next && current && next.label === current.label && next.value === current.value) return;
      current = next;
      for (const l of listeners) l();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
