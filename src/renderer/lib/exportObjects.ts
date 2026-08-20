// Selection rules for the Export window's object list.
//
// The list shows EVERY point cloud in the scene (not just the ones selected in
// the Scans panel, and not just the ones carrying scanner parameters), so three
// rules have to be right and they are all easy to get subtly wrong in a
// component:
//
//   * which rows the CURRENT output mode can actually write (a Helios XML needs
//     a scanner origin + angular sweep; PTX needs a complete raster grid),
//   * what starts checked when the window opens,
//   * and how a user's checkmarks survive toggling between output modes.
//
// They live here as pure functions so they're unit-testable (src/renderer/lib is
// the covered pure-logic surface; components are covered by E2E instead).

/** The output the user has chosen, which is what decides row eligibility. */
export interface ExportMode {
  /** Helios XML bundle (+ per-scan .xyz) rather than plain data files. */
  writeXml: boolean;
  /** Per-object data format when `writeXml` is false (las/laz/ply/xyz/...). */
  dataFormat: string;
}

/** One row of the Export window's object list. */
export interface ExportObjectItem {
  id: string;
  name: string;
  pointCount: number;
  /** Carries sky/miss points (drives the "misses" row badge + include-misses). */
  hasMisses: boolean;
  /** Selected in the Scans panel. Seeds the INITIAL check state and nothing else. */
  selected: boolean;
  /** Carries scanner parameters, so it can be written as a scan (XML / PTX). */
  isScan: boolean;
  /** Why this object cannot be written to a Helios XML bundle (undefined = it can). */
  xmlBlockedReason?: string;
  /** Why this object cannot be written as PTX (undefined = it can). */
  ptxBlockedReason?: string;
}

/**
 * Why the current mode cannot write this object, or undefined when it can.
 *
 * Only two formats need more than points: the Helios XML bundle (scanner origin
 * + angular sweep) and PTX (a complete Ntheta x Nphi raster). Everything else —
 * las/laz/ply/xyz/csv/txt/obj/e57 — is just points and columns, so a plain
 * imported cloud with no scanner parameters is perfectly exportable there.
 */
export function blockedReason(
  item: ExportObjectItem, mode: ExportMode,
): string | undefined {
  if (mode.writeXml) return item.xmlBlockedReason;
  if (mode.dataFormat === 'ptx') return item.ptxBlockedReason;
  return undefined;
}

/** Ids of the rows the current mode can write. */
export function selectableIds(
  items: ExportObjectItem[], mode: ExportMode,
): Set<string> {
  return new Set(items.filter(i => !blockedReason(i, mode)).map(i => i.id));
}

/**
 * What starts checked when the Export window opens.
 *
 * The Scans-panel selection is the starting point, not a filter — every object
 * is listed either way. Three cases:
 *
 *   * clouds are selected in the panel  → check exactly those,
 *   * a mesh/skeleton is what's selected → check NOTHING (the user is looking at
 *     something else entirely; arming a whole-scene export off that would be a
 *     nasty surprise now that every cloud is listed),
 *   * nothing at all is selected        → check everything (the long-standing
 *     "just export the scene" convenience).
 */
export function seedCheckedIds(
  items: ExportObjectItem[], sceneSelectionHasNonCloud: boolean,
): Set<string> {
  const seeded = items.filter(i => i.selected).map(i => i.id);
  if (seeded.length) return new Set(seeded);
  if (sceneSelectionHasNonCloud) return new Set();
  return new Set(items.map(i => i.id));
}

/**
 * The ids that will actually be exported: the user's checkmarks minus anything
 * the current mode can't write. Order follows `items`, so the per-object file
 * suffixes (`<base>_0`, `_1`, ...) match the order the list shows.
 */
export function effectiveCheckedIds(
  items: ExportObjectItem[], checked: Set<string>, mode: ExportMode,
): string[] {
  return items
    .filter(i => checked.has(i.id) && !blockedReason(i, mode))
    .map(i => i.id);
}

/**
 * Fold a change reported by the picker back into the user's checked INTENT.
 *
 * The picker only ever reports the state of the rows it currently shows as
 * enabled, so a naive `setChecked(next)` would silently forget every row the
 * mode had greyed out: check 3 scans + 2 plain clouds, switch to XML (clouds go
 * grey), switch back — and the clouds would be gone. Re-adding the previously
 * checked ids that aren't currently selectable keeps the toggle non-destructive.
 */
export function mergeCheckedIntent(
  prev: Set<string>, next: Set<string>, selectable: Set<string>,
): Set<string> {
  const merged = new Set(next);
  for (const id of prev) if (!selectable.has(id)) merged.add(id);
  return merged;
}

/** Row sub-line: point count plus the sky/miss badge when the object has them. */
export function objectDetailLine(item: ExportObjectItem): string {
  const pts = `${item.pointCount.toLocaleString()} pts`;
  return item.hasMisses ? `${pts} · misses` : pts;
}
