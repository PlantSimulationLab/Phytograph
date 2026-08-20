import { describe, it, expect } from 'vitest';
import {
  blockedReason,
  effectiveCheckedIds,
  exportBaseName,
  mergeCheckedIntent,
  objectDetailLine,
  objectFileSlug,
  plannedFileNames,
  seedCheckedIds,
  selectableIds,
  type ExportMode,
  type ExportObjectItem,
} from './exportObjects';

const XML_REASON = 'No scanner parameters — use Data only.';
const PTX_REASON = 'PTX needs a complete scan grid.';

function item(over: Partial<ExportObjectItem> & { id: string }): ExportObjectItem {
  return {
    name: over.id,
    pointCount: 100,
    hasMisses: false,
    selected: false,
    isScan: false,
    ...over,
  };
}

/** A plain cloud: exportable as data, but never as an XML bundle or PTX. */
const plain = (id: string, over: Partial<ExportObjectItem> = {}) =>
  item({ id, isScan: false, xmlBlockedReason: XML_REASON, ptxBlockedReason: PTX_REASON, ...over });
/** A scan: exportable everywhere. */
const scan = (id: string, over: Partial<ExportObjectItem> = {}) =>
  item({ id, isScan: true, ...over });

const XML: ExportMode = { writeXml: true, dataFormat: 'xyz' };
const DATA: ExportMode = { writeXml: false, dataFormat: 'xyz' };
const PTX: ExportMode = { writeXml: false, dataFormat: 'ptx' };

describe('blockedReason', () => {
  it('blocks a param-less cloud from the XML bundle and from PTX', () => {
    expect(blockedReason(plain('a'), XML)).toBe(XML_REASON);
    expect(blockedReason(plain('a'), PTX)).toBe(PTX_REASON);
  });

  it('lets a param-less cloud through every plain data format', () => {
    for (const dataFormat of ['xyz', 'csv', 'txt', 'las', 'laz', 'ply', 'obj', 'e57']) {
      expect(blockedReason(plain('a'), { writeXml: false, dataFormat })).toBeUndefined();
    }
  });

  it('never blocks a scan that carries no reason of its own', () => {
    expect(blockedReason(scan('s'), XML)).toBeUndefined();
    expect(blockedReason(scan('s'), PTX)).toBeUndefined();
  });

  it('honours a per-object reason (a Risley scan has no raster grid)', () => {
    const risley = scan('livox', { xmlBlockedReason: 'no grid', ptxBlockedReason: 'no grid' });
    expect(blockedReason(risley, XML)).toBe('no grid');
    expect(blockedReason(risley, DATA)).toBeUndefined();
  });
});

describe('seedCheckedIds', () => {
  const items = [scan('s1', { selected: true }), scan('s2'), plain('c1')];

  it('checks exactly what the Scans panel had selected', () => {
    expect([...seedCheckedIds(items, false)]).toEqual(['s1']);
  });

  it('checks everything when nothing at all is selected', () => {
    const none = items.map(i => ({ ...i, selected: false }));
    expect([...seedCheckedIds(none, false)]).toEqual(['s1', 's2', 'c1']);
  });

  it('checks NOTHING when a mesh/skeleton is what is selected', () => {
    // Every cloud is listed now, so the old all-checked fallback would silently
    // arm a whole-scene export off a mesh selection.
    const none = items.map(i => ({ ...i, selected: false }));
    expect([...seedCheckedIds(none, true)]).toEqual([]);
  });

  it('still prefers an explicit cloud selection over the mesh rule', () => {
    expect([...seedCheckedIds(items, true)]).toEqual(['s1']);
  });
});

describe('effectiveCheckedIds', () => {
  const items = [scan('s1'), plain('c1'), scan('s2')];

  it('drops the rows this mode cannot write', () => {
    const checked = new Set(['s1', 'c1', 's2']);
    expect(effectiveCheckedIds(items, checked, XML)).toEqual(['s1', 's2']);
    expect(effectiveCheckedIds(items, checked, DATA)).toEqual(['s1', 'c1', 's2']);
  });

  it('follows list order, so the file suffixes match what the user saw', () => {
    expect(effectiveCheckedIds(items, new Set(['s2', 's1']), DATA)).toEqual(['s1', 's2']);
  });

  it('is empty when everything checked is blocked', () => {
    expect(effectiveCheckedIds(items, new Set(['c1']), XML)).toEqual([]);
  });
});

describe('mergeCheckedIntent', () => {
  it('keeps checkmarks on rows the current mode has greyed out', () => {
    const items = [scan('s1'), plain('c1')];
    const prev = new Set(['s1', 'c1']);
    // In XML mode the picker only knows about s1; unchecking nothing there must
    // not forget that the user also wants c1 when they switch back to Data.
    const merged = mergeCheckedIntent(prev, new Set(['s1']), selectableIds(items, XML));
    expect([...merged].sort()).toEqual(['c1', 's1']);
    expect(effectiveCheckedIds(items, merged, DATA)).toEqual(['s1', 'c1']);
  });

  it('still honours an unchecking of a row that IS selectable', () => {
    const items = [scan('s1'), scan('s2')];
    const merged = mergeCheckedIntent(
      new Set(['s1', 's2']), new Set(['s1']), selectableIds(items, XML));
    expect([...merged]).toEqual(['s1']);
  });
});

describe('objectDetailLine', () => {
  it('shows the point count, and flags sky/miss points when present', () => {
    expect(objectDetailLine(plain('a', { pointCount: 1234567 }))).toBe('1,234,567 pts');
    expect(objectDetailLine(plain('a', { pointCount: 10, hasMisses: true }))).toBe('10 pts · misses');
  });
});

// These MUST agree with `_scan_label_slug` in backend-api/main.py, which is what
// actually names the files — the same cases live in
// backend-api/tests/test_scan_export.py::TestScanExportNaming, so a drift in
// either copy shows up as a failing pair.
describe('objectFileSlug', () => {
  it('keeps a plain label as-is', () => {
    expect(objectFileSlug('ScanPos001', 0)).toBe('ScanPos001');
  });

  it('collapses characters a file system will not take', () => {
    expect(objectFileSlug('plot A/B: north', 0)).toBe('plot_A_B_north');
    expect(objectFileSlug('east*plot?', 1)).toBe('east_plot');
  });

  it('drops a filename-ish extension so it is not doubled up', () => {
    expect(objectFileSlug('ScanPos001.las', 0)).toBe('ScanPos001');
    // Not an extension — a version-ish tail stays.
    expect(objectFileSlug('plot.2024.10.03', 0)).toBe('plot.2024.10');
  });

  it('falls back to the index when nothing usable survives', () => {
    expect(objectFileSlug('  ...  ', 3)).toBe('3');
    expect(objectFileSlug('', 0)).toBe('0');
  });

  it('caps a runaway label', () => {
    expect(objectFileSlug('x'.repeat(200), 0)).toHaveLength(64);
  });
});

describe('exportBaseName', () => {
  it('reads a typed name the way the backend does', () => {
    expect(exportBaseName('myscan')).toBe('myscan');
    expect(exportBaseName('  myscan.laz  ')).toBe('myscan');
    expect(exportBaseName('/some/dir/myscan.las')).toBe('myscan');
    expect(exportBaseName('C:\\out\\myscan.xyz')).toBe('myscan');
  });

  it('falls back to "scans" on an empty field', () => {
    expect(exportBaseName('')).toBe('scans');
    expect(exportBaseName('   ')).toBe('scans');
  });
});

// The preview the Export window shows before the user picks a folder. It has to
// be exactly what the backend writes — a preview that lies is worse than the
// native Save panel it replaced.
describe('plannedFileNames', () => {
  it('gives a lone object the base name itself', () => {
    expect(plannedFileNames(['ScanPos001'], 'myscan', 'laz')).toEqual(['myscan.laz']);
  });

  it('names several objects for themselves, in write order', () => {
    expect(plannedFileNames(['ScanPos002', 'ScanPos001'], 'myscan', 'laz'))
      .toEqual(['myscan_ScanPos002.laz', 'myscan_ScanPos001.laz']);
  });

  it('deduplicates case-insensitively, as the backend does', () => {
    expect(plannedFileNames(['tree', 'tree', 'TREE'], 'out', 'xyz'))
      .toEqual(['out_tree.xyz', 'out_tree_2.xyz', 'out_TREE_3.xyz']);
  });

  it('lists the XML alongside the per-scan data files in bundle mode', () => {
    expect(plannedFileNames(['north', 'south'], 'bundle', 'xyz', true))
      .toEqual(['bundle.xml', 'bundle_north.xyz', 'bundle_south.xyz']);
  });

  it('applies the backend reading of the base name', () => {
    expect(plannedFileNames(['a', 'b'], 'myscan.laz', 'xyz'))
      .toEqual(['myscan_a.xyz', 'myscan_b.xyz']);
    expect(plannedFileNames(['a', 'b'], '', 'xyz'))
      .toEqual(['scans_a.xyz', 'scans_b.xyz']);
  });
});
