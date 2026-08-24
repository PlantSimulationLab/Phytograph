import * as THREE from 'three';

/**
 * The deferred-bake queue for cloud transforms.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Baking a transform into a session means the backend rewrites its geometry and
 * refreshes the octree. For a pure TRANSLATION that is now fast (the octree's
 * coordinates are rewritten in place — see `backend-api/octree_transform.py`).
 * For a ROTATION it cannot be: node membership is octant containment in an
 * axis-aligned root cube, so a rotated cloud re-buckets and PotreeConverter has
 * to run again — tens of seconds on a large scan.
 *
 * Auto-Register produces rotations, one per scan, and used to await each bake
 * before starting the next. Applying the alignment therefore cost about as much
 * as computing it, with the UI frozen throughout.
 *
 * The fix is to separate WHERE THE CLOUD IS DRAWN from WHEN ITS GEOMETRY MOVES.
 * The renderer already draws an octree at an arbitrary rigid pose
 * (`applyOctreePose`), so registration can set the pose immediately and queue
 * the bake. The user sees the aligned result at once; the backend catches up.
 *
 * ── The invariant this module exists to protect ───────────────────────────
 * A pending bake means the rendered pose and the session geometry DISAGREE.
 * Any compute run in that window would silently read un-transformed points —
 * exactly the class of silent, geometry-frame failure this codebase has paid
 * for repeatedly. So the rule is absolute:
 *
 *     No compute tool may read a cloud that has a pending bake.
 *
 * `buildPointSource` enforces it at a single chokepoint by refusing to produce
 * a payload while one is outstanding, and callers await `settle()` first. The
 * queue is deliberately NOT part of the scene store: it is transient runtime
 * state, not undoable scene data, and it must not ride along in the deep clone
 * the store makes of `editStates` on every transform drag.
 *
 * ── Serialisation ─────────────────────────────────────────────────────────
 * Bakes run ONE AT A TIME. Each rotation bake spawns PotreeConverter, and
 * running N concurrently would contend on the converter and multiply peak
 * memory — the same reasoning that already made the registration-reset loop
 * sequential.
 */

/** A queued transform waiting to be written into its session. */
export interface PendingBake {
  /** World-frame matrix still to be baked, accumulated across queued moves. */
  matrix: THREE.Matrix4;
  /** Resolvers for everyone awaiting this cloud's bake. */
  waiters: Array<() => void>;
}

export type BakeRunner = (cloudId: string, matrix: THREE.Matrix4) => Promise<void>;

export interface BakeQueueEvents {
  /** Fired whenever the set of outstanding cloud ids changes (drives the pill). */
  onChange?: (pendingIds: string[]) => void;
  /** Fired when a bake throws; the queue continues with the next cloud. */
  onError?: (cloudId: string, error: unknown) => void;
}

/**
 * A serial, per-cloud bake queue.
 *
 * Not a React hook — a plain object held in a ref, so enqueueing from inside an
 * async registration loop never depends on a re-render having happened. The
 * component subscribes via `onChange` for the status pill.
 */
export class BakeQueue {
  private pending = new Map<string, PendingBake>();
  /**
   * The bake in flight, kept as a full entry rather than just an id.
   *
   * It has to stay addressable: `settle()` needs somewhere to attach a waiter
   * for a cloud whose bake has already started, and the alternative (polling
   * until the id clears) is both racy and untestable with fake timers.
   */
  private running: { cloudId: string; entry: PendingBake } | null = null;
  private draining = false;

  constructor(private runner: BakeRunner, private events: BakeQueueEvents = {}) {}

  /** Cloud ids with work outstanding, INCLUDING the one currently baking. */
  pendingIds(): string[] {
    const ids = [...this.pending.keys()];
    if (this.running && !this.pending.has(this.running.cloudId)) ids.push(this.running.cloudId);
    return ids;
  }

  /** True when this cloud's rendered pose is ahead of its session geometry. */
  isPending(cloudId: string): boolean {
    return this.pending.has(cloudId) || this.running?.cloudId === cloudId;
  }

  get size(): number {
    return this.pendingIds().length;
  }

  /**
   * Queue a world-frame transform for `cloudId`.
   *
   * Repeated moves on one cloud COMPOSE rather than queueing twice: the second
   * matrix pre-multiplies the first (`next = m · queued`), matching the order
   * the moves were applied on screen. Collapsing them also means N drags cost
   * one bake, not N.
   */
  enqueue(cloudId: string, matrix: THREE.Matrix4): void {
    const existing = this.pending.get(cloudId);
    if (existing) {
      existing.matrix.premultiply(matrix);
    } else {
      this.pending.set(cloudId, { matrix: matrix.clone(), waiters: [] });
    }
    this.emitChange();
    // Start draining on a later microtask, NOT synchronously.
    //
    // `drain()` runs straight through to its first `await`, so a synchronous
    // call here would pull this very entry out of the map before the caller's
    // next statement — and a second `enqueue` in the same tick (the registration
    // loop applies several moves back to back) would then create a SECOND entry
    // instead of composing into the first. That still bakes correctly, but it
    // costs one full rebuild per move instead of one per cloud, which is most of
    // what deferring the bake was meant to save.
    queueMicrotask(() => { void this.drain(); });
  }

  /**
   * Resolve once `cloudId` has no outstanding bake.
   *
   * This is the barrier every compute path goes through. Resolves immediately
   * when nothing is pending, so the common case costs nothing.
   */
  settle(cloudId: string): Promise<void> {
    // A cloud can be BOTH mid-bake and queued again (a move that arrived while
    // the first bake was running), so both entries must be awaited — resolving
    // on the in-flight one alone would open the barrier while a transform was
    // still unbaked.
    const waitOn: PendingBake[] = [];
    if (this.running?.cloudId === cloudId) waitOn.push(this.running.entry);
    const queued = this.pending.get(cloudId);
    if (queued) waitOn.push(queued);
    if (waitOn.length === 0) return Promise.resolve();
    return Promise.all(
      waitOn.map(e => new Promise<void>(resolve => { e.waiters.push(resolve); })),
    ).then(() => undefined);
  }

  /**
   * Resolve once the whole queue is empty (used on close / before export-all).
   *
   * The loop re-reads `pendingIds()` because a bake can enqueue more work, but
   * it is bounded: if a pass makes no progress the queue is not draining and
   * spinning would hang the caller forever (a real hazard — an early version of
   * `settle()` that resolved eagerly turned this into an infinite loop). Give up
   * rather than wedge, and let the caller proceed.
   */
  async settleAll(maxPasses = 1000): Promise<void> {
    for (let pass = 0; pass < maxPasses && this.size > 0; pass++) {
      await Promise.all(this.pendingIds().map(id => this.settle(id)));
    }
  }

  /**
   * Drop a cloud's queued transform without baking it.
   *
   * For a cloud that has been DELETED: there is no session left to write to, and
   * leaving the entry would block `settleAll` forever. Waiters are resolved so
   * nothing deadlocks.
   */
  cancel(cloudId: string): void {
    const entry = this.pending.get(cloudId);
    if (!entry) return;
    this.pending.delete(cloudId);
    entry.waiters.forEach(w => w());
    this.emitChange();
  }

  private emitChange(): void {
    this.events.onChange?.(this.pendingIds());
  }

  /** Serial drain. Re-entrant-safe: a second call while draining is a no-op. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.size > 0) {
        const [cloudId, entry] = this.pending.entries().next().value as [string, PendingBake];
        // Remove BEFORE awaiting so a transform queued during the bake starts a
        // fresh entry rather than being folded into the one already in flight
        // (which would drop it — its matrix is captured below).
        this.pending.delete(cloudId);
        this.running = { cloudId, entry };
        this.emitChange();
        try {
          await this.runner(cloudId, entry.matrix);
        } catch (err) {
          // Swallowed on purpose: a failed bake must not wedge the queue behind
          // it, and its waiters are released below so no compute path deadlocks
          // on a cloud whose bake will never land.
          this.events.onError?.(cloudId, err);
        } finally {
          this.running = null;
          entry.waiters.forEach(w => w());
          this.emitChange();
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
