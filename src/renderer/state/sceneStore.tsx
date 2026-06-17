// The single source of truth for every UNDOABLE scene collection, plus the
// unified undo/redo history. A React Context wraps the app; the reducer is the
// ONE chokepoint through which undoable mutations flow, so every mutation can
// record its own inverse. (The old ad-hoc history in PointCloudViewer only
// covered transforms + mask edits precisely because there was no such chokepoint.)
//
// View/display state (selection, visibility, point size, colormap, panel layout)
// is deliberately NOT here — it stays as local component state, out of undo scope.
//
// Phased migration (see plan): collections move into `SceneState` one at a time.
// A collection that isn't migrated yet simply has an empty map/array here and is
// still owned by its component; once migrated, its add/remove become undoable for
// free because the reducer is the only writer.

import React, { createContext, useContext, useMemo, useReducer, useRef } from 'react';
import type {
  CloudEditState,
  CloudFilters,
  MeshColorMode,
  MeshEntry,
  QSMEntry,
  LADResultEntry,
  SkeletonEntry,
} from '../lib/pointCloudTypes';
import type { Scan } from '../lib/scan';
import {
  cloneCloudEditState,
  cloneTransform,
  invertTransaction,
  type HistoryTransaction,
  type ObjectKind,
  type SceneAction,
  type Vec3,
} from './sceneActions';

// Cap mirrors the original history (100 entries). Beyond this the oldest
// transactions are evicted; an evicted `remove` of an octree cloud frees its
// backend session (the only place a removed cloud's session is freed — see plan).
export const MAX_HISTORY = 100;

export interface SceneState {
  // Object collections (migrated in per phase).
  scans: Scan[];
  meshes: MeshEntry[];
  skeletons: SkeletonEntry[];
  qsms: QSMEntry[];
  ladResults: LADResultEntry[];
  // Transform maps, keyed by object id.
  meshPositions: Map<string, Vec3>;
  meshRotations: Map<string, Vec3>;
  meshScales: Map<string, Vec3>;
  skeletonPositions: Map<string, Vec3>;
  // Cloud edit state (translation + erased indices + pending deletes), keyed by scan id.
  editStates: Map<string, CloudEditState>;
  // Undoable per-object display props.
  meshOpacities: Map<string, number>;
  meshColorModes: Map<string, MeshColorMode>;
  cloudFilters: Map<string, CloudFilters>;
  // History: past (undoable) and future (redoable) transactions.
  past: HistoryTransaction[];
  future: HistoryTransaction[];
}

export function makeInitialSceneState(): SceneState {
  return {
    scans: [],
    meshes: [],
    skeletons: [],
    qsms: [],
    ladResults: [],
    meshPositions: new Map(),
    meshRotations: new Map(),
    meshScales: new Map(),
    skeletonPositions: new Map(),
    editStates: new Map(),
    meshOpacities: new Map(),
    meshColorModes: new Map(),
    cloudFilters: new Map(),
    past: [],
    future: [],
  };
}

// Callback invoked when a `remove` action is EVICTED off the history tail (or
// purged by a boundary). Used to free octree backend sessions exactly when the
// removed cloud is no longer undoable. Registered by the provider; defaults to a
// no-op so the reducer is pure/testable without it.
export type SessionFreeFn = (sessionId: string) => void;

// ── Store commands ──────────────────────────────────────────────────────────
// `commit` records a transaction (one user gesture); undo/redo replay; boundary
// clears history for the given ids (the destructive-op tombstone). `replace`
// directly sets a collection WITHOUT recording history — used during migration
// and for non-undoable bookkeeping the component still owns.
export type SceneCommand =
  | { c: 'commit'; tx: HistoryTransaction }
  | { c: 'undo' }
  | { c: 'redo' }
  | { c: 'boundary'; ids: string[] }
  | { c: 'replaceCollection'; apply: (s: SceneState) => Partial<SceneState> };

// Apply ONE action to the collections (no history bookkeeping). Used by `commit`
// (forward) and by undo/redo (which feed inverted/original actions through here).
function applyAction(state: SceneState, action: SceneAction): SceneState {
  switch (action.t) {
    case 'add':
      return applyAdd(state, action);
    case 'remove':
      return applyRemove(state, action);
    case 'transform':
      return applyTransform(state, action.kind, action.id, action.after);
    case 'property':
      return applyProperty(state, action.kind, action.id, action.key, action.after);
    case 'maskEdit': {
      const editStates = new Map(state.editStates);
      editStates.set(action.id, cloneCloudEditState(action.after));
      return { ...state, editStates };
    }
    case 'replaceObject':
      return applyReplaceObject(state, action.kind, action.id, action.after);
  }
}

// Insert `obj` at `index` (clamped) when provided, else append. Used so undo of a
// delete restores the object at its original list position.
function insertAt<T>(arr: T[], obj: T, index?: number): T[] {
  if (index == null || index < 0 || index >= arr.length) return [...arr, obj];
  return [...arr.slice(0, index), obj, ...arr.slice(index)];
}

function applyAdd(state: SceneState, action: Extract<SceneAction, { t: 'add' }>): SceneState {
  const next = { ...state };
  switch (action.kind) {
    case 'scan':
      next.scans = insertAt(state.scans, action.object as Scan, action.index);
      break;
    case 'mesh':
      next.meshes = insertAt(state.meshes, action.object as MeshEntry, action.index);
      break;
    case 'skeleton':
      next.skeletons = insertAt(state.skeletons, action.object as SkeletonEntry, action.index);
      break;
    case 'qsm':
      next.qsms = insertAt(state.qsms, action.object as QSMEntry, action.index);
      break;
    case 'lad':
      next.ladResults = insertAt(state.ladResults, action.object as LADResultEntry, action.index);
      break;
  }
  if (action.transform) {
    return seedTransform(next, action.kind, action.id, action.transform);
  }
  return next;
}

function applyRemove(state: SceneState, action: Extract<SceneAction, { t: 'remove' }>): SceneState {
  const next = { ...state };
  switch (action.kind) {
    case 'scan':
      next.scans = state.scans.filter((s) => s.id !== action.id);
      break;
    case 'mesh':
      next.meshes = state.meshes.filter((m) => m.id !== action.id);
      break;
    case 'skeleton':
      next.skeletons = state.skeletons.filter((s) => s.id !== action.id);
      break;
    case 'qsm':
      next.qsms = state.qsms.filter((q) => q.id !== action.id);
      break;
    case 'lad':
      next.ladResults = state.ladResults.filter((r) => r.id !== action.id);
      break;
  }
  return next;
}

// Insert a removed object's transform/editState/filters back. Called when an
// 'add' that originated as the inverse of a 'remove' is applied (undo of a
// delete). The 'add' carries `transform`; editState/filters live on the original
// 'remove' action, so undo of a remove must restore them. We thread them via the
// add's payload object where possible; editState/filters are re-applied here when
// present on the action.
function seedTransform(
  state: SceneState,
  kind: ObjectKind,
  id: string,
  transform: { position: Vec3; rotation?: Vec3; scale?: Vec3 },
): SceneState {
  if (kind === 'mesh') {
    const meshPositions = new Map(state.meshPositions);
    meshPositions.set(id, { ...transform.position });
    const next: SceneState = { ...state, meshPositions };
    if (transform.rotation) {
      const meshRotations = new Map(state.meshRotations);
      meshRotations.set(id, { ...transform.rotation });
      next.meshRotations = meshRotations;
    }
    if (transform.scale) {
      const meshScales = new Map(state.meshScales);
      meshScales.set(id, { ...transform.scale });
      next.meshScales = meshScales;
    }
    return next;
  }
  if (kind === 'skeleton') {
    const skeletonPositions = new Map(state.skeletonPositions);
    skeletonPositions.set(id, { ...transform.position });
    return { ...state, skeletonPositions };
  }
  return state;
}

function applyTransform(
  state: SceneState,
  kind: 'mesh' | 'skeleton' | 'cloud',
  id: string,
  t: { position: Vec3; rotation?: Vec3; scale?: Vec3 },
): SceneState {
  if (kind === 'mesh') {
    const meshPositions = new Map(state.meshPositions);
    meshPositions.set(id, { ...t.position });
    const next: SceneState = { ...state, meshPositions };
    if (t.rotation) {
      const meshRotations = new Map(state.meshRotations);
      meshRotations.set(id, { ...t.rotation });
      next.meshRotations = meshRotations;
    }
    if (t.scale) {
      const meshScales = new Map(state.meshScales);
      meshScales.set(id, { ...t.scale });
      next.meshScales = meshScales;
    }
    return next;
  }
  if (kind === 'skeleton') {
    const skeletonPositions = new Map(state.skeletonPositions);
    skeletonPositions.set(id, { ...t.position });
    return { ...state, skeletonPositions };
  }
  // cloud: translation lives on editStates
  const editStates = new Map(state.editStates);
  const cur = editStates.get(id) ?? { translation: { x: 0, y: 0, z: 0 }, erasedIndices: new Set<number>() };
  editStates.set(id, { ...cloneCloudEditState(cur), translation: { ...t.position } });
  return { ...state, editStates };
}

function applyProperty(
  state: SceneState,
  kind: ObjectKind,
  id: string,
  key: 'label' | 'color' | 'opacity' | 'colorMode',
  value: unknown,
): SceneState {
  // opacity / colorMode live in side maps; label/color live on the entry object.
  if (key === 'opacity') {
    const meshOpacities = new Map(state.meshOpacities);
    meshOpacities.set(id, value as number);
    return { ...state, meshOpacities };
  }
  if (key === 'colorMode') {
    const meshColorModes = new Map(state.meshColorModes);
    meshColorModes.set(id, value as MeshColorMode);
    return { ...state, meshColorModes };
  }
  // label/color live on the entry object. The display-name field differs by
  // kind: scans use `label`, mesh/skeleton/qsm use `name`. Map the logical
  // 'label' key to the concrete field; 'color' is uniform.
  const field = key === 'label' ? (kind === 'scan' ? 'label' : 'name') : key;
  const setField = <T extends { id: string }>(arr: T[]): T[] =>
    arr.map((o) => (o.id === id ? { ...o, [field]: value } : o));
  switch (kind) {
    case 'scan':
      return { ...state, scans: setField(state.scans) };
    case 'mesh':
      return { ...state, meshes: setField(state.meshes) };
    case 'skeleton':
      return { ...state, skeletons: setField(state.skeletons) };
    case 'qsm':
      return { ...state, qsms: setField(state.qsms) };
    case 'lad':
      return { ...state, ladResults: setField(state.ladResults) };
  }
  return state;
}

function applyReplaceObject(
  state: SceneState,
  kind: 'mesh' | 'qsm',
  id: string,
  obj: MeshEntry | QSMEntry,
): SceneState {
  if (kind === 'mesh') {
    return { ...state, meshes: state.meshes.map((m) => (m.id === id ? (obj as MeshEntry) : m)) };
  }
  return { ...state, qsms: state.qsms.map((q) => (q.id === id ? (obj as QSMEntry) : q)) };
}

// Undo of a delete must also restore editState/filters that the original
// `remove` captured. We apply the inverse 'add' (object + transform) then layer
// any editState/filters from the matching past action. To keep this localized,
// undo/redo re-apply the WHOLE transaction's actions; for a 'remove' inverse we
// detect editState/filters on the source action and restore them here.
function restoreSidecarsForUndo(state: SceneState, action: SceneAction): SceneState {
  if (action.t !== 'remove') return state;
  let next = state;
  if (action.editState) {
    const editStates = new Map(next.editStates);
    editStates.set(action.id, cloneCloudEditState(action.editState));
    next = { ...next, editStates };
  }
  if (action.filters) {
    const cloudFilters = new Map(next.cloudFilters);
    cloudFilters.set(action.id, action.filters);
    next = { ...next, cloudFilters };
  }
  return next;
}

// Free backend sessions for any 'remove' actions in the evicted transactions.
function freeEvictedSessions(evicted: HistoryTransaction[], freeSession?: SessionFreeFn) {
  if (!freeSession) return;
  for (const tx of evicted) {
    for (const action of tx.actions) {
      if (action.t === 'remove' && action.kind === 'scan' && action.sessionId) {
        freeSession(action.sessionId);
      }
    }
  }
}

export interface SceneReducerContext {
  freeSession?: SessionFreeFn;
}

export function sceneReducer(
  state: SceneState,
  command: SceneCommand,
  ctx?: SceneReducerContext,
): SceneState {
  switch (command.c) {
    case 'replaceCollection': {
      const patch = command.apply(state);
      return { ...state, ...patch };
    }
    case 'commit': {
      // Apply the transaction forward, push to past, clear future, enforce cap.
      let next = state;
      for (const action of command.tx.actions) {
        next = applyAction(next, action);
      }
      const past = [...state.past, command.tx];
      let evicted: HistoryTransaction[] = [];
      if (past.length > MAX_HISTORY) {
        evicted = past.splice(0, past.length - MAX_HISTORY);
      }
      freeEvictedSessions(evicted, ctx?.freeSession);
      return { ...next, past, future: [] };
    }
    case 'undo': {
      if (state.past.length === 0) return state;
      const tx = state.past[state.past.length - 1];
      const inverse = invertTransaction(tx);
      let next = state;
      for (const action of inverse.actions) {
        next = applyAction(next, action);
        // The inverse of a 'remove' is an 'add'; the sidecar editState/filters
        // captured on the original 'remove' must also be restored. Find the
        // original action by id to recover them.
        if (action.t === 'add') {
          const orig = tx.actions.find((a) => a.t === 'remove' && a.id === action.id);
          if (orig) next = restoreSidecarsForUndo(next, orig);
        }
      }
      return {
        ...next,
        past: state.past.slice(0, -1),
        future: [tx, ...state.future],
      };
    }
    case 'redo': {
      if (state.future.length === 0) return state;
      const tx = state.future[0];
      let next = state;
      for (const action of tx.actions) {
        next = applyAction(next, action);
      }
      return {
        ...next,
        past: [...state.past, tx],
        future: state.future.slice(1),
      };
    }
    case 'boundary': {
      // Destructive-op tombstone: drop any history (past + future) that touches
      // the given ids, freeing evicted cloud sessions. Centralizes the four old
      // post-bake `setHistory(prev => prev.filter(...))` purges.
      const idset = new Set(command.ids);
      const touches = (tx: HistoryTransaction) => tx.actions.some((a) => idset.has(a.id));
      const evicted = [...state.past.filter(touches), ...state.future.filter(touches)];
      freeEvictedSessions(evicted, ctx?.freeSession);
      return {
        ...state,
        past: state.past.filter((tx) => !touches(tx)),
        future: state.future.filter((tx) => !touches(tx)),
      };
    }
  }
}

// ── React wiring ─────────────────────────────────────────────────────────────

export interface SceneContextValue {
  state: SceneState;
  dispatch: (command: SceneCommand) => void;
  commit: (tx: HistoryTransaction) => void;
  undo: () => void;
  redo: () => void;
  boundary: (ids: string[]) => void;
  canUndo: boolean;
  canRedo: boolean;
}

const SceneContext = createContext<SceneContextValue | null>(null);

export function SceneProvider({
  children,
  freeSession,
}: {
  children: React.ReactNode;
  freeSession?: SessionFreeFn;
}) {
  // Keep freeSession current without re-creating the reducer.
  const freeSessionRef = useRef(freeSession);
  freeSessionRef.current = freeSession;

  const [state, rawDispatch] = useReducer(
    (s: SceneState, c: SceneCommand) => sceneReducer(s, c, { freeSession: freeSessionRef.current }),
    undefined,
    makeInitialSceneState,
  );

  const value = useMemo<SceneContextValue>(
    () => ({
      state,
      dispatch: rawDispatch,
      commit: (tx) => rawDispatch({ c: 'commit', tx }),
      undo: () => rawDispatch({ c: 'undo' }),
      redo: () => rawDispatch({ c: 'redo' }),
      boundary: (ids) => rawDispatch({ c: 'boundary', ids }),
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
    }),
    [state],
  );

  return <SceneContext.Provider value={value}>{children}</SceneContext.Provider>;
}

export function useScene(): SceneContextValue {
  const ctx = useContext(SceneContext);
  if (!ctx) throw new Error('useScene must be used within a SceneProvider');
  return ctx;
}

// Re-export the transaction helpers callers need to build commits.
export { cloneCloudEditState, cloneTransform };
