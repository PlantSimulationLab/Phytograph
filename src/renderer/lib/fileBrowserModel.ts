// Pure model for the in-app file browser (File -> Import): which files each
// import type offers, sorting, breadcrumbs, selection, and the rule that turns
// ONE set of edited import options into a result for every selected file.
//
// Kept free of React and IPC so every rule here is unit-tested
// (fileBrowserModel.test.ts); FileBrowserDialog only wires it to the DOM.

import type { BrowserEntry } from '../../shared/ipc';
import type { PointCloudPreviewResponse } from '../utils/backendApi';
import { MESH_FORMATS, POINT_CLOUD_FORMATS, SKELETON_FORMATS } from './pointCloudParsers';
import { metersPerUnit } from './units';
import {
  applyPreview,
  blankScanConfig,
  hasXYZ,
  layoutSignature,
  propagateSettings,
  toWizardResult,
  withPreviewError,
  type ScanConfig,
  type WizardResult,
} from './pointCloudImportOptions';

// Mirrors App.tsx's ImportType (the File -> Import submenu).
export type BrowserImportType = 'auto' | 'pointcloud' | 'mesh' | 'skeleton' | 'scanxml' | 'qsm';

const strip = (fmts: { ext: string }[]) => fmts.map((f) => f.ext.replace(/^\./, ''));
export const POINT_CLOUD_EXTS = strip(POINT_CLOUD_FORMATS);
export const MESH_EXTS = strip(MESH_FORMATS);
export const SKELETON_EXTS = strip(SKELETON_FORMATS);

/** Extensions File -> Import offers for each type (lower-case, no dot). */
export function extensionsFor(type: BrowserImportType): string[] {
  switch (type) {
    case 'pointcloud': return POINT_CLOUD_EXTS;
    case 'mesh': return MESH_EXTS;
    case 'skeleton': return SKELETON_EXTS;
    case 'scanxml': return ['xml'];
    case 'qsm': return ['csv'];
    default: return [...new Set([...POINT_CLOUD_EXTS, ...MESH_EXTS, ...SKELETON_EXTS, 'xml'])];
  }
}

export const IMPORT_TITLES: Record<BrowserImportType, string> = {
  auto: 'Import',
  pointcloud: 'Import point cloud',
  mesh: 'Import mesh',
  skeleton: 'Import skeleton',
  scanxml: 'Import Helios scan XML',
  qsm: 'Import QSM',
};

export const FILTER_LABELS: Record<BrowserImportType, string> = {
  auto: 'All supported files',
  pointcloud: 'Point clouds',
  mesh: 'Meshes',
  skeleton: 'Skeletons',
  scanxml: 'Helios scan XML',
  qsm: 'QSM CSV',
};

/**
 * Does this file get the point-cloud import options? Only for the two import
 * types that route point clouds. In 'auto', a .ply may still turn out to be a
 * mesh (the importer checks for faces) — its options are then simply unused.
 */
export function takesPointCloudOptions(ext: string, type: BrowserImportType): boolean {
  return (type === 'pointcloud' || type === 'auto') && POINT_CLOUD_EXTS.includes(ext.toLowerCase());
}

/** What a file will import as, for the info panel. */
export function describeKind(ext: string, type: BrowserImportType): string {
  const e = ext.toLowerCase();
  if (type === 'qsm') return 'QSM cylinder table';
  if (type === 'scanxml' || (type === 'auto' && e === 'xml')) return 'Helios scan XML';
  if (type === 'skeleton' || (type === 'auto' && SKELETON_EXTS.includes(e))) return 'Skeleton';
  if (type === 'mesh' || (type === 'auto' && (e === 'obj' || e === 'stl'))) return 'Mesh';
  if (e === 'ply' && type === 'auto') return 'Point cloud or mesh (PLY with faces imports as a mesh)';
  if (POINT_CLOUD_EXTS.includes(e)) return 'Point cloud';
  return 'File';
}

// ─── Listing view ──────────────────────────────────────────────────────────

export type SortKey = 'name' | 'size' | 'mtime';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Folders first, then by `key`. Names compare naturally (scan2 < scan10). */
export function sortEntries(entries: BrowserEntry[], key: SortKey, desc = false): BrowserEntry[] {
  const sign = desc ? -1 : 1;
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    let cmp = 0;
    if (key === 'size') cmp = a.size - b.size;
    else if (key === 'mtime') cmp = a.mtimeMs - b.mtimeMs;
    if (cmp === 0) cmp = collator.compare(a.name, b.name);
    return cmp * sign;
  });
}

/**
 * Entries to show. Folders are always offered (you have to be able to walk
 * into them); files only when their extension is in `exts` (null = all files).
 * `query` narrows both by a case-insensitive substring of the name.
 */
export function filterEntries(entries: BrowserEntry[], exts: string[] | null, query: string): BrowserEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => {
    if (q && !e.name.toLowerCase().includes(q)) return false;
    if (e.kind === 'dir') return true;
    return exts === null || exts.includes(e.ext);
  });
}

export interface Crumb { label: string; path: string }

/** Breadcrumbs for an absolute path, POSIX, Windows drive, or UNC. */
export function splitPath(path: string, sep: string): Crumb[] {
  if (sep === '\\') {
    const p = path.replace(/\//g, '\\');
    let root: string;
    let rest: string;
    const unc = /^(\\\\[^\\]+\\[^\\]+)(\\.*)?$/.exec(p);
    if (unc) {
      root = unc[1];
      rest = unc[2] ?? '';
    } else {
      const drive = /^([A-Za-z]:)(\\.*)?$/.exec(p);
      if (!drive) return [{ label: p, path: p }];
      root = drive[1];
      rest = drive[2] ?? '';
    }
    const crumbs: Crumb[] = [{ label: root, path: `${root}\\` }];
    let acc = root;
    for (const part of rest.split('\\').filter(Boolean)) {
      acc = `${acc}\\${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }
  const crumbs: Crumb[] = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of path.split('/').filter(Boolean)) {
    acc = `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/**
 * Normalize what the user typed or pasted into the path bar: strip wrapping
 * quotes (Finder's "Copy as Pathname" and Windows' "Copy as path" add them)
 * and expand a leading `~` to home.
 */
export function normalizePathInput(raw: string, home: string, sep: string): string {
  let p = raw.trim();
  if (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
    p = p.slice(1, -1).trim();
  }
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return `${home}${sep}${p.slice(2)}`;
  return p;
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * A path typed into the path bar, made absolute: a relative one ("scans",
 * "../plot2") is taken relative to the folder on screen, as a file manager
 * would. Without this the main process resolves it against its own working
 * directory, which is meaningless to the user.
 */
export function resolveAgainst(p: string, cwd: string, sep: string): string {
  if (!p || isAbsolutePath(p) || !cwd) return p;
  return cwd.endsWith(sep) ? `${cwd}${p}` : `${cwd}${sep}${p}`;
}

/** Split a path into its parent folder and final name. */
export function splitParent(path: string, sep: string): { dir: string; name: string } {
  const p = sep === '\\' ? path.replace(/\//g, '\\') : path;
  const trimmed = p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf(sep);
  if (i < 0) return { dir: '', name: trimmed };
  const dir = trimmed.slice(0, i);
  // Keep the root's separator: '/x' -> '/', 'C:\x' -> 'C:\'.
  if (dir === '') return { dir: sep, name: trimmed.slice(i + 1) };
  if (sep === '\\' && /^[A-Za-z]:$/.test(dir)) return { dir: `${dir}\\`, name: trimmed.slice(i + 1) };
  return { dir, name: trimmed.slice(i + 1) };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

// ─── Selection ─────────────────────────────────────────────────────────────

export interface Selection {
  selected: string[];      // paths, in the order they were added
  anchor: string | null;   // shift-range origin
  focus: string | null;    // keyboard cursor
}

export const EMPTY_SELECTION: Selection = { selected: [], anchor: null, focus: null };

/**
 * Apply a click (or a keyboard move, which is a click on the next row) to the
 * selection. Plain = just this one; toggle (cmd/ctrl) = add/remove; range
 * (shift) = everything between the anchor and this row, in view order.
 */
export function clickSelect(
  sel: Selection,
  view: BrowserEntry[],
  path: string,
  mods: { toggle?: boolean; range?: boolean } = {},
): Selection {
  if (mods.range && sel.anchor) {
    const a = view.findIndex((e) => e.path === sel.anchor);
    const b = view.findIndex((e) => e.path === path);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      // The anchor stays FIRST: the first selected file is the one whose
      // options the panel shows, and shift-clicking upward must not hand
      // that role to a file the user never clicked.
      const inView = view.slice(lo, hi + 1).map((e) => e.path);
      const range = [sel.anchor, ...inView.filter((p) => p !== sel.anchor)];
      const selected = mods.toggle ? [...new Set([...sel.selected, ...range])] : range;
      return { selected, anchor: sel.anchor, focus: path };
    }
  }
  if (mods.toggle) {
    const has = sel.selected.includes(path);
    return {
      selected: has ? sel.selected.filter((p) => p !== path) : [...sel.selected, path],
      anchor: path,
      focus: path,
    };
  }
  return { selected: [path], anchor: path, focus: path };
}

/** Move the keyboard cursor by `delta` rows (shift extends the range). */
export function moveSelect(sel: Selection, view: BrowserEntry[], delta: number, range = false): Selection {
  if (view.length === 0) return sel;
  const cur = sel.focus ? view.findIndex((e) => e.path === sel.focus) : -1;
  const next = cur < 0
    ? (delta > 0 ? 0 : view.length - 1)
    : Math.max(0, Math.min(view.length - 1, cur + delta));
  return clickSelect(sel, view, view[next].path, { range });
}

export function selectAllFiles(view: BrowserEntry[]): Selection {
  const files = view.filter((e) => e.kind === 'file').map((e) => e.path);
  return { selected: files, anchor: files[0] ?? null, focus: files[files.length - 1] ?? null };
}

/** Drop selected paths that are no longer in view (after a filter change). */
export function pruneSelection(sel: Selection, view: BrowserEntry[]): Selection {
  const inView = new Set(view.map((e) => e.path));
  const selected = sel.selected.filter((p) => inView.has(p));
  if (selected.length === sel.selected.length) return sel;
  return {
    selected,
    anchor: sel.anchor && inView.has(sel.anchor) ? sel.anchor : null,
    focus: sel.focus && inView.has(sel.focus) ? sel.focus : null,
  };
}

/**
 * Type-ahead: the first entry at or after `from` whose name starts with
 * `prefix` (wrapping), or -1.
 */
export function typeAheadIndex(view: BrowserEntry[], prefix: string, from: number): number {
  const p = prefix.toLowerCase();
  if (!p || view.length === 0) return -1;
  for (let k = 0; k < view.length; k++) {
    const i = (Math.max(0, from) + k) % view.length;
    if (view[i].name.toLowerCase().startsWith(p)) return i;
  }
  return -1;
}

// ─── One set of options for the whole selection ────────────────────────────

export type PreviewState =
  | { status: 'loading' }
  | { status: 'ok'; preview: PointCloudPreviewResponse }
  // `transient`: the backend was unreachable or timed out, so the failure says
  // nothing about the file and the preview will be retried.
  | { status: 'error'; message: string; transient?: boolean };

// An edit to the import options, as a pure transform. Every edit belongs to
// the file that was the primary when it was made (the dialog keys them by
// path): 'column' edits address columns by index, so they only mean something
// for that file; 'global' edits (units, shift, RGB scale, trajectory) are the
// batch settings chosen while looking at it. Keying both by file keeps a unit
// chosen for one file from being replayed onto the next one clicked, which
// would override a unit that file declares itself.
export interface BrowserEdit {
  scope: 'column' | 'global';
  fn: (c: ScanConfig) => ScanConfig;
}

export interface Batch {
  // One config per selected point-cloud path, in selection order. configs[0]
  // is the PRIMARY: the file whose preview the options panel shows and edits.
  configs: ScanConfig[];
  // How many OTHER files share the primary's column layout (they get its
  // column choices) and how many do not (they keep their own columns).
  sameLayout: number;
  ownLayout: number;
  loading: boolean;
  // Every preview finished and every file has X/Y/Z.
  ready: boolean;
  // Indices of files whose previews finished but that still lack X/Y/Z, so
  // the dialog can name them instead of just disabling Import.
  unready: number[];
}

// The batch-level settings a file with a DIFFERENT layout still takes from
// the primary: they describe the import, not the file's columns.
function carryGlobals(src: ScanConfig, target: ScanConfig): ScanConfig {
  return {
    ...target,
    // One frame for everything imported together (see propagateSettings).
    shiftEnabled: src.shiftEnabled,
    shift: { ...src.shift },
    shiftTouched: true,
    // A unit the file itself declared is a fact and wins; otherwise inherit.
    ...(target.unitsCertain ? {} : { units: src.units, unitsTouched: true }),
    trajectory: src.trajectory,
    trajectoryExplicit: false,
    trajectoryError: null,
  };
}

/**
 * Every selected file's config from its preview, in ONE pass, with the
 * batch's shared global-shift suggestion applied.
 *
 * Same rule as the wizard's `applyPreview` (smallest suggestion across the
 * batch, each converted to meters by its own file's unit, shared only when
 * the resolved files agree on a unit), but computed once rather than by
 * folding applyPreview over the batch: that fold re-maps the whole batch per
 * file, which is quadratic, and a Select All on a folder of a thousand scans
 * made the dialog crawl. When units disagree, each file keeps its own
 * suggestion; the primary's is the one the batch then carries.
 */
export function seedBatch(paths: string[], previews: ReadonlyMap<string, PreviewState>): ScanConfig[] {
  const configs = paths.map((p) => {
    const st = previews.get(p);
    if (st?.status === 'ok') return applyPreview([blankScanConfig()], 0, st.preview)[0];
    if (st?.status === 'error') return withPreviewError(blankScanConfig(), st.message);
    return blankScanConfig();
  });
  const resolved = configs.filter((c) => c.preview !== null);
  if (resolved.length === 0 || !resolved.every((c) => c.units === resolved[0].units)) return configs;
  let shared: [number, number] | null = null;
  for (const c of resolved) {
    const s = c.preview?.suggested_shift;
    if (!s) continue;
    const f = metersPerUnit(c.units) ?? 1;
    const m: [number, number] = [Math.floor(s[0] * f), Math.floor(s[1] * f)];
    shared = shared ? [Math.min(shared[0], m[0]), Math.min(shared[1], m[1])] : m;
  }
  if (!shared) return configs;
  const [x, y] = shared;
  return configs.map((c) => (c.loading ? c : { ...c, shiftEnabled: true, shift: { x, y, z: 0 } }));
}

/**
 * Build every selected file's config from the previews and the user's edits.
 *
 * The browser's rule is ONE set of options for the selection: the options
 * shown are the primary file's, and
 *  - a file with the primary's column layout gets all of them
 *    (`propagateSettings`, the wizard's own apply-to-all rule);
 *  - a file with a different layout keeps its own columns — detected, plus
 *    any column edits the user made while it was the primary — and takes the
 *    batch settings (shift, units unless the file declared its own,
 *    trajectory).
 */
export function buildBatch(
  paths: string[],
  previews: ReadonlyMap<string, PreviewState>,
  editsFor: (path: string) => readonly BrowserEdit[],
): Batch {
  const configs = seedBatch(paths, previews);
  if (configs.length === 0) {
    return { configs, sameLayout: 0, ownLayout: 0, loading: false, ready: false, unready: [] };
  }
  const apply = (c: ScanConfig, edits: readonly BrowserEdit[]) => edits.reduce((a, e) => e.fn(a), c);
  const primary = configs[0].loading ? configs[0] : apply(configs[0], editsFor(paths[0]));
  const primarySig = layoutSignature(primary);
  let sameLayout = 0;
  let ownLayout = 0;
  const out = configs.map((c, i) => {
    if (i === 0) return primary;
    if (c.loading || primary.loading) return c;
    const same = primarySig !== null ? propagateSettings(primary, c) : null;
    if (same) {
      sameLayout++;
      return same;
    }
    ownLayout++;
    const own = apply(c, editsFor(paths[i]).filter((e) => e.scope === 'column'));
    return carryGlobals(primary, own);
  });
  const loading = out.some((c) => c.loading);
  const unready = out.flatMap((c, i) => (!c.loading && !hasXYZ(c) ? [i] : []));
  return { configs: out, sameLayout, ownLayout, loading, ready: !loading && unready.length === 0, unready };
}

/** The importer's per-file results, keyed by path. */
export function batchResults(paths: string[], configs: ScanConfig[]): Map<string, WizardResult> {
  const out = new Map<string, WizardResult>();
  paths.forEach((path, i) => {
    const fileName = path.split(/[\\/]/).pop() ?? path;
    out.set(path, toWizardResult({ path, fileName }, configs[i]));
  });
  return out;
}
