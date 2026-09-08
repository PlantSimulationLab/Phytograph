import { describe, it, expect } from 'vitest';
import {
  ColorChannel,
  ChannelDescriptor,
  resolveChannel,
  isChannelOverridden,
  clearColormapOverride,
  legendKindFor,
  effectiveRange,
  buildLegendEntries,
  layoutLegend,
  cssColorToRgb,
  sharedDomains,
  sharedDomainKey,
  LEGEND_EXPAND_LIMIT,
} from './colorChannel';
import { GROUND_CLASS_ATTRIBUTE, TREE_INSTANCE_ATTRIBUTE } from './classification';

// Build a descriptor with sensible defaults so each test only states what it
// is actually exercising.
function descriptor(over: Partial<ChannelDescriptor> & { objectId: string }): ChannelDescriptor {
  return {
    objectName: `Object ${over.objectId}`,
    objectKindPlural: 'scans',
    variableLabel: 'Z Height',
    channel: { mode: 'height', colormap: 'viridis' },
    dataRange: { min: 0, max: 10 },
    ...over,
  };
}

describe('resolveChannel', () => {
  it('inherits the scene default when the channel sets no colormap', () => {
    const resolved = resolveChannel({ mode: 'height' }, 'plasma');
    expect(resolved?.colormap).toBe('plasma');
  });

  it('keeps an explicit per-instance override', () => {
    const resolved = resolveChannel({ mode: 'height', colormap: 'turbo' }, 'plasma');
    expect(resolved?.colormap).toBe('turbo');
  });

  it('returns null for an absent channel', () => {
    expect(resolveChannel(undefined, 'viridis')).toBeNull();
  });
});

describe('colormap override tracking', () => {
  it('reports inheritance vs override', () => {
    expect(isChannelOverridden({ mode: 'height' })).toBe(false);
    expect(isChannelOverridden({ mode: 'height', colormap: 'jet' })).toBe(true);
    expect(isChannelOverridden(undefined)).toBe(false);
  });

  it('clearing an override restores inheritance and preserves other fields', () => {
    const channel: ColorChannel = {
      mode: 'scalar',
      field: 'reflectance',
      colormap: 'jet',
      range: { min: 1, max: 2 },
      reversed: true,
    };
    const cleared = clearColormapOverride(channel);
    expect(isChannelOverridden(cleared)).toBe(false);
    expect(cleared).toEqual({
      mode: 'scalar',
      field: 'reflectance',
      range: { min: 1, max: 2 },
      reversed: true,
    });
    // Changing the default now repaints this object.
    expect(resolveChannel(cleared, 'magma')?.colormap).toBe('magma');
  });
});

describe('legendKindFor', () => {
  it('treats flat/lookup color modes as legend-less', () => {
    for (const mode of ['solid', 'single', 'rgb', 'per-scan']) {
      expect(legendKindFor({ mode })).toBe('none');
    }
  });

  it('maps a plain scalar mode to a continuous gradient', () => {
    expect(legendKindFor({ mode: 'height' })).toBe('continuous');
    expect(legendKindFor({ mode: 'scalar', field: 'reflectance' })).toBe('continuous');
  });

  it('maps a registered classification attribute to a categorical legend', () => {
    expect(legendKindFor({ mode: 'scalar', field: GROUND_CLASS_ATTRIBUTE })).toBe('categorical');
  });

  it('suppresses the legend for tree_instance', () => {
    // Arbitrary nominal ids over 100+ trees: a gradient is meaningless and a
    // class list fills the viewport. Points stay colored; legend is dropped.
    expect(
      legendKindFor({ mode: 'scalar', field: TREE_INSTANCE_ATTRIBUTE }, { min: 0, max: 120 }),
    ).toBe('none');
  });
});

describe('effectiveRange', () => {
  it('prefers the user override over the data range', () => {
    expect(effectiveRange({ mode: 'height', range: { min: 2, max: 4 } }, { min: 0, max: 10 }))
      .toEqual({ min: 2, max: 4 });
  });

  it('falls back to the data range, then to null', () => {
    expect(effectiveRange({ mode: 'height' }, { min: 0, max: 10 })).toEqual({ min: 0, max: 10 });
    expect(effectiveRange({ mode: 'height' })).toBeNull();
  });
});

describe('buildLegendEntries', () => {
  it('folds objects sharing an identical channel into one captioned group', () => {
    const entries = buildLegendEntries([
      descriptor({ objectId: 'a' }),
      descriptor({ objectId: 'b' }),
      descriptor({ objectId: 'c' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].objectIds).toEqual(['a', 'b', 'c']);
    expect(entries[0].objectLabel).toBe('3 scans');
    expect(entries[0].variableLabel).toBe('Z Height');
  });

  it('keeps a single object captioned by its own name', () => {
    const entries = buildLegendEntries([descriptor({ objectId: 'a', objectName: 'Oak scan 3' })]);
    expect(entries[0].objectLabel).toBe('Oak scan 3');
  });

  it('splits objects apart when only the colormap differs', () => {
    // This is the regression the whole redesign exists for: two objects under
    // different colormaps must produce two legends, not one.
    const entries = buildLegendEntries([
      descriptor({ objectId: 'a', channel: { mode: 'height', colormap: 'viridis' } }),
      descriptor({ objectId: 'b', channel: { mode: 'height', colormap: 'turbo' } }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.colormap).sort()).toEqual(['turbo', 'viridis']);
  });

  it('splits objects apart when the mapped domain differs', () => {
    const entries = buildLegendEntries([
      descriptor({ objectId: 'a', dataRange: { min: 0, max: 10 } }),
      descriptor({ objectId: 'b', dataRange: { min: 0, max: 99 } }),
    ]);
    expect(entries).toHaveLength(2);
  });

  it('merges domains that differ only below display precision', () => {
    // Two Poisson reconstructions of one cloud yield inclination ranges like
    // 0.012119…–89.5436 and 0.012106…–89.5436: identical to the precision the
    // colorbar actually prints, but not bit-equal. Splitting those into two
    // legends showing the same numbers is exactly the clutter this redesign
    // removes, so the identity is quantized to 4 significant figures.
    const entries = buildLegendEntries([
      descriptor({ objectId: 'a', dataRange: { min: 0.012119225057644262, max: 89.54356290971731 } }),
      descriptor({ objectId: 'b', dataRange: { min: 0.012106187176556819, max: 89.54357322003776 } }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].objectIds).toEqual(['a', 'b']);
    // The merged entry reports the first object's domain — they agree to
    // everything the ticks will show.
    expect(entries[0].min).toBeCloseTo(0.01212, 5);
  });

  it('still splits domains that differ visibly', () => {
    // Guard the quantization from being too coarse: 1.234 vs 1.239 round to
    // different 4-sig-fig strings and must stay apart.
    const entries = buildLegendEntries([
      descriptor({ objectId: 'a', dataRange: { min: 0, max: 1.234 } }),
      descriptor({ objectId: 'b', dataRange: { min: 0, max: 1.239 } }),
    ]);
    expect(entries).toHaveLength(2);
  });

  it('does not merge different variables that happen to share a domain', () => {
    const entries = buildLegendEntries([
      descriptor({ objectId: 'a', variableLabel: 'Z Height' }),
      descriptor({
        objectId: 'b',
        variableLabel: 'Inclination (°)',
        objectKindPlural: 'meshes',
        channel: { mode: 'inclination', colormap: 'viridis' },
      }),
    ]);
    expect(entries).toHaveLength(2);
  });

  it('drops legend-less objects but keeps the rest', () => {
    const entries = buildLegendEntries([
      descriptor({ objectId: 'rgb', channel: { mode: 'rgb', colormap: 'viridis' } }),
      descriptor({ objectId: 'height' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].objectIds).toEqual(['height']);
  });

  it('applies the user range override to the legend domain', () => {
    const entries = buildLegendEntries([
      descriptor({
        objectId: 'a',
        channel: { mode: 'height', colormap: 'viridis', range: { min: 1, max: 5 } },
        dataRange: { min: 0, max: 10 },
      }),
    ]);
    expect(entries[0].min).toBe(1);
    expect(entries[0].max).toBe(5);
  });

  it('sorts selected entries ahead of unselected ones', () => {
    const entries = buildLegendEntries([
      descriptor({ objectId: 'a', channel: { mode: 'height', colormap: 'viridis' } }),
      descriptor({ objectId: 'b', channel: { mode: 'height', colormap: 'turbo' }, selected: true }),
    ]);
    expect(entries[0].objectIds).toEqual(['b']);
  });

  it('marks a merged entry selected when any folded object is selected', () => {
    const entries = buildLegendEntries([
      descriptor({ objectId: 'a' }),
      descriptor({ objectId: 'b', selected: true }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].selected).toBe(true);
  });

  it('carries the categorical scheme onto a categorical entry', () => {
    const entries = buildLegendEntries([
      descriptor({
        objectId: 'a',
        channel: { mode: 'scalar', field: GROUND_CLASS_ATTRIBUTE, colormap: 'viridis' },
        variableLabel: 'Ground class',
        dataRange: { min: 1, max: 2 },
      }),
    ]);
    expect(entries[0].kind).toBe('categorical');
    expect(entries[0].min).toBeUndefined();
    expect(entries[0].scheme?.classes.map(c => c.label)).toEqual(['Ground', 'Non-ground']);
  });

  it('folds categorical entries that differ only in data range', () => {
    // A ground/plant split leaves one child holding only class 1 and the other
    // only class 2, so their data ranges are 1:1 and 2:2. Both render the SAME
    // legend — the ground_class scheme's full Ground / Non-ground list, with no
    // colorbar — so they must fold into one card covering both clouds. They
    // used to produce two identical cards because the range was in the fold key
    // even though a categorical entry never draws it.
    const entries = buildLegendEntries([
      descriptor({
        objectId: 'ground',
        channel: { mode: 'scalar', field: GROUND_CLASS_ATTRIBUTE, colormap: 'viridis' },
        variableLabel: 'Ground Class',
        dataRange: { min: 1, max: 1 },
      }),
      descriptor({
        objectId: 'non-ground',
        channel: { mode: 'scalar', field: GROUND_CLASS_ATTRIBUTE, colormap: 'viridis' },
        variableLabel: 'Ground Class',
        dataRange: { min: 2, max: 2 },
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].objectIds).toEqual(['ground', 'non-ground']);
    expect(entries[0].scheme?.classes.map(c => c.label)).toEqual(['Ground', 'Non-ground']);
  });

  it('still separates CONTINUOUS entries by data range', () => {
    // The counterpart guard: a colorbar DOES render its range, so 0-10 and
    // 0-99 must stay two entries.
    const entries = buildLegendEntries([
      descriptor({
        objectId: 'a',
        channel: { mode: 'height', colormap: 'viridis' },
        variableLabel: 'Z (Height)',
        dataRange: { min: 0, max: 10 },
      }),
      descriptor({
        objectId: 'b',
        channel: { mode: 'height', colormap: 'viridis' },
        variableLabel: 'Z (Height)',
        dataRange: { min: 0, max: 99 },
      }),
    ]);
    expect(entries).toHaveLength(2);
  });

  it('returns nothing for an empty scene', () => {
    expect(buildLegendEntries([])).toEqual([]);
  });

  it('treats a caller-supplied scheme as categorical even for an unregistered palette', () => {
    // A mesh coloured by source scan uses the scans' own identifier swatches,
    // which classification.ts knows nothing about. Deriving the kind from the
    // field slug alone called this continuous and silently dropped the class
    // list, so the legend disappeared entirely.
    const entries = buildLegendEntries([
      descriptor({
        objectId: 'm1',
        objectName: 'Sphere mesh',
        objectKindPlural: 'meshes',
        variableLabel: 'Source scan',
        channel: { mode: 'scan', field: 'scan:m1', colormap: 'viridis' },
        dataRange: undefined,
        scheme: {
          attribute: 'scan:m1',
          classes: [
            { value: 0, label: 'Scan 1', color: [1, 0, 0] },
            { value: 1, label: 'Scan 2', color: [0, 1, 0] },
          ],
        },
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('categorical');
    expect(entries[0].scheme?.classes).toHaveLength(2);
  });
});

describe('cssColorToRgb', () => {
  it('parses six-digit hex', () => {
    expect(cssColorToRgb('#ff0000')).toEqual([1, 0, 0]);
    const [r, g, b] = cssColorToRgb('#4caf50');
    expect(r).toBeCloseTo(0x4c / 255, 5);
    expect(g).toBeCloseTo(0xaf / 255, 5);
    expect(b).toBeCloseTo(0x50 / 255, 5);
  });

  it('expands three-digit hex', () => {
    expect(cssColorToRgb('#f00')).toEqual([1, 0, 0]);
  });

  it('parses rgb() form', () => {
    expect(cssColorToRgb('rgb(255, 0, 0)')).toEqual([1, 0, 0]);
  });

  it('falls back to mid-grey rather than throwing on junk', () => {
    // A legend swatch is not worth crashing a render over.
    expect(cssColorToRgb('chartreuse')).toEqual([0.5, 0.5, 0.5]);
    expect(cssColorToRgb('')).toEqual([0.5, 0.5, 0.5]);
    expect(cssColorToRgb('#zz')).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('layoutLegend', () => {
  function entriesOfLength(n: number) {
    return buildLegendEntries(
      Array.from({ length: n }, (_, i) =>
        descriptor({ objectId: `o${i}`, dataRange: { min: 0, max: i + 1 } }),
      ),
    );
  }

  it('expands everything at or below the limit', () => {
    const layout = layoutLegend(entriesOfLength(LEGEND_EXPAND_LIMIT));
    expect(layout.expanded).toHaveLength(LEGEND_EXPAND_LIMIT);
    expect(layout.collapsed).toEqual([]);
  });

  it('collapses the overflow past the limit', () => {
    const layout = layoutLegend(entriesOfLength(6));
    expect(layout.expanded).toHaveLength(LEGEND_EXPAND_LIMIT);
    expect(layout.collapsed).toHaveLength(6 - LEGEND_EXPAND_LIMIT);
  });

  it('never drops an entry — expanded plus collapsed is the whole stack', () => {
    const all = entriesOfLength(7);
    const layout = layoutLegend(all);
    const seen = [...layout.expanded, ...layout.collapsed].map(e => e.key).sort();
    expect(seen).toEqual(all.map(e => e.key).sort());
  });

  it('promotes a collapsed entry into the expanded set when clicked', () => {
    const all = entriesOfLength(6);
    const buried = all[5];
    const layout = layoutLegend(all, buried.key);
    expect(layout.expanded[0].key).toBe(buried.key);
    expect(layout.expanded).toHaveLength(LEGEND_EXPAND_LIMIT);
    expect(layout.collapsed.map(e => e.key)).not.toContain(buried.key);
  });

  it('keeps the selected entry expanded when the stack overflows', () => {
    const all = buildLegendEntries([
      ...Array.from({ length: 5 }, (_, i) =>
        descriptor({ objectId: `o${i}`, dataRange: { min: 0, max: i + 1 } }),
      ),
      descriptor({ objectId: 'sel', dataRange: { min: 0, max: 99 }, selected: true }),
    ]);
    const layout = layoutLegend(all);
    expect(layout.expanded.some(e => e.objectIds.includes('sel'))).toBe(true);
  });
});

describe('sharedDomainKey', () => {
  it('keys a self-describing mode by the mode alone', () => {
    expect(sharedDomainKey('height')).toBe('height');
  });

  it('separates scalar fields from each other', () => {
    expect(sharedDomainKey('scalar', 'wood_class'))
      .not.toBe(sharedDomainKey('scalar', 'height_above_ground'));
  });

  it('ignores a stray field on a mode that does not use one', () => {
    expect(sharedDomainKey('height', 'wood_class')).toBe('height');
  });
});

describe('sharedDomains', () => {
  it('unions the ranges of every object mapping the same variable', () => {
    const domains = sharedDomains([
      { mode: 'height', min: 0, max: 4.2 },
      { mode: 'height', min: 1.5, max: 9.8 },
      { mode: 'height', min: 0.3, max: 5.1 },
    ]);
    expect(domains.get('height')).toEqual({ min: 0, max: 9.8 });
  });

  it('keeps different variables on independent scales', () => {
    const domains = sharedDomains([
      { mode: 'height', min: 0, max: 10 },
      { mode: 'intensity', min: 0, max: 1 },
      { mode: 'scalar', field: 'wood_class', min: 1, max: 2 },
    ]);
    expect(domains.get('height')).toEqual({ min: 0, max: 10 });
    expect(domains.get('intensity')).toEqual({ min: 0, max: 1 });
    expect(domains.get('scalar:wood_class')).toEqual({ min: 1, max: 2 });
  });

  it('does not pool two different scalar fields together', () => {
    const domains = sharedDomains([
      { mode: 'scalar', field: 'a', min: 0, max: 1 },
      { mode: 'scalar', field: 'b', min: 500, max: 900 },
    ]);
    expect(domains.get('scalar:a')).toEqual({ min: 0, max: 1 });
    expect(domains.get('scalar:b')).toEqual({ min: 500, max: 900 });
  });

  it('ignores non-finite bounds instead of poisoning the union', () => {
    // A degenerate/empty cloud must not turn every other scan's scale into NaN.
    const domains = sharedDomains([
      { mode: 'height', min: 2, max: 8 },
      { mode: 'height', min: NaN, max: NaN },
      { mode: 'height', min: -Infinity, max: Infinity },
    ]);
    expect(domains.get('height')).toEqual({ min: 2, max: 8 });
  });

  it('returns no domain for a variable nothing maps', () => {
    expect(sharedDomains([]).get('height')).toBeUndefined();
  });

  it('handles a single object as its own domain', () => {
    expect(sharedDomains([{ mode: 'height', min: 3, max: 7 }]).get('height'))
      .toEqual({ min: 3, max: 7 });
  });

  it('does not mutate its inputs', () => {
    const inputs = [
      { mode: 'height', min: 0, max: 4 },
      { mode: 'height', min: 1, max: 9 },
    ];
    sharedDomains(inputs);
    expect(inputs[0]).toEqual({ mode: 'height', min: 0, max: 4 });
  });
});

describe('shared domains collapse the per-scan legend stack', () => {
  // The user-visible payoff, asserted end to end through the real dedup: three
  // scans at different heights used to yield three separate Z colorbars, each
  // printing its own numbers. Pooling the domain first is what makes them one.
  const scans = [
    { id: 'a', min: 0, max: 4.2 },
    { id: 'b', min: 1.5, max: 9.8 },
    { id: 'c', min: 0.3, max: 5.1 },
  ];

  it('splits into one entry per scan when each keeps its own domain', () => {
    const entries = buildLegendEntries(scans.map(s => descriptor({
      objectId: s.id,
      dataRange: { min: s.min, max: s.max },
      channel: { mode: 'height', colormap: 'viridis' },
    })));
    expect(entries).toHaveLength(3);
  });

  it('folds into a single grouped entry on the pooled domain', () => {
    const pooled = sharedDomains(
      scans.map(s => ({ mode: 'height', min: s.min, max: s.max })),
    ).get('height')!;
    const entries = buildLegendEntries(scans.map(s => descriptor({
      objectId: s.id,
      dataRange: pooled,
      channel: { mode: 'height', colormap: 'viridis' },
    })));
    expect(entries).toHaveLength(1);
    expect(entries[0].objectLabel).toBe('3 scans');
    expect(entries[0].min).toBe(0);
    expect(entries[0].max).toBe(9.8);
    expect(entries[0].objectIds).toEqual(['a', 'b', 'c']);
  });

  it('still splits scans that use genuinely different colormaps', () => {
    const pooled = sharedDomains(
      scans.map(s => ({ mode: 'height', min: s.min, max: s.max })),
    ).get('height')!;
    const entries = buildLegendEntries([
      descriptor({ objectId: 'a', dataRange: pooled, channel: { mode: 'height', colormap: 'viridis' } }),
      descriptor({ objectId: 'b', dataRange: pooled, channel: { mode: 'height', colormap: 'turbo' } }),
    ]);
    expect(entries).toHaveLength(2);
  });
});
