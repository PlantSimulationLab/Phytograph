import { describe, it, expect } from 'vitest';
import {
  blockedReason,
  effectiveCheckedIds,
  mergeCheckedIntent,
  objectDetailLine,
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
