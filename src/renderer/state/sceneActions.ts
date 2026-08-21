// Generalized undo/redo action model for the whole scene.
//
// Every undoable mutation flows through a single reducer (see sceneStore.tsx).
// Each `SceneAction` carries enough state (before/after, or the whole object)
// to compute its own inverse, so undo/redo is a pure swap with no re-reads from
// disk or the backend — honoring "the in-RAM array is the source of truth".
//
// A `HistoryTransaction` is the unit of undo: one user gesture (even one that
// touches several objects, e.g. "delete 3 selected") becomes exactly one entry
// on the stack. See sceneStore for how transactions are recorded and replayed.
//
// IMPORTANT: heavy data-replacement ops (bake / segment / ICP / cloud-to-cloud
// register / synthetic-scan-overwrite) are deliberately NOT modeled here. They
// stay explicit destructive *boundaries* that clear forward history via the
// '__boundary' reducer command — no multi-megabyte Float32Array ever enters the
// stack. This matches the de-facto LiDAR-tooling standard (CloudCompare/ReCap),
// which never snapshots gigabyte clouds into an undo buffer.

import type {
  CloudEditState,
  CloudFilters,
  LabelEditState,
  MeshColorMode,
  MeshEntry,
  QSMEntry,
  LADResultEntry,
  SkeletonEntry,
} from '../lib/pointCloudTypes';
import type { Scan } from '../lib/scan';

export type Vec3 = { x: number; y: number; z: number };

// Every object kind the unified history can add/remove.
export type ObjectKind = 'scan' | 'mesh' | 'skeleton' | 'qsm' | 'lad';

// The union of object payloads an 'add'/'remove' action can carry. Kept as the
// full entry so reinstating a removed object is an exact restore (same id, same
// data reference) rather than a rebuild.
export type SceneObject = Scan | MeshEntry | SkeletonEntry | QSMEntry | LADResultEntry;

// Transform snapshot for a mesh/skeleton/cloud. Rotation/scale are absent for
// clouds and skeletons (only meshes carry all three); position is always present.
export interface TransformState {
  position: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
}

// The transform-bearing kinds. Clouds translate (position only) via editStates;
// meshes carry position+rotation+scale; skeletons carry position only.
export type TransformKind = 'mesh' | 'skeleton' | 'cloud';

// A single primitive mutation. Each is self-inverting given the data it carries.
export type SceneAction =
  // Object created. Undo removes it; redo re-adds `object` (+ seeded transform).
  // `index` is set only when this add is the inverse of a remove (undo of a
  // delete) — it re-inserts at the object's original list position; a normal
  // create leaves it undefined and appends.
  | {
      t: 'add';
      kind: ObjectKind;
      id: string;
      object: SceneObject;
      transform?: TransformState;
      index?: number;
      // Same role as on `remove` (octree clouds only): the backend session to
      // free when this action is EVICTED or purged — never when it is applied.
      //
      // Needed because an UNDONE add still owns a live session. Undo pushes the
      // original `add` transaction onto `future`, so the tx that eventually gets
      // evicted/purged is the add, not a remove. Without this field the store's
      // `remove`-only free check never matched it and the session leaked for the
      // life of the process: import a multi-GB cloud, press Cmd+Z, and the
      // Python sidecar held that RAM until quit.
      sessionId?: string | null;
    }
  // Object removed. Undo re-inserts `object` at `index` and restores its
  // transform / editState / filters. `sessionId` (octree clouds only) is held so
  // the reducer can free the backend session when this action is EVICTED — never
  // on the remove itself, so undo can resurrect the cloud with its session intact.
  | {
      t: 'remove';
      kind: ObjectKind;
      id: string;
      index: number;
      object: SceneObject;
      transform?: TransformState;
      editState?: CloudEditState;
      filters?: CloudFilters;
      sessionId?: string | null;
    }
  // Transform changed (drag, move-to-origin, numeric entry). before/after of the
  // relevant maps for one object.
  | {
      t: 'transform';
      kind: TransformKind;
      id: string;
      before: TransformState;
      after: TransformState;
    }
  // A single keyed scalar field changed (rename, color, opacity, color mode).
  | {
      t: 'property';
      kind: ObjectKind;
      id: string;
      key: 'label' | 'color' | 'opacity' | 'colorMode';
      before: PropertyValue;
      after: PropertyValue;
    }
  // Pre-bake erase/crop region push/pop. Round-trips the cloud's CloudEditState
  // (translation + erasedIndices + pending deletes) — NOT the point array.
  | {
      t: 'maskEdit';
      id: string;
      before: CloudEditState;
      after: CloudEditState;
    }
  // Pre-commit label stroke push/pop. Round-trips the cloud's LabelEditState —
  // an ordered list of {region, fromClasses, toClass} strokes, NOT point data
  // and NOT the per-point deltas (those live in the backend session, keyed by
  // strokeId; see reset_label_edits). A stroke is ~200 bytes whether it hit 50
  // points or 5,000,000, so undo memory is O(strokes) not O(points) — the same
  // rule this file states at the top.
  //
  // Kept as its own action with its own state map rather than a field on
  // CloudEditState: that state is deep-cloned on every transform drag, and the
  // two have different boundary rules (bake clears both; committing labels
  // clears neither).
  | {
      t: 'labelEdit';
      id: string;
      slug: string;
      before: LabelEditState;
      after: LabelEditState;
    }
  // Plant-param op (morph / advance-age / add-leaves / adjust-angles) that
  // replaces a mesh or QSM entry wholesale. Mesh/QSM payloads are small relative
  // to point clouds; if a given op's mesh is large, the handler should emit a
  // '__boundary' instead (decided per-op by vertex count).
  | {
      t: 'replaceObject';
      kind: 'mesh' | 'qsm';
      id: string;
      before: MeshEntry | QSMEntry;
      after: MeshEntry | QSMEntry;
    };

export type PropertyValue = string | number | MeshColorMode | undefined;

// One user gesture = one undo step. Actions are applied in array order on redo
// and inverted in reverse order on undo.
export interface HistoryTransaction {
  // Human-readable, for menu hints / debugging (e.g. "Delete 3 scans").
  label: string;
  actions: SceneAction[];
}

// Deep-clone a CloudEditState, including its erasedIndices Set and the
// pendingDeletes array. The Set MUST be cloned: snapshots that share the live
// Set reference would mutate together, breaking undo. (Ported verbatim in intent
// from the original captureState in PointCloudViewer.)
export function cloneCloudEditState(state: CloudEditState): CloudEditState {
  return {
    ...state,
    erasedIndices: new Set(state.erasedIndices),
    pendingDeletes: state.pendingDeletes ? state.pendingDeletes.map((r) => ({ ...r })) : undefined,
  };
}

/**
 * Deep-clone a LabelEditState. The stroke list and every region inside it must
 * be copied, not shared: a snapshot sharing the live array would mutate along
 * with it and break undo, exactly as `cloneCloudEditState` guards against for
 * its Set and pendingDeletes.
 */
export function cloneLabelEditState(state: LabelEditState): LabelEditState {
  return {
    ...state,
    strokes: state.strokes.map((s) => ({
      ...s,
      // A region carries nested ARRAYS (box min/max, polygon points, the frozen
      // camera matrices), so a spread is not enough — a shallow copy leaves them
      // shared with the live stroke and a later mutation would silently rewrite
      // the undo snapshot. structuredClone handles the whole union uniformly.
      region: structuredClone(s.region),
      fromClasses: s.fromClasses ? [...s.fromClasses] : undefined,
    })),
    visibleClasses: state.visibleClasses ? [...state.visibleClasses] : undefined,
    lockedClasses: state.lockedClasses ? [...state.lockedClasses] : undefined,
  };
}

function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function cloneTransform(t: TransformState): TransformState {
  return {
    position: cloneVec3(t.position),
    rotation: t.rotation ? cloneVec3(t.rotation) : undefined,
    scale: t.scale ? cloneVec3(t.scale) : undefined,
  };
}

// Compute the inverse of a single action: the action that, applied to the state
// produced by `action`, restores the prior state. Used by undo. (Add⇄remove and
// transform/property/maskEdit/replaceObject ⇄ swap before/after.)
//
// `add` and `remove` need each other's full shape, so the inverse of an `add` is
// a synthesized `remove` and vice-versa. The reducer is the actual applier; this
// helper exists so the model is testable in isolation and the reducer stays a
// thin dispatch over `invert`.
export function invert(action: SceneAction): SceneAction {
  switch (action.t) {
    case 'add':
      return {
        t: 'remove',
        kind: action.kind,
        id: action.id,
        // Preserve the object's current list index so a later redo (this remove's
        // own inverse) re-inserts it where it was. Falls back to its add index.
        index: action.index ?? 0,
        object: action.object,
        transform: action.transform,
        // Carry the session both ways so whichever direction the transaction is
        // sitting in when it gets evicted, the store can still free it.
        sessionId: action.sessionId,
      };
    case 'remove':
      return {
        t: 'add',
        kind: action.kind,
        id: action.id,
        object: action.object,
        transform: action.transform,
        // Re-insert at the original position on undo of a delete.
        index: action.index,
        sessionId: action.sessionId,
      };
    case 'transform':
      return { ...action, before: action.after, after: action.before };
    case 'property':
      return { ...action, before: action.after, after: action.before };
    case 'maskEdit':
      return { ...action, before: action.after, after: action.before };
    case 'labelEdit':
      return { ...action, before: action.after, after: action.before };
    case 'replaceObject':
      return { ...action, before: action.after, after: action.before };
  }
}

// Invert a whole transaction: reverse the action order and invert each. This is
// what undo replays. (Redo replays the original transaction forward.)
export function invertTransaction(tx: HistoryTransaction): HistoryTransaction {
  return {
    label: tx.label,
    actions: [...tx.actions].reverse().map(invert),
  };
}
