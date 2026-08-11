import { describe, it, expect } from 'vitest';
import {
  validatePalette, paletteErrors, nextFreeClassValue,
  paletteToScheme, paletteToIndexScheme, paletteIndexMaps,
  makePreset, makeEmptyPalette, parsePalette, parsePaletteList, defaultSlugForPreset,
  ASPRS_CLASSES, UNCLASSIFIED_VALUE, USER_CLASS_MIN,
  PALETTE_SOFT_MAX, type ClassPalette,
} from './classPalettes';
import { buildCategoricalGradientStops, categoricalSchemeForCloud } from './classification';

const NOW = 1_700_000_000_000;

function palette(classes: ClassPalette['classes'], name = 'P'): ClassPalette {
  return { id: 'p1', name, slug: 'manual_class', classes, updatedAt: NOW };
}

const OK = palette([
  { value: 0, label: 'Unclassified', color: [0.5, 0.5, 0.5] },
  { value: 64, label: 'Wood', color: [0.4, 0.26, 0.13] },
  { value: 65, label: 'Leaf', color: [0.3, 0.69, 0.31] },
]);

describe('validatePalette', () => {
  it('accepts a well-formed palette', () => {
    expect(validatePalette(OK)).toEqual([]);
  });

  it('REQUIRES class 0 — merged/unlabelled points arrive as 0', () => {
    // Not cosmetic: the backend's merge zero-fills a column missing from one
    // input session, so 0 must mean "unclassified" in every palette.
    const errs = paletteErrors(palette([
      { value: 64, label: 'Wood', color: [0, 0, 0] },
    ]));
    expect(errs.some((e) => e.value === UNCLASSIFIED_VALUE)).toBe(true);
  });

  it('rejects duplicate class values', () => {
    const errs = paletteErrors(palette([
      { value: 0, label: 'Unclassified', color: [0, 0, 0] },
      { value: 64, label: 'A', color: [0, 0, 0] },
      { value: 64, label: 'B', color: [0, 0, 0] },
    ]));
    expect(errs.some((e) => /duplicate/i.test(e.message))).toBe(true);
  });

  it.each([-1, 256, 999])('rejects out-of-range value %i', (v) => {
    const errs = paletteErrors(palette([
      { value: 0, label: 'Unclassified', color: [0, 0, 0] },
      { value: v, label: 'X', color: [0, 0, 0] },
    ]));
    expect(errs.some((e) => e.value === v)).toBe(true);
  });

  it('rejects a non-integer class value', () => {
    const errs = paletteErrors(palette([
      { value: 0, label: 'Unclassified', color: [0, 0, 0] },
      { value: 3.5, label: 'X', color: [0, 0, 0] },
    ]));
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects an unnamed class and an unnamed palette', () => {
    expect(paletteErrors(palette([
      { value: 0, label: '', color: [0, 0, 0] },
    ])).length).toBeGreaterThan(0);
    expect(paletteErrors(palette(OK.classes, '  ')).length).toBeGreaterThan(0);
  });

  it('WARNS (does not block) on the ASPRS reserved band 19-63', () => {
    const issues = validatePalette(palette([
      { value: 0, label: 'Unclassified', color: [0, 0, 0] },
      { value: 30, label: 'Mine', color: [0, 0, 0] },
    ]));
    const warn = issues.find((i) => i.value === 30);
    expect(warn?.level).toBe('warning');
    expect(paletteErrors(palette([
      { value: 0, label: 'Unclassified', color: [0, 0, 0] },
      { value: 30, label: 'Mine', color: [0, 0, 0] },
    ]))).toEqual([]);
  });

  it('warns past the readable class count but still allows it', () => {
    const many = [{ value: 0, label: 'Unclassified', color: [0, 0, 0] as const }];
    for (let i = 1; i <= PALETTE_SOFT_MAX + 2; i++) {
      many.push({ value: USER_CLASS_MIN + i, label: `C${i}`, color: [0, 0, 0] as const });
    }
    const issues = validatePalette(palette(many as ClassPalette['classes']));
    expect(issues.some((i) => i.level === 'warning')).toBe(true);
    expect(issues.some((i) => i.level === 'error')).toBe(false);
  });
});

describe('nextFreeClassValue', () => {
  it('starts in the user-definable band', () => {
    expect(nextFreeClassValue(palette([
      { value: 0, label: 'Unclassified', color: [0, 0, 0] },
    ]))).toBe(USER_CLASS_MIN);
  });

  it('skips taken values', () => {
    expect(nextFreeClassValue(OK)).toBe(66);
  });
});

describe('scheme bridge', () => {
  it('a palette IS a categorical scheme (the reuse that makes everything work)', () => {
    const scheme = paletteToScheme(OK);
    expect(scheme.attribute).toBe('manual_class');
    expect(scheme.classes).toEqual(OK.classes);
  });

  it('the index scheme renumbers to a dense 0..n-1 for the 64-texel gradient', () => {
    // The real payoff: class values 64/65 would land sub-texel apart in a
    // 64-texel gradient and blend; dense indices resolve cleanly.
    const idx = paletteToIndexScheme(OK);
    expect(idx.classes.map((c) => c.value)).toEqual([0, 1, 2]);
    expect(idx.classes.map((c) => c.color)).toEqual(OK.classes.map((c) => c.color));
  });

  it('index maps round-trip value <-> index', () => {
    const { valueToIndex, indexToValue } = paletteIndexMaps(OK);
    expect(valueToIndex.get(65)).toBe(2);
    expect(indexToValue[2]).toBe(65);
    expect(indexToValue).toHaveLength(OK.classes.length);
  });

  it('dense indices give each class a resolvable band; raw 64+ values do not', () => {
    // Guards the concrete regression the index remap exists to prevent.
    // potree bakes these stops into a 64-TEXEL canvas with LinearFilter, so a
    // band narrower than 1/64 of the gradient is averaged away on screen even
    // though the stop list still names three distinct colours. Measure the BAND
    // WIDTHS, which is what actually survives the bake.
    const TEXEL = 1 / 64;
    const widths = (stops: Array<[number, unknown]>) => {
      const out: number[] = [];
      for (let i = 0; i < stops.length; i += 2) out.push(stops[i + 1][0] - stops[i][0]);
      return out;
    };

    // Needs a REALISTIC palette size to show the effect: with only two or three
    // classes the midpoint cells are wide whatever the raw values are. Twenty
    // user classes at 64.. is an ordinary plant-organ or QC vocabulary.
    const big = palette([
      { value: 0, label: 'Unclassified', color: [0.5, 0.5, 0.5] },
      ...Array.from({ length: 19 }, (_, i) => ({
        value: USER_CLASS_MIN + i, label: `C${i}`, color: [0, 0, 0] as const,
      })),
    ] as ClassPalette['classes']);

    // Dense 0..19: every class owns more than a texel, so all 20 are visible.
    const dense = widths(
      buildCategoricalGradientStops(paletteToIndexScheme(big), [0, 19]),
    );
    expect(dense).toHaveLength(20);
    expect(Math.min(...dense)).toBeGreaterThan(TEXEL);

    // Raw values over the 0..255 band the classes actually live in: the packed
    // 64.. run is ~4x narrower than one texel and blends together on screen.
    const raw = widths(buildCategoricalGradientStops(paletteToScheme(big), [0, 255]));
    expect(Math.min(...raw)).toBeLessThan(TEXEL);
  });
});

describe('presets', () => {
  it('ASPRS covers 0-18 and names the vegetation classes', () => {
    expect(ASPRS_CLASSES).toHaveLength(19);
    expect(ASPRS_CLASSES.find((c) => c.value === 5)?.label).toBe('High Vegetation');
    expect(ASPRS_CLASSES.find((c) => c.value === 2)?.label).toBe('Ground');
  });

  it.each(['asprs', 'organ', 'wood_leaf', 'ground'] as const)('%s preset validates', (p) => {
    expect(paletteErrors(makePreset(p, 'manual_class', NOW))).toEqual([]);
  });

  it('the wood/leaf preset keeps segment_wood\'s own 1=wood 2=leaf codes', () => {
    // So hand-correcting the automatic result works in one vocabulary.
    const wl = makePreset('wood_leaf', 'manual_class', NOW);
    expect(wl.classes.find((c) => c.value === 1)?.label).toBe('Wood');
    expect(wl.classes.find((c) => c.value === 2)?.label).toBe('Leaf');
    expect(wl.classes.find((c) => c.value === 0)).toBeTruthy();
  });

  it('the organ preset matches the Helios synthetic-scan organ codes', () => {
    const organ = makePreset('organ', 'manual_class', NOW);
    expect(organ.classes.find((c) => c.value === 1)?.label).toBe('Leaf');
    expect(organ.classes.find((c) => c.value === 3)?.label).toBe('Shoot');
  });

  it('binds each preset to the COLUMN it describes, not just a vocabulary', () => {
    // The bug: every preset was bound to manual_class, so switching to ASPRS
    // read the (empty) hand-labelling column while the cloud's real classes sat
    // in an imported one — Ground reported 0 points and nothing coloured.
    expect(defaultSlugForPreset('asprs', 'manual_class')).toBe('las_classification');
    expect(defaultSlugForPreset('wood_leaf', 'manual_class')).toBe('manual_class');
    expect(defaultSlugForPreset('organ', 'manual_class')).toBe('manual_class');
    // The reported case: a cloud already segmented by the ground tool must show
    // its real classes, which live in ground_class, not the manual column.
    expect(defaultSlugForPreset('ground', 'manual_class')).toBe('ground_class');
  });

  it('the ground preset reuses the segmentation tool\'s own class codes', () => {
    const g = makePreset('ground', defaultSlugForPreset('ground', 'manual_class'), NOW);
    expect(g.slug).toBe('ground_class');
    expect(g.classes.find((c) => c.value === 1)?.label).toBe('Ground');
    expect(g.classes.find((c) => c.value === 2)?.label).toBe('Non-ground');
    expect(paletteErrors(g)).toEqual([]);
  });

  it('a preset built with its default slug carries it through', () => {
    const p = makePreset('asprs', defaultSlugForPreset('asprs', 'manual_class'), NOW);
    expect(p.slug).toBe('las_classification');
    expect(paletteToScheme(p).attribute).toBe('las_classification');
  });

  it('an empty palette starts valid, with only Unclassified', () => {
    const p = makeEmptyPalette('manual_class', NOW, 'x');
    expect(paletteErrors(p)).toEqual([]);
    expect(p.classes).toHaveLength(1);
  });

  it('presets are deep-copied, so editing one does not mutate the shared source', () => {
    const a = makePreset('organ', 'manual_class', NOW);
    a.classes[0].label = 'MUTATED';
    expect(makePreset('organ', 'manual_class', NOW).classes[0].label).toBe('Unknown');
  });
});

describe('categoricalSchemeForCloud', () => {
  const asprs = makePreset('asprs', 'manual_class', NOW);

  it('uses the cloud\'s palette over any by-name default', () => {
    const scheme = categoricalSchemeForCloud('manual_class', [0, 5],
      { manual_class: asprs });
    expect(scheme?.classes.find((c) => c.value === 5)?.label).toBe('High Vegetation');
  });

  it('lets two clouds disagree about the same slug', () => {
    // The case a process-wide registry cannot express, and the reason this
    // function threads the palette explicitly.
    const organ = makePreset('organ', 'manual_class', NOW);
    const a = categoricalSchemeForCloud('manual_class', [0, 5], { manual_class: asprs });
    const b = categoricalSchemeForCloud('manual_class', [0, 5], { manual_class: organ });
    expect(a?.classes.find((c) => c.value === 5)?.label).toBe('High Vegetation');
    expect(b?.classes.find((c) => c.value === 5)?.label).toBe('Fruit');
  });

  it('falls back to the registered scheme when the cloud has no palette', () => {
    const scheme = categoricalSchemeForCloud('ground_class', [1, 2], undefined);
    expect(scheme?.classes.find((c) => c.value === 1)?.label).toBe('Ground');
  });

  it('ignores an empty palette rather than rendering a blank legend', () => {
    const empty: ClassPalette = { ...asprs, classes: [] };
    const scheme = categoricalSchemeForCloud('ground_class', [1, 2],
      { ground_class: empty });
    expect(scheme?.classes.find((c) => c.value === 1)?.label).toBe('Ground');
  });

  it('returns null for an unknown attribute with no palette', () => {
    expect(categoricalSchemeForCloud('nope_not_a_field', [0, 1], undefined)).toBeNull();
  });
});

describe('parsePalette', () => {
  it('round-trips a palette through JSON', () => {
    const json = JSON.parse(JSON.stringify(OK));
    expect(parsePalette(json)).toEqual(OK);
  });

  it.each([
    null, 42, 'nope', {},
    { id: 'a', name: 'n', slug: 's' },                                   // no classes
    { id: 'a', name: 'n', slug: 's', classes: [{ value: 1 }] },          // no label/color
    { id: 'a', name: 'n', slug: 's', classes: [{ value: 1, label: 'x', color: [1, 2] }] },
  ])('rejects malformed input %#', (raw) => {
    expect(parsePalette(raw)).toBeNull();
  });

  it('parsePaletteList skips bad entries instead of failing the whole import', () => {
    const list = parsePaletteList([OK, null, { junk: true }, OK]);
    expect(list).toHaveLength(2);
  });
});
