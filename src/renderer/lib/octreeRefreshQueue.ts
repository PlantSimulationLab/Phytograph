/**
 * The background display-rebuild queue.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Applying a crop to a session-backed cloud is two very different jobs wearing
 * one name:
 *
 *   1. Deleting the points — `delete_region` sets a boolean mask over the
 *      backend's in-RAM arrays. Milliseconds, regardless of cloud size.
 *   2. Rebuilding the DISPLAY index — `bake` writes a LAS and runs
 *      PotreeConverter over it. Tens of seconds on a large scan; the backend
 *      calls it "the deliberately-slow step".
 *
 * Only (1) changes what the cloud IS. Every compute and export path reads the
 * session arrays (`_read_points_from_source`), never the octree, so they are
 * correct the instant `delete_region` returns. (2) is a render cache catching
 * up. Crop used to await both, which is why a 4-scan crop took minutes to
 * apply a mask the backend had already computed.
 *
 * So the crop commits (1), hides the deleted points with a per-tile mask (the
 * same predicate machinery that draws the live crop preview), and hands (2) to
 * this queue. The user sees the cropped result immediately; the octree is
 * swapped in when it lands, at which point the mask is dropped in the same
 * React commit.
 *
 * ── This is NOT the compute barrier ───────────────────────────────────────
 * `BakeQueue` (lib/pendingBakes.ts) exists to stop compute reading a cloud whose
 * rendered POSE disagrees with its session GEOMETRY, and `buildPointSource`
 * awaits it. Nothing here defers geometry — the points are already deleted — so
 * nothing may block on this queue. Keeping the two separate is what stops a
 * display rebuild from silently acquiring barrier semantics it does not need
 * (and re-introducing the very wait this was built to remove).
 *
 * ── Serialisation and coalescing ──────────────────────────────────────────
 * Refreshes run ONE AT A TIME: each spawns PotreeConverter, and the backend's
 * `_session_rebuild` docstring records the measurement that serialised LAS
 * writes overlapping the previous convert beat running them concurrently.
 *
 * Work COALESCES per cloud. The runner rebuilds from whatever the session holds
 * when it runs, so two crops on one cloud need one rebuild, not two — queueing
 * both would cost a full extra converter run for a result that is immediately
 * discarded.
 */

/** A cloud waiting for its display index to be rebuilt. */
interface PendingRefresh {
  sessionId: string;
  /** Resolvers for anything awaiting this cloud specifically. */
  waiters: Array<() => void>;
}

export type OctreeRefreshRunner = (cloudId: string, sessionId: string) => Promise<void>;

export interface OctreeRefreshQueueEvents {
  /** Fired whenever the set of outstanding cloud ids changes (drives the pill). */
  onChange?: (pendingIds: string[]) => void;
  /** Fired when a refresh throws; the queue continues with the next cloud. */
  onError?: (cloudId: string, error: unknown) => void;
}

export class OctreeRefreshQueue {
  private pending = new Map<string, PendingRefresh>();
  private running: { cloudId: string; entry: PendingRefresh } | null = null;
  private draining = false;

  constructor(
    private runner: OctreeRefreshRunner,
    private events: OctreeRefreshQueueEvents = {},
  ) {}

  /** Cloud ids with work outstanding, INCLUDING the one currently rebuilding. */
  pendingIds(): string[] {
    const ids = [...this.pending.keys()];
    if (this.running && !this.pending.has(this.running.cloudId)) ids.push(this.running.cloudId);
    return ids;
  }

  isPending(cloudId: string): boolean {
    return this.pending.has(cloudId) || this.running?.cloudId === cloudId;
  }

  get size(): number {
    return this.pendingIds().length;
  }

  /**
   * Queue a display rebuild for `cloudId`.
   *
   * Repeated edits to one cloud COLLAPSE onto a single entry — the runner reads
   * the session's current state, so the latest request subsumes the earlier one.
   * The session id is refreshed in case an edit re-homed the cloud.
   */
  enqueue(cloudId: string, sessionId: string): void {
    const existing = this.pending.get(cloudId);
    if (existing) {
      existing.sessionId = sessionId;
    } else {
      this.pending.set(cloudId, { sessionId, waiters: [] });
    }
    this.emitChange();
    // Drain on a later microtask, not synchronously: `drain()` runs straight to
    // its first await, so a synchronous call would pull this entry out of the map
    // before the caller's next statement — and a second enqueue in the same tick
    // (the crop loop commits several scans back to back) would then create a
    // SECOND entry instead of coalescing. Same reasoning as BakeQueue.enqueue.
    queueMicrotask(() => { void this.drain(); });
  }

  /**
   * Resolve once `cloudId` has no outstanding refresh.
   *
   * Deliberately not awaited by any compute path — see the header. It exists for
   * tests and for the rare caller that genuinely needs the rebuilt octree on
   * disk (nothing does today).
   */
  settle(cloudId: string): Promise<void> {
    const waitOn: PendingRefresh[] = [];
    if (this.running?.cloudId === cloudId) waitOn.push(this.running.entry);
    const queued = this.pending.get(cloudId);
    if (queued) waitOn.push(queued);
    if (waitOn.length === 0) return Promise.resolve();
    return Promise.all(
      waitOn.map(e => new Promise<void>(resolve => { e.waiters.push(resolve); })),
    ).then(() => undefined);
  }

  /**
   * Drop a cloud's queued refresh without running it.
   *
   * Safe by construction, and the reason the pill can offer a Cancel: the mask
   * already renders the correct result, so abandoning the rebuild costs only the
   * memory the hidden points occupy in the octree. Used for a DELETED cloud too,
   * where there is no session left to rebuild and a stuck entry would keep the
   * pill up forever.
   */
  cancel(cloudId: string): void {
    const entry = this.pending.get(cloudId);
    if (!entry) return;
    this.pending.delete(cloudId);
    entry.waiters.forEach(w => w());
    this.emitChange();
  }

  /** Drop every queued refresh. The in-flight one is not interrupted. */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
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
        const [cloudId, entry] = this.pending.entries().next().value as [string, PendingRefresh];
        // Remove BEFORE awaiting, so an edit made DURING the rebuild starts a
        // fresh entry and gets its own rebuild afterwards. Folding it into the
        // in-flight one would drop it: that run reads the session as it was when
        // it started, and its result would then be installed over a newer mask.
        this.pending.delete(cloudId);
        this.running = { cloudId, entry };
        this.emitChange();
        try {
          await this.runner(cloudId, entry.sessionId);
        } catch (err) {
          // Swallowed on purpose. A failed rebuild is recoverable — the mask is
          // still hiding the deleted points, so the cloud keeps rendering
          // correctly — and wedging the queue behind it would strand every other
          // cloud's refresh.
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
