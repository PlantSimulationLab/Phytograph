/**
 * Instance labelling (F7): an `<name>_instance` column numbers OBJECTS — this
 * tree, that leaf — rather than naming classes, so its palette is a growing
 * list of ids and the edits are about ids: add one, merge two, delete one.
 *
 * Merge and delete are ordinary label strokes (a From-gated repaint over the
 * whole cloud), so they go through the one stroke path and undo like any
 * paint. Nothing here talks to the backend.
 */
import type { ClassPalette } from './classPalettes';
import { isInstanceColumnSlug, nextFreeClassValue, UNCLASSIFIED_VALUE } from './classPalettes';
import { treeInstanceColor } from './classification';
import type { PendingDeleteRegion } from './pointCloudTypes';

export { isInstanceColumnSlug };

/** A box around everything: merge and delete act on the whole cloud. */
export const WHOLE_CLOUD: PendingDeleteRegion = {
  kind: 'box', min: [-1e30, -1e30, -1e30], max: [1e30, 1e30, 1e30],
};

/**
 * The naming the column already uses — "Tree 3", "Tree 7" → "Tree" — so a new
 * instance reads like its siblings. The most common "<prefix> <number>" wins;
 * with none, "Instance".
 */
export function instancePrefix(palette: ClassPalette): string {
  const tally = new Map<string, number>();
  for (const c of palette.classes) {
    if (c.value === UNCLASSIFIED_VALUE) continue;
    const m = /^(.*\S)\s+\d+$/.exec(c.label.trim());
    if (m) tally.set(m[1], (tally.get(m[1]) ?? 0) + 1);
  }
  let best = 'Instance';
  let n = 0;
  for (const [p, k] of tally) if (k > n) { best = p; n = k; }
  return best;
}

/**
 * Add the next free instance id: one past the highest id in use (so a
 * segmentation's numbering continues rather than jumping to the class band),
 * named like its siblings, in the same per-id colour the viewer uses for
 * `tree_instance`.
 */
export function withNewInstance(palette: ClassPalette): { palette: ClassPalette; value: number } {
  const top = palette.classes.reduce((m, c) => Math.max(m, c.value), 0);
  const value = nextFreeClassValue(palette, top + 1);
  const label = `${instancePrefix(palette)} ${value}`;
  return {
    value,
    palette: {
      ...palette,
      classes: [...palette.classes, { value, label, color: treeInstanceColor(value) }],
      updatedAt: Date.now(),
    },
  };
}
