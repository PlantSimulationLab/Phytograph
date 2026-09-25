/**
 * Pre-label (F8): seed the column being edited from another column's result.
 * This decides the default class map, which the user can then change.
 */
import type { ClassDef } from './classification';
import { isInstanceColumnSlug, UNCLASSIFIED_VALUE } from './classPalettes';

/**
 * Source value → target class, matched by NAME (case-insensitive): a tool's
 * "Wood" lands on your "Wood" whatever the two columns number it. A source
 * class with no namesake is left out (its points are left alone), and so is
 * the source's own 0, which means "not classified" there too.
 *
 * Instance → instance returns null: copy the ids unchanged, since a tree
 * segmentation's Tree 12 IS the id to correct, and naming cannot match 5,000
 * of them.
 */
export function defaultPrelabelMap(
  sourceSlug: string, source: readonly ClassDef[],
  targetSlug: string, target: readonly ClassDef[],
): Record<string, number> | null {
  if (isInstanceColumnSlug(sourceSlug) && isInstanceColumnSlug(targetSlug)) return null;
  const byName = new Map(target.map((c) => [c.label.trim().toLowerCase(), c.value]));
  const map: Record<string, number> = {};
  for (const c of source) {
    if (c.value === UNCLASSIFIED_VALUE) continue;
    const v = byName.get(c.label.trim().toLowerCase());
    if (v !== undefined) map[String(c.value)] = v;
  }
  return map;
}
