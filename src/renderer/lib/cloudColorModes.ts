import type { ColorMode, PointCloudData } from './pointCloudTypes';
import { octreeScalarFieldOptions } from './pointCloudHelpers';

export type CloudColorModeEntry = { mode: ColorMode; field?: string };

/**
 * Garbage-collect per-cloud color-mode overrides: drop one whose cloud is
 * gone, and one whose scalar field the cloud no longer carries.
 *
 * "Gone" means SEEN and then removed, never "not here yet". A caller adds a
 * cloud and sets its color mode in the same tick (a ground or wood split does
 * this for every child), but the new cloud reaches `clouds` a render later. If
 * anything else changes `clouds` in between (the parent's own update, an
 * overlay column landing), the old check found no such cloud and deleted the
 * override, so the children came up colored per-scan and the class legend,
 * built only from visible clouds colored by a class column, never appeared. It
 * lost that race intermittently on Linux CI and never on a fast Mac.
 *
 * `seen` accumulates every cloud id that has appeared; it is updated here.
 * Returns `prev` itself when nothing changed, so a state setter skips the render.
 */
export function pruneCloudColorModes(
  prev: Map<string, CloudColorModeEntry>,
  clouds: ReadonlyArray<{ id: string; data: Pick<PointCloudData, 'octree' | 'scalarFields'> }>,
  seen: Set<string>,
): Map<string, CloudColorModeEntry> {
  for (const c of clouds) seen.add(c.id);
  if (prev.size === 0) return prev;
  const byId = new Map(clouds.map(c => [c.id, c]));
  let changed = false;
  const next = new Map(prev);
  for (const [id, entry] of prev) {
    const cloud = byId.get(id);
    if (!cloud) {
      if (seen.has(id)) { next.delete(id); changed = true; }
      continue;
    }
    if (entry.mode !== 'scalar' || !entry.field) continue;
    const available = cloud.data.octree
      ? octreeScalarFieldOptions(
          cloud.data.octree.attributeRanges,
          cloud.data.octree.attributeLabels,
        ).map(o => o.value)
      : Object.keys(cloud.data.scalarFields ?? {});
    if (!available.includes(entry.field)) { next.delete(id); changed = true; }
  }
  return changed ? next : prev;
}
