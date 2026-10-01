import type { PickerItem } from '../components/ObjectPicker';

/**
 * Target bookkeeping for the Transformation tool, whose picker lists point
 * clouds AND meshes in one list.
 *
 * Keys are kind-prefixed (`cloud:<id>` / `mesh:<id>`) so the two id spaces can
 * never collide in the one checked set, and every consumer can tell what a
 * checked row is without a lookup.
 */
export type TransformTargetKind = 'cloud' | 'mesh';

export function targetKey(kind: TransformTargetKind, id: string): string {
  return `${kind}:${id}`;
}

export function parseTargetKey(key: string): { kind: TransformTargetKind; id: string } | null {
  const i = key.indexOf(':');
  if (i < 0) return null;
  const kind = key.slice(0, i);
  if (kind !== 'cloud' && kind !== 'mesh') return null;
  return { kind, id: key.slice(i + 1) };
}

/** The ids of one kind in a checked set. */
export function idsOfKind(keys: Iterable<string>, kind: TransformTargetKind): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const p = parseTargetKey(k);
    if (p && p.kind === kind) out.push(p.id);
  }
  return out;
}

/**
 * The checked set the tool opens with: whatever the Scans and Meshes panes have
 * selected, restricted to objects the tool can move.
 *
 * Nothing selected → nothing checked. Every other picker tool checks all
 * eligible inputs on an empty selection, but a transform bake on a cloud cannot
 * be undone, so silently arming every cloud in the scene is the wrong default.
 * A selected param-only scanner marker is not a cloud (there are no points to
 * move) and is left out, as is any stale id.
 */
export function seedTransformTargets(args: {
  cloudIds: Iterable<string>;
  meshIds: Iterable<string>;
  selectedScanIds: Iterable<string>;
  selectedMeshIds: Iterable<string>;
}): Set<string> {
  const clouds = new Set(args.cloudIds);
  const meshes = new Set(args.meshIds);
  const out = new Set<string>();
  for (const id of args.selectedScanIds) if (clouds.has(id)) out.add(targetKey('cloud', id));
  for (const id of args.selectedMeshIds) if (meshes.has(id)) out.add(targetKey('mesh', id));
  return out;
}

/**
 * The generic picker-tool seed: the selected ids a tool can act on, in the
 * tool's own list order. Nothing selected → nothing checked (the tool never
 * arms objects the user didn't pick). Shared by the single-kind picker tools
 * (Crop, …); Transform's two-kind version is `seedTransformTargets`.
 */
export function seedFromSelection(eligibleIds: Iterable<string>, selectedIds: Iterable<string>): Set<string> {
  const selected = new Set(selectedIds);
  const out = new Set<string>();
  for (const id of eligibleIds) if (selected.has(id)) out.add(id);
  return out;
}

/**
 * Erase's checked set when some clouds can only be erased ALONE.
 *
 * A streamed (octree) cloud is erased by screen-space square stamps, which cut
 * every checked cloud behind them, so any number may be checked together. An
 * in-memory (flat) cloud uses a per-point world brush tied to that one cloud,
 * so it can only be the sole target:
 *  - newly checking a flat cloud makes it the only target;
 *  - checking a streamed cloud while a flat one is checked drops the flat one;
 *  - a seed (prev empty) with streamed clouds keeps those, else the first flat.
 */
export function exclusiveFlatTargets(
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>,
  isFlat: (id: string) => boolean,
): Set<string> {
  const ids = [...next];
  const newlyFlat = ids.find(id => isFlat(id) && !prev.has(id));
  if (newlyFlat && prev.size > 0) return new Set([newlyFlat]);
  const streamed = ids.filter(id => !isFlat(id));
  if (streamed.length > 0) return new Set(streamed);
  const firstFlat = ids.find(isFlat);
  return firstFlat ? new Set([firstFlat]) : new Set();
}

/** Keys present in `next` but not `prev` (added) and vice versa (removed). */
export function diffTargets(
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>,
): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const k of next) if (!prev.has(k)) added.push(k);
  for (const k of prev) if (!next.has(k)) removed.push(k);
  return { added, removed };
}

/** Drop keys whose object no longer exists (deleted while the tool was open). */
export function pruneTargets(
  keys: ReadonlySet<string>,
  cloudIds: Iterable<string>,
  meshIds: Iterable<string>,
): Set<string> {
  const clouds = new Set(cloudIds);
  const meshes = new Set(meshIds);
  const out = new Set<string>();
  for (const k of keys) {
    const p = parseTargetKey(k);
    if (!p) continue;
    if ((p.kind === 'cloud' && clouds.has(p.id)) || (p.kind === 'mesh' && meshes.has(p.id))) out.add(k);
  }
  return out;
}

/** Picker rows: clouds first (scene order), then meshes. */
export function transformPickerItems(
  clouds: { id: string; label: string; color?: string; pointCount?: number }[],
  meshes: { id: string; label: string; color?: string; disabledReason?: string }[],
): PickerItem[] {
  return [
    ...clouds.map((c): PickerItem => ({
      id: targetKey('cloud', c.id),
      label: c.label,
      color: c.color,
      detail: c.pointCount !== undefined ? `cloud · ${c.pointCount.toLocaleString()} pts` : 'cloud',
    })),
    ...meshes.map((m): PickerItem => ({
      id: targetKey('mesh', m.id),
      label: m.label,
      color: m.color,
      detail: 'mesh',
      ...(m.disabledReason ? { disabledReason: m.disabledReason } : {}),
    })),
  ];
}
