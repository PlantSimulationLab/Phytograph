// Pure helpers for the selection-aware bulk actions on the right-side object
// panels (Scans, Meshes, Skeletons, QSMs). Each panel's header offers a
// show/hide toggle and a delete that act on the *selection* when one exists,
// and otherwise on the *whole section*. Keeping that decision logic here makes
// it unit-testable independent of the three.js viewer wiring.

/** Minimal shape every list entry shares for visibility bulk actions. */
export interface VisibilityItem {
  id: string;
  visible: boolean;
}

/**
 * Resolve which items a header visibility toggle should affect and what their
 * next visibility should be.
 *
 * Targets are the selected items when the selection is non-empty, otherwise
 * every item in the section. The toggle hides everything when ANY target is
 * currently visible, and shows everything only when all targets are hidden —
 * so a single press always lands on a uniform state.
 */
export function resolveTargets<T extends VisibilityItem>(
  items: T[],
  selectedIds: Set<string>,
): { targetIds: string[]; nextVisible: boolean } {
  const targets = selectedIds.size > 0 ? items.filter(i => selectedIds.has(i.id)) : items;
  const anyVisible = targets.some(t => t.visible);
  return { targetIds: targets.map(t => t.id), nextVisible: !anyVisible };
}

/** True when at least one of the bulk targets is currently visible. */
export function anyTargetVisible<T extends VisibilityItem>(
  items: T[],
  selectedIds: Set<string>,
): boolean {
  const targets = selectedIds.size > 0 ? items.filter(i => selectedIds.has(i.id)) : items;
  return targets.some(t => t.visible);
}

/**
 * Resolve which item ids a header delete should remove: the selection when
 * non-empty, otherwise every item in the section.
 */
export function resolveDeleteIds<T extends { id: string }>(
  items: T[],
  selectedIds: Set<string>,
): string[] {
  return selectedIds.size > 0
    ? items.filter(i => selectedIds.has(i.id)).map(i => i.id)
    : items.map(i => i.id);
}

/**
 * Build the label for the delete-confirmation dialog. A single target uses its
 * own name (quoted by the dialog); a batch uses a count plus the plural noun,
 * e.g. "3 scans". `pluralNoun` is passed already pluralised by the caller so we
 * don't have to reason about English pluralisation here.
 */
export function buildDeleteLabel(ids: string[], singleName: string, pluralNoun: string): string {
  if (ids.length === 1) return singleName;
  return `${ids.length} ${pluralNoun}`;
}
