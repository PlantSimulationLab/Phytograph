// Pending (uncommitted) label strokes, keyed by cloud AND column.
//
// The label tool used to hold ONE stroke list for the whole tool, cleared only
// by Commit. Painting cloud A and then selecting cloud B left A's strokes as
// B's: B's overlay replayed A's regions over B's points, B's Undo sent A's
// stroke ids to B's session, and a Commit on B moved A's strokes into B's hold.
// Keying by (cloud, column) makes every reader take the entry for the target it
// is actually looking at. The column half is what removes the old "commit
// before switching column" rule: the backend already keys its undo history per
// column, so the renderer now matches it.

import type { ClassPalette } from './classPalettes';
import type { LabelStroke } from './pointCloudTypes';

export interface LabelPendingEntry {
  strokes: LabelStroke[];
  /** The octree is behind this column (a stroke or an undo since the commit). */
  dirty: boolean;
  /** The palette the strokes were painted with, so the overlay can draw them
   *  while another cloud is the tool's target. */
  palette: ClassPalette | null;
}

export type LabelPendingMap = ReadonlyMap<string, ReadonlyMap<string, LabelPendingEntry>>;

export const EMPTY_LABEL_PENDING: LabelPendingEntry = Object.freeze({
  strokes: [], dirty: false, palette: null,
}) as LabelPendingEntry;

export function pendingFor(
  map: LabelPendingMap, cloudId: string | undefined, slug: string | undefined,
): LabelPendingEntry {
  if (!cloudId || !slug) return EMPTY_LABEL_PENDING;
  return map.get(cloudId)?.get(slug) ?? EMPTY_LABEL_PENDING;
}

/** Copy-on-write update of one (cloud, column) entry. Returns `map` itself when
 *  the updater returns the entry unchanged, so React can skip the render. */
export function updatePending(
  map: LabelPendingMap, cloudId: string, slug: string,
  fn: (entry: LabelPendingEntry) => LabelPendingEntry,
): LabelPendingMap {
  const prev = pendingFor(map, cloudId, slug);
  const next = fn(prev);
  if (next === prev) return map;
  const byCloud = new Map(map);
  const bySlug = new Map(map.get(cloudId) ?? []);
  bySlug.set(slug, next);
  byCloud.set(cloudId, bySlug);
  return byCloud;
}

/** Drop every entry for a cloud that no longer exists (deleted, File → New). */
export function prunePending(map: LabelPendingMap, liveCloudIds: ReadonlySet<string>): LabelPendingMap {
  if ([...map.keys()].every((id) => liveCloudIds.has(id))) return map;
  const next = new Map(map);
  for (const id of [...next.keys()]) if (!liveCloudIds.has(id)) next.delete(id);
  return next;
}

/** Strokes pending across every cloud and column — what the quit and File →
 *  New guards warn about, since work on a cloud that is not selected is just as
 *  much at risk. */
export function totalPendingStrokes(map: LabelPendingMap): number {
  let n = 0;
  for (const bySlug of map.values()) for (const e of bySlug.values()) n += e.strokes.length;
  return n;
}
