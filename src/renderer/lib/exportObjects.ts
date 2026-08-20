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
 * the current mode can't write. Order follows `items`, so the backend's
 * per-object file names (`<base>_<object name>`) follow the order the list
 * shows.
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

// ---------------------------------------------------------------------------
// Output file names.
//
// The batch export writes MANY files from ONE name the user gives, so the window
// has to show which files those are before anything is written. These functions
// mirror `_scan_label_slug` / `_scan_export_stems` in backend-api/main.py, which
// is what actually names the files — the shared case table lives in
// exportObjects.test.ts and backend-api/tests/test_scan_export.py, so a drift in
// either copy fails a test on both sides rather than quietly showing the user a
// preview that doesn't match what lands on disk.
// ---------------------------------------------------------------------------

const LABEL_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
const UNSAFE_RUN = /[^A-Za-z0-9._-]+/g;
const EDGE_PUNCTUATION = /^[._]+|[._]+$/g;

/** An object's name as a file-name fragment; the index when nothing survives. */
export function objectFileSlug(label: string, index: number): string {
  const raw = label.trim().replace(LABEL_EXTENSION, '');
  const slug = raw.replace(UNSAFE_RUN, '_')
    .replace(EDGE_PUNCTUATION, '')
    .slice(0, 64)
    .replace(EDGE_PUNCTUATION, '');
  return slug || String(index);
}

/**
 * The typed base name as the backend will read it: `os.path.basename` minus one
 * extension, falling back to "scans". Users paste paths and type "myscan.laz"
 * into the field, and neither should leak into the written names.
 */
export function exportBaseName(raw: string): string {
  const tail = raw.trim().split(/[\\/]/).pop() ?? '';
  return tail.replace(LABEL_EXTENSION, '').trim() || 'scans';
}

/**
 * Every file the current settings will write, in write order.
 *
 * One object takes the base name alone — the export writes exactly what was
 * typed. Several get `<base>_<object name>`, deduped case-insensitively because
 * macOS and Windows would otherwise let two objects overwrite one file. An XML
 * bundle additionally writes `<base>.xml` (listed first, as the backend does).
 */
export function plannedFileNames(
  objectNames: string[], rawBase: string, ext: string, writeXml = false,
): string[] {
  const base = exportBaseName(rawBase);
  const stems = objectNames.length === 1
    ? [base]
    : objectNames.reduce<string[]>((acc, name, i) => {
      const stem = `${base}_${objectFileSlug(name, i)}`;
      let candidate = stem;
      for (let n = 2; acc.some(s => s.toLowerCase() === candidate.toLowerCase()); n++) {
        candidate = `${stem}_${n}`;
      }
      acc.push(candidate);
      return acc;
    }, []);
  const dataFiles = stems.map(s => `${s}.${ext}`);
  return writeXml ? [`${base}.xml`, ...dataFiles] : dataFiles;
}
