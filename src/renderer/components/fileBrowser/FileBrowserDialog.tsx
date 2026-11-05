import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowUp, ChevronLeft, ChevronRight, Clock, Cloud,
  File as FileIcon, Folder, HardDrive, House, Monitor, Search, X,
} from 'lucide-react';
import type { BrowserEntry, BrowserPlace, BrowserPlaces, ListDirResult } from '../../../shared/ipc';
import { PointCloudImportOptions } from '../PointCloudImportOptions';
import { showToast } from '../Toast';
import { pickAndParseTrajectory } from '../../lib/trajectoryImport';
import { PoseStreamParseError } from '../../lib/poseStream';
import type { ScanConfig, WizardResult } from '../../lib/pointCloudImportOptions';
import { useScanPreviews } from '../../hooks/useScanPreviews';
import {
  EMPTY_SELECTION,
  FILTER_LABELS,
  IMPORT_TITLES,
  batchResults,
  buildBatch,
  clickSelect,
  describeKind,
  extensionsFor,
  filterEntries,
  formatSize,
  moveSelect,
  normalizePathInput,
  pruneSelection,
  resolveAgainst,
  selectAllFiles,
  sortEntries,
  splitParent,
  splitPath,
  takesPointCloudOptions,
  typeAheadIndex,
  type BrowserEdit,
  type BrowserImportType,
  type Selection,
  type SortKey,
} from '../../lib/fileBrowserModel';

// File -> Import: browse on the left, set import options on the right, in one
// window (the Blender importer layout). Replaces the OS open dialog for every
// File -> Import item; drag-drop, Open-With, Helios XML's referenced scans and
// RIEGL projects still use the modal PointCloudImportWizard, which renders the
// same PointCloudImportOptions.
//
// Selecting several point clouds edits ONE set of options for all of them (see
// buildBatch). The fs bridge only reads a path once main has granted it, and
// main grants only listed files in importable formats outside hidden folders,
// read-only (src/main/fileBrowser.ts says what that does and doesn't bound).

export interface FileBrowserResult {
  paths: string[];
  dir: string;
  // Options chosen here, per point-cloud path, so the import skips the wizard.
  wizardResults: Map<string, WizardResult>;
}

// A native-menu command (src/main/menu.ts) arriving while the browser is open.
// The browser is in-page rather than an OS-modal window, so the menu and its
// accelerators stay live behind it; App hands every command here instead of
// running it, and this answers the ones that mean something in the browser.
export type BrowserMenuHandler = (kind: string) => void;

interface FileBrowserDialogProps {
  importType: BrowserImportType;
  // Filled in by the dialog while it is mounted.
  menuHandlerRef?: React.MutableRefObject<BrowserMenuHandler | null>;
  initialDir: string | null;
  recentDirs: string[];
  onCancel: () => void;
  onImport: (result: FileBrowserResult) => void;
}

const ROW_H = 28;
const OVERSCAN = 8;

type Edit = BrowserEdit & { path: string };

const PLACEHOLDER_REASON =
  'this file is stored online only (a cloud-storage placeholder), so it was not read; '
  + 'it will download when imported';

function placeIcon(p: BrowserPlace) {
  if (p.kind === 'home') return <House className="w-3.5 h-3.5" />;
  if (p.kind === 'volume') return <HardDrive className="w-3.5 h-3.5" />;
  if (p.kind === 'root') return <Monitor className="w-3.5 h-3.5" />;
  return <Folder className="w-3.5 h-3.5" />;
}

function formatDate(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function FileBrowserDialog({
  importType, initialDir, recentDirs, onCancel, onImport, menuHandlerRef,
}: FileBrowserDialogProps) {
  const api = window.electronAPI;
  const [places, setPlaces] = useState<BrowserPlaces | null>(null);
  const [listing, setListing] = useState<ListDirResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] });
  const [pathDraft, setPathDraft] = useState('');
  const [query, setQuery] = useState('');
  const [allFiles, setAllFiles] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
  // Every edit, tagged with the file that was primary when it was made (see
  // BrowserEdit): a file's column mappings and batch settings come back when
  // it is primary again, and never leak onto another file.
  const [edits, setEdits] = useState<Edit[]>([]);
  const [importing, setImporting] = useState(false);
  // Enter / double-click asks to import THIS selection once its previews
  // land. Holding the selection's key (not a flag) means changing the
  // selection or the folder in the meantime cancels the request.
  const [armedFor, setArmedFor] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(400);
  const typeAhead = useRef({ text: '', at: 0 });
  const navSeq = useRef(0);
  // Where the user IS: the folder of the latest navigation, set when it
  // STARTS (not when its listing lands). History is a ref for the same reason:
  // two quick clicks on Back must see each other, and React state from one
  // render would hand both the same entry.
  const locRef = useRef('');
  const historyRef = useRef<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] });
  const commitHistory = (h: { back: string[]; fwd: string[] }) => {
    historyRef.current = h;
    setHistory(h);
  };
  const pathInputRef = useRef<HTMLInputElement>(null);

  const sep = listing?.sep ?? places?.sep ?? '/';
  const dir = listing?.dir ?? '';
  const entries = useMemo(() => (listing?.ok ? listing.entries : []), [listing]);

  // ── navigation ──────────────────────────────────────────────────────────
  const navigate = useCallback(async (
    target: string,
    opts: {
      push?: boolean; select?: string; fileFallback?: boolean; fromPathBar?: boolean; homeFallback?: boolean;
    } = {},
  ) => {
    if (!api?.fileBrowser) return;
    const seq = ++navSeq.current;
    if (opts.push !== false && locRef.current && locRef.current !== target) {
      commitHistory({ back: [...historyRef.current.back, locRef.current], fwd: [] });
    }
    locRef.current = target;
    setBusy(true);
    setArmedFor(null);
    let res: ListDirResult;
    let select = opts.select;
    try {
      res = await api.fileBrowser.listDir(target);
      // A typed or pasted FILE path opens its folder with the file selected.
      if (!res.ok && res.code === 'ENOTDIR' && opts.fileFallback) {
        const { dir: parent, name } = splitParent(res.dir, res.sep);
        res = await api.fileBrowser.listDir(parent);
        select = name;
      }
      // A remembered start folder that has since been deleted or unmounted
      // opens home instead of an error.
      if (!res.ok && opts.homeFallback) res = await api.fileBrowser.listDir('');
    } catch (err) {
      if (seq === navSeq.current) {
        setBusy(false);
        showToast({ title: `Couldn't open folder: ${err instanceof Error ? err.message : String(err)}`, type: 'error' });
      }
      return;
    }
    if (seq !== navSeq.current) return; // a later navigation won
    setBusy(false);
    locRef.current = res.dir; // the resolved spelling (a typed file -> its folder)
    setListing(res);
    // Don't overwrite what the user is typing in the path bar: a listing that
    // lands mid-edit (the start-up one, most often) would clobber it.
    if (opts.fromPathBar || document.activeElement !== pathInputRef.current) setPathDraft(res.dir);
    setQuery('');
    const hit = select && res.ok ? res.entries.find((e) => e.name === select) : undefined;
    setSel(hit ? { selected: [hit.path], anchor: hit.path, focus: hit.path } : EMPTY_SELECTION);
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [api]);

  // Open on the start folder straight away; the places list loads alongside.
  // It must not gate the listing: finding mounted volumes and drives can be
  // slow (a dead network share), and the user came here for the folder.
  // ('' lists home.)
  useEffect(() => {
    let alive = true;
    void navigate(initialDir ?? '', { push: false, homeFallback: true });
    void api?.fileBrowser?.listPlaces().then((pl) => { if (alive) setPlaces(pl); }, () => {});
    return () => { alive = false; };
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goBack = () => {
    const h = historyRef.current;
    const prev = h.back[h.back.length - 1];
    if (!prev) return;
    commitHistory({ back: h.back.slice(0, -1), fwd: [locRef.current, ...h.fwd] });
    void navigate(prev, { push: false });
  };
  const goForward = () => {
    const h = historyRef.current;
    const next = h.fwd[0];
    if (!next) return;
    commitHistory({ back: [...h.back, locRef.current], fwd: h.fwd.slice(1) });
    void navigate(next, { push: false });
  };
  const goUp = () => {
    if (!listing?.parent) return;
    const from = splitParent(dir, sep).name;
    void navigate(listing.parent, { select: from });
  };

  // ── view ────────────────────────────────────────────────────────────────
  const exts = useMemo(() => (allFiles ? null : extensionsFor(importType)), [allFiles, importType]);
  const view = useMemo(
    () => sortEntries(filterEntries(entries, exts, query), sort.key, sort.desc),
    [entries, exts, query, sort],
  );
  const byPath = useMemo(() => new Map(entries.map((e) => [e.path, e])), [entries]);

  useEffect(() => { setSel((s) => pruneSelection(s, view)); }, [view]);

  const selectedFiles = useMemo(
    () => sel.selected.map((p) => byPath.get(p)).filter((e): e is BrowserEntry => !!e && e.kind === 'file'),
    [sel.selected, byPath],
  );
  const pcPaths = useMemo(
    () => selectedFiles.filter((e) => takesPointCloudOptions(e.ext, importType)).map((e) => e.path),
    [selectedFiles, importType],
  );
  const primary = pcPaths[0] ?? null;

  const skip = useCallback((p: string) => (byPath.get(p)?.placeholder ? PLACEHOLDER_REASON : null), [byPath]);
  const { previews, version } = useScanPreviews(pcPaths, skip);
  // Memoized: the dialog re-renders on every scroll frame, and a selection
  // can be a whole folder of scans.
  const batch = useMemo(() => {
    const byFile = new Map<string, Edit[]>();
    for (const e of edits) {
      const list = byFile.get(e.path);
      if (list) list.push(e); else byFile.set(e.path, [e]);
    }
    return buildBatch(pcPaths, previews, (p) => byFile.get(p) ?? []);
    // `version` stands for the contents of the long-lived `previews` map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pcPaths, version, edits]);

  const canImport = selectedFiles.length > 0 && (pcPaths.length === 0 || batch.ready) && !importing;

  const onEdit = useCallback((fn: (c: ScanConfig) => ScanConfig, scope: 'column' | 'global') => {
    if (!primary) return;
    setEdits((prev) => [...prev, { scope, fn, path: primary }]);
  }, [primary]);

  const importTrajectory = useCallback(async () => {
    try {
      const stream = await pickAndParseTrajectory();
      if (!stream) return;
      onEdit((c) => ({ ...c, trajectory: stream, trajectoryExplicit: true, trajectoryError: null }), 'global');
    } catch (err) {
      const msg = err instanceof PoseStreamParseError || err instanceof Error ? err.message : String(err);
      onEdit((c) => ({ ...c, trajectoryError: msg }), 'global');
    }
  }, [onEdit]);

  // ── import ──────────────────────────────────────────────────────────────
  const doImport = useCallback(async () => {
    if (!canImport || !api?.fileBrowser) return;
    setImporting(true);
    const paths = selectedFiles.map((e) => e.path);
    const { refused } = await api.fileBrowser.grant(paths);
    if (refused.length > 0) {
      setImporting(false);
      showToast({ title: `Couldn't open ${refused.length} file(s); browse to the folder again and retry.`, type: 'error' });
      return;
    }
    onImport({ paths, dir, wizardResults: batchResults(pcPaths, batch.configs) });
  }, [canImport, api, selectedFiles, onImport, dir, pcPaths, batch.configs]);

  // Enter / double-click on a file asks to import; it happens as soon as the
  // previews it needs have landed.
  // If the previews land and the selection still can't import (no X/Y/Z),
  // the request is dropped rather than left armed: otherwise finishing the
  // column mapping later would import without the user asking again.
  const selKey = sel.selected.join('\n');
  const blocked = pcPaths.length > 0 && !batch.loading && !batch.ready;
  useEffect(() => {
    if (armedFor === null) return;
    if (armedFor !== selKey) {
      setArmedFor(null); // the selection changed; that is not a request to import it
    } else if (canImport) {
      setArmedFor(null);
      void doImport();
    } else if (blocked) {
      setArmedFor(null);
    }
  }, [armedFor, selKey, canImport, blocked, doImport]);

  // Edit → Select All / Deselect All (and their ⌘A / ⇧⌘A accelerators) act on
  // the browser, never on the scene behind it. In a text field, Select All
  // selects its text, as it does anywhere else.
  useEffect(() => {
    if (!menuHandlerRef) return;
    menuHandlerRef.current = (kind) => {
      const active = document.activeElement;
      if (kind === 'select-all') {
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.select();
        else setSel(selectAllFiles(view));
      } else if (kind === 'deselect-all') {
        setSel(EMPTY_SELECTION);
      }
    };
    return () => { menuHandlerRef.current = null; };
  }, [menuHandlerRef, view]);

  // Esc closes, from anywhere in the dialog (capture, as SettingsDialog does).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  // ── list geometry (hand-windowed: folders of thousands of scans exist) ──
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const scrollIntoView = useCallback((path: string | null) => {
    const el = listRef.current;
    if (!el || !path) return;
    const i = view.findIndex((e) => e.path === path);
    if (i < 0) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }, [view]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(view.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);

  const openEntry = (e: BrowserEntry) => {
    if (e.kind === 'dir') {
      void navigate(e.path);
    } else {
      setSel({ selected: [e.path], anchor: e.path, focus: e.path });
      setArmedFor(e.path);
    }
  };

  const onListKey = (ev: React.KeyboardEvent) => {
    const mod = ev.metaKey || ev.ctrlKey;
    let next: Selection | null = null;
    if (ev.key === 'ArrowDown') next = moveSelect(sel, view, 1, ev.shiftKey);
    else if (ev.key === 'ArrowUp' && mod) { ev.preventDefault(); goUp(); return; }
    else if (ev.key === 'ArrowUp') next = moveSelect(sel, view, -1, ev.shiftKey);
    else if (ev.key === 'Home') next = moveSelect(sel, view, -view.length);
    else if (ev.key === 'End') next = moveSelect(sel, view, view.length);
    else if (ev.key === 'Backspace') { ev.preventDefault(); goUp(); return; }
    else if (ev.key === 'a' && mod) next = selectAllFiles(view);
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      const focused = sel.focus ? byPath.get(sel.focus) : undefined;
      if (focused?.kind === 'dir' && sel.selected.length <= 1) void navigate(focused.path);
      else if (selectedFiles.length > 0) setArmedFor(selKey);
      return;
    } else if (ev.key.length === 1 && !mod && !ev.altKey) {
      const now = Date.now();
      const ta = typeAhead.current;
      ta.text = now - ta.at > 700 ? ev.key : ta.text + ev.key;
      ta.at = now;
      // -1 with nothing focused, so the search starts at the FIRST row.
      const cur = sel.focus ? view.findIndex((e) => e.path === sel.focus) : -1;
      const i = typeAheadIndex(view, ta.text, ta.text.length === 1 ? cur + 1 : Math.max(cur, 0));
      if (i >= 0) next = clickSelect(sel, view, view[i].path);
    }
    if (next) {
      ev.preventDefault();
      setSel(next);
      scrollIntoView(next.focus);
    }
  };

  const crumbs = dir ? splitPath(dir, sep) : [];
  const toggleSort = (key: SortKey) => setSort((s) => ({ key, desc: s.key === key ? !s.desc : false }));
  const sortMark = (key: SortKey) => (sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : '');

  const otherFiles = selectedFiles.filter((e) => !takesPointCloudOptions(e.ext, importType));
  const primaryEntry = primary ? byPath.get(primary) : undefined;

  const navBtn = 'p-1.5 rounded text-neutral-300 hover:bg-neutral-700 disabled:opacity-30 disabled:hover:bg-transparent';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        data-testid="file-browser"
        data-dir={dir}
        className="relative flex flex-col bg-neutral-800 rounded-xl shadow-2xl border border-neutral-700 w-[min(1400px,96vw)] h-[88vh] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-neutral-700">
          <h2 className="text-sm font-semibold text-white">{IMPORT_TITLES[importType]}</h2>
          <button onClick={onCancel} className="p-1 rounded hover:bg-neutral-700" title="Cancel (Esc)">
            <X className="w-4 h-4 text-neutral-400" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-neutral-700">
          <button className={navBtn} onClick={goBack} disabled={history.back.length === 0} title="Back" data-testid="file-browser-back">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button className={navBtn} onClick={goForward} disabled={history.fwd.length === 0} title="Forward" data-testid="file-browser-forward">
            <ChevronRight className="w-4 h-4" />
          </button>
          <button className={navBtn} onClick={goUp} disabled={!listing?.parent} title="Up (⌘↑)" data-testid="file-browser-up">
            <ArrowUp className="w-4 h-4" />
          </button>
          <input
            data-testid="file-browser-path"
            ref={pathInputRef}
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const p = resolveAgainst(normalizePathInput(pathDraft, places?.home ?? '', sep), dir, sep);
                if (p) void navigate(p, { fileFallback: true, fromPathBar: true });
              }
            }}
            spellCheck={false}
            aria-label="Folder path"
            className="flex-1 min-w-0 px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-xs text-neutral-100 font-mono focus:outline-none focus:border-blue-500"
          />
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              data-testid="file-browser-filter"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter"
              aria-label="Filter by name"
              className="w-40 pl-7 pr-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-xs text-neutral-100 focus:outline-none focus:border-blue-500"
            />
          </div>
          <select
            data-testid="file-browser-type"
            value={allFiles ? 'all' : 'supported'}
            onChange={(e) => setAllFiles(e.target.value === 'all')}
            className="px-2 py-1 bg-neutral-900 border border-neutral-700 rounded text-xs text-neutral-200 focus:outline-none"
          >
            <option value="supported">{FILTER_LABELS[importType]}</option>
            <option value="all">All files</option>
          </select>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Places */}
          <nav className="w-44 flex-shrink-0 border-r border-neutral-700 overflow-y-auto custom-scrollbar py-2 text-xs">
            {(places?.places ?? []).map((p) => (
              <button
                key={p.path}
                data-testid="file-browser-place"
                data-path={p.path}
                onClick={() => void navigate(p.path)}
                className={`w-full flex items-center gap-2 px-3 py-1 text-left truncate hover:bg-neutral-700/60 ${
                  p.path === dir ? 'text-white bg-neutral-700/60' : 'text-neutral-300'}`}
                title={p.path}
              >
                {placeIcon(p)}<span className="truncate">{p.label}</span>
              </button>
            ))}
            {recentDirs.length > 0 && (
              <>
                <div className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-wide text-neutral-500">Recent</div>
                {recentDirs.map((r) => (
                  <button
                    key={r}
                    data-testid="file-browser-recent"
                    data-path={r}
                    onClick={() => void navigate(r)}
                    className="w-full flex items-center gap-2 px-3 py-1 text-left text-neutral-300 hover:bg-neutral-700/60"
                    title={r}
                  >
                    <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="truncate">{splitParent(r, sep).name || r}</span>
                  </button>
                ))}
              </>
            )}
          </nav>

          {/* Listing */}
          <section className="flex flex-col flex-1 min-w-0 border-r border-neutral-700">
            <div className="flex items-center gap-0.5 px-3 py-1.5 text-[11px] text-neutral-400 overflow-x-auto custom-scrollbar whitespace-nowrap">
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex items-center">
                  {i > 0 && <ChevronRight className="w-3 h-3 mx-0.5 text-neutral-600" />}
                  <button
                    data-testid="file-browser-crumb"
                    data-path={c.path}
                    onClick={() => void navigate(c.path)}
                    className="px-1 rounded hover:bg-neutral-700 hover:text-white"
                  >
                    {c.label}
                  </button>
                </span>
              ))}
            </div>
            <div className="grid grid-cols-[1fr_6rem_10rem] px-3 py-1 text-[10px] uppercase tracking-wide text-neutral-500 border-y border-neutral-700/70 select-none">
              <button className="text-left hover:text-neutral-300" onClick={() => toggleSort('name')}>Name{sortMark('name')}</button>
              <button className="text-right hover:text-neutral-300" onClick={() => toggleSort('size')}>Size{sortMark('size')}</button>
              <button className="text-right hover:text-neutral-300" onClick={() => toggleSort('mtime')}>Modified{sortMark('mtime')}</button>
            </div>
            <div
              ref={listRef}
              data-testid="file-browser-list"
              tabIndex={0}
              onKeyDown={onListKey}
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              className="relative flex-1 overflow-y-auto custom-scrollbar focus:outline-none"
            >
              {listing && !listing.ok && (
                <div data-testid="file-browser-error" className="m-4 flex items-start gap-2 text-xs text-red-300 bg-red-500/5 border border-red-500/30 rounded px-3 py-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  <span>{listing.message}</span>
                </div>
              )}
              {listing?.ok && view.length === 0 && !busy && (
                <div className="p-6 text-center text-xs text-neutral-500">
                  {query ? 'Nothing here matches the filter.' : `No ${allFiles ? '' : `${FILTER_LABELS[importType].toLowerCase()} or `}folders here.`}
                </div>
              )}
              <div style={{ height: view.length * ROW_H }} className="relative">
                {view.slice(first, last).map((e, k) => {
                  const i = first + k;
                  const selected = sel.selected.includes(e.path);
                  return (
                    <div
                      key={e.path}
                      data-testid="file-browser-entry"
                      data-name={e.name}
                      data-kind={e.kind}
                      aria-selected={selected}
                      onClick={(ev) => {
                        setSel(clickSelect(sel, view, e.path, { toggle: ev.metaKey || ev.ctrlKey, range: ev.shiftKey }));
                        listRef.current?.focus();
                      }}
                      onDoubleClick={() => openEntry(e)}
                      style={{ top: i * ROW_H, height: ROW_H }}
                      className={`absolute inset-x-0 grid grid-cols-[1fr_6rem_10rem] items-center px-3 text-xs cursor-default select-none ${
                        selected ? 'bg-blue-600/40 text-white' : 'text-neutral-200 hover:bg-neutral-700/50'
                      } ${sel.focus === e.path ? 'ring-1 ring-inset ring-blue-400/60' : ''}`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        {e.kind === 'dir'
                          ? <Folder className="w-3.5 h-3.5 flex-shrink-0 text-sky-300/80" />
                          : <FileIcon className="w-3.5 h-3.5 flex-shrink-0 text-neutral-400" />}
                        <span className="truncate">{e.name}</span>
                        {e.placeholder && (
                          <span title="Stored online only — downloads when imported" data-testid="file-browser-placeholder">
                            <Cloud className="w-3.5 h-3.5 flex-shrink-0 text-amber-300/80" />
                          </span>
                        )}
                      </span>
                      <span className="text-right text-neutral-400 tabular-nums">{e.kind === 'file' ? formatSize(e.size) : ''}</span>
                      <span className="text-right text-neutral-500 tabular-nums">{formatDate(e.mtimeMs)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          {/* Options */}
          <aside
            data-testid="file-browser-options"
            className="w-[min(600px,45%)] flex-shrink-0 overflow-y-auto custom-scrollbar p-4 space-y-3"
          >
            {selectedFiles.length === 0 && (
              <p className="text-xs text-neutral-500">Select a file to see its import options.</p>
            )}

            {primaryEntry && (
              <div className="space-y-1">
                <div className="text-xs text-neutral-200">
                  Options for <span className="font-medium text-white" data-testid="file-browser-primary">{primaryEntry.name}</span>
                </div>
                {pcPaths.length > 1 && (
                  <p data-testid="file-browser-batch-note" className="text-[11px] text-neutral-400 leading-snug">
                    These options apply to all {pcPaths.length} selected point clouds.
                    {batch.loading ? ' Reading the other files…' : (
                      <>
                        {batch.sameLayout > 0 && ` ${batch.sameLayout} share this column layout and take these column settings.`}
                        {batch.ownLayout > 0 && ` ${batch.ownLayout} ${batch.ownLayout === 1 ? 'has' : 'have'} a different layout and keep ${batch.ownLayout === 1 ? 'its' : 'their'} detected columns; units, shift and trajectory still apply.`}
                      </>
                    )}
                  </p>
                )}
              </div>
            )}

            {primary && (
              <PointCloudImportOptions
                cfg={batch.configs[0]}
                onEdit={onEdit}
                onImportTrajectory={importTrajectory}
                trajectoryNote={pcPaths.length > 1 ? 'It applies to every selected scan.' : undefined}
              />
            )}

            {otherFiles.length > 0 && (
              <div className="space-y-2">
                {primary && (
                  <p className="text-[11px] text-neutral-400">
                    {otherFiles.length} other selected file{otherFiles.length > 1 ? 's' : ''} import{otherFiles.length > 1 ? '' : 's'} with no options:
                  </p>
                )}
                {otherFiles.slice(0, 50).map((e) => (
                  <div key={e.path} data-testid="file-browser-info" className="border border-neutral-700 rounded-lg px-3 py-2 text-[11px] text-neutral-300 space-y-0.5">
                    <div className="text-xs text-white truncate">{e.name}</div>
                    <div>{describeKind(e.ext, importType)}</div>
                    <div className="text-neutral-500">{formatSize(e.size)} · modified {formatDate(e.mtimeMs)}</div>
                    {e.placeholder && <div className="text-amber-300/90">Stored online only; it downloads when imported.</div>}
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-neutral-700">
          <span data-testid="file-browser-summary" className="text-[11px] text-neutral-400 truncate">
            {selectedFiles.length === 0
              ? (busy ? 'Reading folder…' : `${view.filter((e) => e.kind === 'file').length} file(s)`)
              : `${selectedFiles.length} selected`}
            {pcPaths.length > 0 && batch.loading && ' · reading headers…'}
            {pcPaths.length > 0 && !batch.loading && batch.unready.length > 0 && (
              <span data-testid="file-browser-unready" className="text-amber-300">
                {' · assign X, Y and Z in '}
                {batch.unready.map((i) => byPath.get(pcPaths[i])?.name ?? pcPaths[i]).join(', ')}
                {batch.unready.some((i) => i > 0) && ' (click it to edit its columns)'}
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onCancel} data-testid="file-browser-cancel" className="px-3 py-1.5 text-xs text-neutral-300 hover:text-white">
              Cancel
            </button>
            <button
              onClick={() => void doImport()}
              disabled={!canImport}
              data-testid="file-browser-import"
              className="px-4 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {importing ? 'Importing…' : `Import${selectedFiles.length > 1 ? ` ${selectedFiles.length} files` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
