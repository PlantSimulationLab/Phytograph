import { describe, it, expect } from 'vitest';
import type { BrowserEntry } from '../../shared/ipc';
import type { PointCloudPreviewResponse, PreviewColumn } from '../utils/backendApi';
import {
  EMPTY_SELECTION,
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
  type PreviewState,
} from './fileBrowserModel';
import { withColumnPatch, withShiftAxis, withUnits } from './pointCloudImportOptions';

const entry = (name: string, kind: 'file' | 'dir' = 'file', extra: Partial<BrowserEntry> = {}): BrowserEntry => ({
  name,
  path: `/d/${name}`,
  kind,
  size: 0,
  mtimeMs: 0,
  ext: kind === 'dir' ? '' : (name.split('.').pop() ?? '').toLowerCase(),
  placeholder: false,
  ...extra,
});

describe('extensions per import type', () => {
  it('offers each type its own formats, and auto the union plus Helios XML', () => {
    expect(extensionsFor('pointcloud')).toContain('laz');
    expect(extensionsFor('pointcloud')).not.toContain('obj');
    expect(extensionsFor('mesh')).toEqual(['obj', 'stl', 'ply']);
    expect(extensionsFor('qsm')).toEqual(['csv']);
    const auto = extensionsFor('auto');
    for (const e of ['las', 'obj', 'json', 'xml']) expect(auto).toContain(e);
    expect(new Set(auto).size).toBe(auto.length); // ply appears once
  });

  it('gives point-cloud options only to point clouds, only for point-cloud imports', () => {
    expect(takesPointCloudOptions('LAS', 'pointcloud')).toBe(true);
    expect(takesPointCloudOptions('xyz', 'auto')).toBe(true);
    expect(takesPointCloudOptions('obj', 'auto')).toBe(false);
    expect(takesPointCloudOptions('csv', 'qsm')).toBe(false);
    expect(takesPointCloudOptions('ply', 'mesh')).toBe(false);
  });

  it('describes what a file will import as', () => {
    expect(describeKind('csv', 'qsm')).toBe('QSM cylinder table');
    expect(describeKind('json', 'auto')).toBe('Skeleton');
    expect(describeKind('ply', 'auto')).toMatch(/mesh/);
    expect(describeKind('las', 'auto')).toBe('Point cloud');
  });
});

describe('listing view', () => {
  it('sorts folders first, names naturally', () => {
    const sorted = sortEntries([entry('scan10.las'), entry('b', 'dir'), entry('scan2.las'), entry('a', 'dir')], 'name');
    expect(sorted.map((e) => e.name)).toEqual(['a', 'b', 'scan2.las', 'scan10.las']);
  });

  it('sorts by size and date, descending on request, folders still first', () => {
    const es = [entry('big.las', 'file', { size: 900, mtimeMs: 1 }), entry('small.las', 'file', { size: 5, mtimeMs: 3 }), entry('z', 'dir')];
    expect(sortEntries(es, 'size', true).map((e) => e.name)).toEqual(['z', 'big.las', 'small.las']);
    expect(sortEntries(es, 'mtime').map((e) => e.name)).toEqual(['z', 'big.las', 'small.las']);
  });

  it('keeps folders through the extension filter but not through the name filter', () => {
    const es = [entry('scan.las'), entry('mesh.obj'), entry('plots', 'dir')];
    expect(filterEntries(es, ['las'], '').map((e) => e.name)).toEqual(['scan.las', 'plots']);
    expect(filterEntries(es, null, '').length).toBe(3);
    expect(filterEntries(es, null, 'SCAN').map((e) => e.name)).toEqual(['scan.las']);
  });

  it('formats sizes', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(1.67 * 1024 ** 3)).toBe('1.7 GB');
  });
});

describe('paths', () => {
  it('splits POSIX paths into breadcrumbs', () => {
    expect(splitPath('/Users/me/scans', '/')).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'me', path: '/Users/me' },
      { label: 'scans', path: '/Users/me/scans' },
    ]);
    expect(splitPath('/', '/')).toEqual([{ label: '/', path: '/' }]);
  });

  it('splits Windows drive and UNC paths', () => {
    expect(splitPath('C:\\Data\\Plot 1', '\\')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Data', path: 'C:\\Data' },
      { label: 'Plot 1', path: 'C:\\Data\\Plot 1' },
    ]);
    expect(splitPath('\\\\nas\\lidar\\2026', '\\')).toEqual([
      { label: '\\\\nas\\lidar', path: '\\\\nas\\lidar\\' },
      { label: '2026', path: '\\\\nas\\lidar\\2026' },
    ]);
  });

  it('normalizes typed and pasted paths', () => {
    expect(normalizePathInput('  "/Users/me/a b.las" ', '/Users/me', '/')).toBe('/Users/me/a b.las');
    expect(normalizePathInput('~/scans', '/Users/me', '/')).toBe('/Users/me/scans');
    expect(normalizePathInput('~', '/Users/me', '/')).toBe('/Users/me');
    expect(normalizePathInput('~\\scans', 'C:\\Users\\me', '\\')).toBe('C:\\Users\\me\\scans');
  });

  it('resolves a relative path against the folder on screen', () => {
    expect(resolveAgainst('scans', '/Users/me', '/')).toBe('/Users/me/scans');
    expect(resolveAgainst('/abs', '/Users/me', '/')).toBe('/abs');
    expect(resolveAgainst('a', '/', '/')).toBe('/a');
    expect(resolveAgainst('plot', 'C:\\Data', '\\')).toBe('C:\\Data\\plot');
    expect(resolveAgainst('D:\\x', 'C:\\Data', '\\')).toBe('D:\\x');
    expect(resolveAgainst('\\\\nas\\share', 'C:\\', '\\')).toBe('\\\\nas\\share');
  });

  it('splits a path into parent and name, keeping the root separator', () => {
    expect(splitParent('/Users/me/a.las', '/')).toEqual({ dir: '/Users/me', name: 'a.las' });
    expect(splitParent('/a.las', '/')).toEqual({ dir: '/', name: 'a.las' });
    expect(splitParent('C:\\a.las', '\\')).toEqual({ dir: 'C:\\', name: 'a.las' });
    expect(splitParent('/Users/me/', '/')).toEqual({ dir: '/Users', name: 'me' });
  });
});

describe('selection', () => {
  const view = ['a.las', 'b.las', 'c.las', 'd.las'].map((n) => entry(n));
  const p = (n: string) => `/d/${n}`;

  it('plain click selects one; toggle adds and removes', () => {
    let s = clickSelect(EMPTY_SELECTION, view, p('b.las'));
    expect(s.selected).toEqual([p('b.las')]);
    s = clickSelect(s, view, p('d.las'), { toggle: true });
    expect(s.selected).toEqual([p('b.las'), p('d.las')]);
    s = clickSelect(s, view, p('b.las'), { toggle: true });
    expect(s.selected).toEqual([p('d.las')]);
  });

  it('shift-click selects the range from the anchor in view order', () => {
    let s = clickSelect(EMPTY_SELECTION, view, p('c.las'));
    s = clickSelect(s, view, p('a.las'), { range: true });
    // The anchor stays first: it is the file whose options the panel shows.
    expect(s.selected).toEqual([p('c.las'), p('a.las'), p('b.las')]);
    expect(s.anchor).toBe(p('c.las'));
  });

  it('a downward range keeps view order after the anchor', () => {
    let s = clickSelect(EMPTY_SELECTION, view, p('b.las'));
    s = clickSelect(s, view, p('d.las'), { range: true });
    expect(s.selected).toEqual([p('b.las'), p('c.las'), p('d.las')]);
  });

  it('arrow keys move the cursor and clamp; shift extends', () => {
    let s = moveSelect(EMPTY_SELECTION, view, 1);
    expect(s.selected).toEqual([p('a.las')]);
    s = moveSelect(s, view, 1, true);
    expect(s.selected).toEqual([p('a.las'), p('b.las')]);
    s = moveSelect(s, view, 99);
    expect(s.selected).toEqual([p('d.las')]);
  });

  it('select-all takes files only', () => {
    const s = selectAllFiles([...view, entry('sub', 'dir')]);
    expect(s.selected).toHaveLength(4);
  });

  it('drops selected paths that a filter hid', () => {
    const s = { selected: [p('a.las'), p('c.las')], anchor: p('a.las'), focus: p('c.las') };
    expect(pruneSelection(s, view.slice(0, 2))).toEqual({ selected: [p('a.las')], anchor: p('a.las'), focus: null });
  });

  it('type-ahead finds the next match, wrapping', () => {
    const v = ['alpha', 'beta', 'bravo', 'charlie'].map((n) => entry(n, 'dir'));
    expect(typeAheadIndex(v, 'b', 0)).toBe(1);
    expect(typeAheadIndex(v, 'b', 2)).toBe(2);
    expect(typeAheadIndex(v, 'al', 3)).toBe(0);
    expect(typeAheadIndex(v, 'zz', 0)).toBe(-1);
  });
});

// ─── one set of options for the selection ───────────────────────────────

const col = (index: number, header: string, role: string): PreviewColumn => ({
  index, header_name: header, detected_role: role,
  suggested_label: header, suggested_slug: header.toLowerCase(),
  type_hint: 'float', remappable: true,
});

const XYZI = [col(0, 'X', 'x'), col(1, 'Y', 'y'), col(2, 'Z', 'z'), col(3, 'I', 'intensity')];
const XYZ_CLASS = [col(0, 'X', 'x'), col(1, 'Y', 'y'), col(2, 'Z', 'z'), col(3, 'class', 'extra')];

const preview = (columns: PreviewColumn[], extra: Partial<PointCloudPreviewResponse> = {}): PreviewState => ({
  status: 'ok',
  preview: {
    kind: 'ascii', delimiter: 'whitespace', has_header: true,
    columns, sample_rows: [], warning: null, suggested_shift: null,
    detected_units: null, units_certain: false, ...extra,
  },
});

// No edits on any file.
const none = () => [];
// `edits` were all made with paths[0] as the primary.
const primaryEdits = (paths: string[], edits: BrowserEdit[]) =>
  (p: string): BrowserEdit[] => (p === paths[0] ? edits : []);

describe('buildBatch', () => {
  const paths = ['/d/a.xyz', '/d/b.xyz', '/d/c.xyz'];

  it('waits for every preview before it is ready', () => {
    const b = buildBatch(paths, new Map([[paths[0], preview(XYZI)]]), none);
    expect(b.loading).toBe(true);
    expect(b.ready).toBe(false);
  });

  it('gives same-layout files the column edits and different-layout files only the batch settings', () => {
    const previews = new Map<string, PreviewState>([
      [paths[0], preview(XYZI)],
      [paths[1], preview(XYZI)],
      [paths[2], preview(XYZ_CLASS)],
    ]);
    const edits: BrowserEdit[] = [
      { scope: 'column', fn: (c) => withColumnPatch(c, 3, { role: 'reflectance' }) },
      { scope: 'global', fn: (c) => withUnits(c, 'cm') },
    ];
    const b = buildBatch(paths, previews, primaryEdits(paths, edits));
    expect(b.ready).toBe(true);
    expect(b.sameLayout).toBe(1);
    expect(b.ownLayout).toBe(1);
    expect(b.configs[0].columns[3].role).toBe('reflectance');
    expect(b.configs[1].columns[3].role).toBe('reflectance');
    // The different layout keeps its own detected columns ...
    expect(b.configs[2].columns[3].role).toBe('extra');
    // ... but every file takes the batch's units.
    expect(b.configs.map((c) => c.units)).toEqual(['cm', 'cm', 'cm']);

    const results = batchResults(paths, b.configs);
    expect(results.get(paths[1])?.columnPlan?.columns[3].role).toBe('reflectance');
    expect(results.get(paths[2])?.columnPlan?.columns[3].role).toBe('extra');
    expect(results.get(paths[2])?.input.fileName).toBe('c.xyz');
  });

  it('never overrides a unit a file declared itself', () => {
    const previews = new Map<string, PreviewState>([
      [paths[0], preview(XYZI)],
      [paths[1], preview(XYZ_CLASS, { detected_units: 'ftUS', units_certain: true })],
    ]);
    const b = buildBatch(paths.slice(0, 2), previews, primaryEdits(paths, [{ scope: 'global', fn: (c) => withUnits(c, 'cm') }]));
    expect(b.configs[1].units).toBe('ftUS');
  });

  it('puts every file in one frame: the smallest suggested shift, and a hand-edited one for all', () => {
    const previews = new Map<string, PreviewState>([
      [paths[0], preview(XYZI, { suggested_shift: [600_020, 4_200_010, 0] })],
      [paths[1], preview(XYZ_CLASS, { suggested_shift: [600_000, 4_200_030, 0] })],
    ]);
    let b = buildBatch(paths.slice(0, 2), previews, none);
    expect(b.configs.map((c) => c.shift)).toEqual([
      { x: 600_000, y: 4_200_010, z: 0 },
      { x: 600_000, y: 4_200_010, z: 0 },
    ]);
    b = buildBatch(paths.slice(0, 2), previews, primaryEdits(paths, [{ scope: 'global', fn: (c) => withShiftAxis(c, 'z', 12) }]));
    expect(b.configs.map((c) => c.shift.z)).toEqual([12, 12]);
  });

  it('lets a file whose preview failed import with auto-detect', () => {
    const previews = new Map<string, PreviewState>([
      [paths[0], preview(XYZI)],
      [paths[1], { status: 'error', message: 'boom' }],
    ]);
    const b = buildBatch(paths.slice(0, 2), previews, none);
    expect(b.ready).toBe(true);
    expect(b.configs[1].autoOnly).toBe(true);
    expect(batchResults(paths.slice(0, 2), b.configs).get(paths[1])?.columnPlan).toBeNull();
  });

  it('is not ready while the primary lacks X/Y/Z', () => {
    const previews = new Map<string, PreviewState>([[paths[0], preview(XYZI)]]);
    const b = buildBatch(paths.slice(0, 1), previews, primaryEdits(paths, [{ scope: 'column', fn: (c) => withColumnPatch(c, 0, { role: 'skip' }) }]));
    expect(b.ready).toBe(false);
  });

  it('a different-layout file keeps the column mapping made while it was primary', () => {
    // Two header-less layouts that both need X/Y/Z assigned by hand.
    const raw = (n: number) => Array.from({ length: n }, (_, i) => col(i, `c${i}`, 'skip'));
    const previews = new Map<string, PreviewState>([
      [paths[0], preview(raw(3))],
      [paths[1], preview(raw(4))],
    ]);
    const mapXYZ: BrowserEdit[] = (['x', 'y', 'z'] as const).map((role, i) => (
      { scope: 'column', fn: (c) => withColumnPatch(c, i, { role }) }));
    const editsByFile = new Map<string, BrowserEdit[]>([[paths[0], mapXYZ], [paths[1], mapXYZ]]);
    const b = buildBatch(paths.slice(0, 2), previews, (p) => editsByFile.get(p) ?? []);
    expect(b.ownLayout).toBe(1);
    expect(b.ready).toBe(true);
    expect(b.configs[1].columns.slice(0, 3).map((c) => c.role)).toEqual(['x', 'y', 'z']);
  });

  it('names the files that still need X/Y/Z', () => {
    const raw = Array.from({ length: 3 }, (_, i) => col(i, `c${i}`, 'skip'));
    const previews = new Map<string, PreviewState>([
      [paths[0], preview(XYZI)],
      [paths[1], preview(raw)],
    ]);
    const b = buildBatch(paths.slice(0, 2), previews, none);
    expect(b.ready).toBe(false);
    expect(b.unready).toEqual([1]);
  });

  it('a different-layout file never takes column edits from another file', () => {
    const previews = new Map<string, PreviewState>([
      [paths[0], preview(XYZI)],
      [paths[1], preview(XYZ_CLASS)],
    ]);
    // Column 3 edited on the primary only.
    const b = buildBatch(paths.slice(0, 2), previews,
      primaryEdits(paths, [{ scope: 'column', fn: (c) => withColumnPatch(c, 3, { role: 'skip' }) }]));
    expect(b.configs[1].columns[3].role).toBe('extra');
  });

  it('stays linear on a large selection', () => {
    const many = Array.from({ length: 3000 }, (_, i) => `/d/s${i}.xyz`);
    const previews = new Map<string, PreviewState>(many.map((p, i) => [p, preview(XYZI, {
      suggested_shift: [600_000 + i, 4_200_000 + i, 0],
    })]));
    const t0 = performance.now();
    const b = buildBatch(many, previews, none);
    const ms = performance.now() - t0;
    expect(b.sameLayout).toBe(2999);
    expect(b.configs[2999].shift).toEqual({ x: 600_000, y: 4_200_000, z: 0 });
    // Quadratic seeding took several seconds here; linear is a few ms.
    expect(ms).toBeLessThan(1500);
  });
});
