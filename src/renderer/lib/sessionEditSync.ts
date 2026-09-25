// What the backend session must do when Cmd+Z / Cmd+Shift+Z replays a
// transaction whose truth lives in the session rather than in the store.
//
// `maskEdit` (erase/crop deletes) and `labelEdit` (label strokes) carry only
// the LIGHT description of an edit: the regions and strokes. The per-point
// deltas live in the session (`deleted_history`, `label_history`), so the
// reducer alone cannot undo them and the session has to be told.
//
// The target state comes from the TRANSACTION itself: undo moves to
// `action.before`, redo to `action.after`. It used to be read back from the
// store after `scene.undo()`, but the dispatch has not re-rendered yet at that
// point, so the store still held the PRE-undo state. Undo then told the session
// to keep everything, and Cmd+Z on a label stroke or an erase did nothing.
//
// Neither endpoint can redo (both histories are truncated by an undo), so a
// redo re-issues the edits the undo removed: the regions/strokes in the target
// that the current state lacks, in order, under their original stroke ids so
// the next undo can still find them.

import type { SceneAction } from '../state/sceneActions';
import type { CropOctreeRegion, LabelStrokeRequest } from '../utils/backendApi';
import type { LabelStroke, PendingDeleteRegion } from './pointCloudTypes';

export type SessionSyncOp =
  /** Keep the first `keep` delete steps (reset_edits). */
  | { op: 'resetDeletes'; cloudId: string; keep: number }
  /** Re-apply delete regions, in order (delete_region, one per step). */
  | { op: 'redoDeletes'; cloudId: string; regions: PendingDeleteRegion[] }
  /** Roll the column back to these surviving strokes (reset_label_edits). */
  | { op: 'resetLabels'; cloudId: string; slug: string; surviving: LabelStroke[] }
  /** Re-paint these strokes, in order (label_region). */
  | { op: 'redoLabels'; cloudId: string; slug: string; strokes: LabelStroke[];
      surviving: LabelStroke[] };

export function planSessionSync(
  actions: readonly SceneAction[], direction: 'undo' | 'redo',
): SessionSyncOp[] {
  const ops: SessionSyncOp[] = [];
  // An undo unwinds a multi-action transaction newest-first, as the reducer does.
  const ordered = direction === 'undo' ? [...actions].reverse() : actions;
  for (const action of ordered) {
    if (action.t !== 'maskEdit' && action.t !== 'labelEdit') continue;
    const from = direction === 'undo' ? action.after : action.before;
    const to = direction === 'undo' ? action.before : action.after;

    if (action.t === 'maskEdit') {
      // A pure translation change (the other thing maskEdit carries) is
      // render-only and already done by the reducer.
      const fromStack = (from as typeof action.before).pendingDeletes ?? [];
      const toStack = (to as typeof action.after).pendingDeletes ?? [];
      if (toStack.length < fromStack.length) {
        ops.push({ op: 'resetDeletes', cloudId: action.id, keep: toStack.length });
      } else if (toStack.length > fromStack.length) {
        // `pendingDeletes` mirrors `deleted_history` one-for-one, so the extra
        // tail is exactly the steps the undo dropped.
        ops.push({ op: 'redoDeletes', cloudId: action.id, regions: toStack.slice(fromStack.length) });
      }
      continue;
    }

    const fromStrokes = (from as typeof action.before).strokes;
    const toStrokes = (to as typeof action.after).strokes;
    const had = new Set(fromStrokes.map((s) => s.strokeId));
    const missing = toStrokes.filter((s) => !had.has(s.strokeId));
    if (missing.length > 0) {
      ops.push({ op: 'redoLabels', cloudId: action.id, slug: action.slug,
                 strokes: missing, surviving: toStrokes });
    } else if (toStrokes.length !== fromStrokes.length) {
      ops.push({ op: 'resetLabels', cloudId: action.id, slug: action.slug, surviving: toStrokes });
    }
  }
  return ops;
}

/** The wire form of a stroke — one builder for the first paint AND a redo, so
 *  a replay can never drop a field (the slab, the From gate) the paint sent. */
export function labelStrokeRequest(stroke: LabelStroke): LabelStrokeRequest {
  return {
    region: stroke.region as CropOctreeRegion,
    to_class: stroke.toClass,
    ...(stroke.fromClasses ? { from_classes: stroke.fromClasses } : {}),
    ...(stroke.excludeClasses?.length ? { exclude_classes: stroke.excludeClasses } : {}),
    ...(stroke.slab ? { slab: stroke.slab as unknown as CropOctreeRegion } : {}),
    ...(stroke.depthLimit ? { depth_limit: stroke.depthLimit } : {}),
    ...(stroke.limitBox ? { limit_box: stroke.limitBox } : {}),
    ...(stroke.fromColumn ? { from_column: stroke.fromColumn } : {}),
    stroke_id: stroke.strokeId,
  };
}
