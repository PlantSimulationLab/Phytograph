import { describe, it, expect } from 'vitest';
import {
  validatePalette, paletteErrors, nextFreeClassValue,
  paletteToScheme, paletteToIndexScheme, paletteIndexMaps,
  makePreset, makeEmptyPalette, parsePalette, parsePaletteList, defaultSlugForPreset,
  ASPRS_CLASSES, UNCLASSIFIED_VALUE, USER_CLASS_MIN,
  PALETTE_SOFT_MAX, withPendingLabelColumn,
  type ClassPalette, type LabelableColumn,
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

// ── Labelable columns ────────────────────────────────────────────────────────
//
// The feature these back: the labelling tool could reach exactly four columns,
// so a cloud carrying its own classification (a `tree_instance` from a failed
// tree segmentation) could not be hand-corrected at all. These assert the
// column list and the derived class list against the shape of a REAL failing
// file — example-datasets/almond_treseg_failure.laz, whose tree_instance holds
// exactly {1, 2} and no 0.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  labelableColumnsFor, derivePaletteForColumn, withRequiredUnclassified,
  slugifyLabelColumn, validateLabelColumn, isValidLabelSlug,
  LAS_RESERVED_SLUGS, LABEL_SLUG_RE,
} from './classPalettes';
import {
  categoricalSchemeForRange, buildGenericCategoricalSchemeFromValues,
  treeInstanceColor, MANUAL_CLASS_ATTRIBUTE,
} from './classification';

/** The almond file's columns, as octreeScalarFieldOptions would report them. */
const ALMOND_OPTIONS = [
  { value: 'col_4', label: 'col_4' },
  { value: 'col_5', label: 'col_5' },
  { value: 'tree_instance', label: 'Tree instance' },
];
const ALMOND_RANGES = {
  col_4: { min: [0], max: [1.5] },
  col_5: { min: [0], max: [3.25] },
  tree_instance: { min: [1], max: [2] },
};

function columnsForAlmond(over: Partial<Parameters<typeof labelableColumnsFor>[0]> = {}) {
  return labelableColumnsFor({
    columnOptions: ALMOND_OPTIONS,
    attributeRanges: ALMOND_RANGES,
    observedClasses: { tree_instance: [1, 2] },
    manualSlug: MANUAL_CLASS_ATTRIBUTE,
    // tree_instance is categorical BY NAME in the real registry.
    isCategorical: (s) => s === 'tree_instance',
    ...over,
  });
}

describe('labelableColumnsFor', () => {
  it('lists the cloud own classification, with the manual column first and marked missing', () => {
    const cols = columnsForAlmond();
    expect(cols.map((c) => c.slug)).toEqual([
      MANUAL_CLASS_ATTRIBUTE, 'tree_instance', 'col_4', 'col_5',
    ]);
    expect(cols.map((c) => c.kind)).toEqual(['manual', 'categorical', 'scalar', 'scalar']);
    // The almond file has no manual_class column yet — the backend makes it on
    // the first stroke, so it must still be offered.
    expect(cols[0].missing).toBe(true);
    expect(cols[1].missing).toBe(false);
  });

  it('carries the observed values and range through, so the palette can be derived', () => {
    const tree = columnsForAlmond().find((c) => c.slug === 'tree_instance')!;
    expect(tree.observed).toEqual([1, 2]);
    expect(tree.range).toEqual([1, 2]);
    expect(tree.label).toBe('Tree instance');
  });

  it('treats a continuous column as scalar, NOT as a classification', () => {
    // col_4 holds measurements. Offering it is deliberate (the app cannot always
    // tell), but it must never be enumerated as classes.
    const col4 = columnsForAlmond().find((c) => c.slug === 'col_4')!;
    expect(col4.kind).toBe('scalar');
  });

  it('promotes an unregistered integer column to categorical', () => {
    // A collaborator's `species_id` that was never marked in the wizard: its
    // values are class-like, so it is reachable without a re-import.
    const cols = labelableColumnsFor({
      columnOptions: [{ value: 'species_id', label: 'Species id' }],
      attributeRanges: { species_id: { min: [1], max: [4] } },
      observedClasses: { species_id: [1, 2, 3, 4] },
      manualSlug: MANUAL_CLASS_ATTRIBUTE,
      isCategorical: () => false,
    });
    expect(cols.find((c) => c.slug === 'species_id')!.kind).toBe('categorical');
  });

  it('does not promote a float column even when it has few distinct values', () => {
    const cols = labelableColumnsFor({
      columnOptions: [{ value: 'ratio', label: 'Ratio' }],
      observedClasses: { ratio: [0.5, 1.5] },
      manualSlug: MANUAL_CLASS_ATTRIBUTE,
      isCategorical: () => false,
    });
    expect(cols.find((c) => c.slug === 'ratio')!.kind).toBe('scalar');
  });

  it('a bound palette makes a column categorical even with nothing else to go on', () => {
    const cols = labelableColumnsFor({
      columnOptions: [{ value: 'my_qc', label: 'My QC' }],
      classPalettes: { my_qc: palette([{ value: 0, label: 'U', color: [0, 0, 0] }]) },
      manualSlug: MANUAL_CLASS_ATTRIBUTE,
      isCategorical: () => false,
    });
    expect(cols.find((c) => c.slug === 'my_qc')!.kind).toBe('categorical');
  });

  it('never offers a column the backend would reject', () => {
    const cols = labelableColumnsFor({
      columnOptions: [
        { value: 'Reflectance_dB', label: 'Reflectance' },   // capitals
        { value: 'classification', label: 'Classification' }, // reserved (crashes laspy)
        { value: 'las_classification', label: 'LAS class' },  // NOT reserved — keep
      ],
      manualSlug: MANUAL_CLASS_ATTRIBUTE,
      isCategorical: () => true,
    });
    const slugs = cols.map((c) => c.slug);
    expect(slugs).not.toContain('Reflectance_dB');
    expect(slugs).not.toContain('classification');
    expect(slugs).toContain('las_classification');
  });

  it('lists the manual column exactly once when the cloud already has it', () => {
    const cols = labelableColumnsFor({
      columnOptions: [{ value: MANUAL_CLASS_ATTRIBUTE, label: 'Hand labels' }],
      attributeRanges: { [MANUAL_CLASS_ATTRIBUTE]: { min: [0], max: [2] } },
      manualSlug: MANUAL_CLASS_ATTRIBUTE,
      isCategorical: () => true,
    });
    expect(cols.filter((c) => c.slug === MANUAL_CLASS_ATTRIBUTE)).toHaveLength(1);
    expect(cols[0].missing).toBe(false);
  });
});

describe('the mirrored backend slug rule', () => {
  // The picker refuses what the backend would refuse. Parsed out of main.py so
  // a backend tightening fails HERE rather than drifting into a 400 the user
  // only meets on their first brush stroke.
  const mainPy = readFileSync(
    join(__dirname, '..', '..', '..', 'backend-api', 'main.py'), 'utf8',
  );

  it('matches _LABEL_SLUG_RE in main.py', () => {
    const m = /_LABEL_SLUG_RE = re\.compile\(r"([^"]+)"\)/.exec(mainPy);
    expect(m, 'could not find _LABEL_SLUG_RE in main.py').toBeTruthy();
    expect(LABEL_SLUG_RE.source).toBe(m![1]);
  });

  it('covers every name in _LAS_RESERVED_SLUGS', () => {
    const block = /_LAS_RESERVED_SLUGS = frozenset\(\{([\s\S]*?)\}\)/.exec(mainPy);
    expect(block, 'could not find _LAS_RESERVED_SLUGS in main.py').toBeTruthy();
    const backend = [...block![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    expect(backend.length).toBeGreaterThan(10);
    for (const slug of backend) expect(LAS_RESERVED_SLUGS.has(slug)).toBe(true);
  });

  it('isValidLabelSlug rejects the reserved and the malformed', () => {
    expect(isValidLabelSlug('tree_instance')).toBe(true);
    expect(isValidLabelSlug('las_classification')).toBe(true);
    expect(isValidLabelSlug('classification')).toBe(false);
    expect(isValidLabelSlug('Classification')).toBe(false);   // case-insensitive
    expect(isValidLabelSlug('2nd')).toBe(false);
    expect(isValidLabelSlug('a'.repeat(32))).toBe(false);
    expect(isValidLabelSlug('')).toBe(false);
  });
});

describe('derivePaletteForColumn', () => {
  const treeColumn = {
    slug: 'tree_instance', label: 'Tree instance',
    kind: 'categorical' as const, missing: false,
    observed: [1, 2], range: [1, 2] as [number, number],
  };
  const derive = (col: Parameters<typeof derivePaletteForColumn>[0]) =>
    derivePaletteForColumn(col, NOW, categoricalSchemeForRange,
      buildGenericCategoricalSchemeFromValues);

  it('derives the real classes of a tree-instance column, with 0 synthesised', () => {
    const p = derive(treeColumn);
    expect(p.classes.map((c) => c.value)).toEqual([0, 1, 2]);
    expect(p.classes.map((c) => c.label)).toEqual(['Unassigned', 'Tree 1', 'Tree 2']);
    expect(p.slug).toBe('tree_instance');
    expect(p.name).toBe('Tree instance');
    // No 'preset' — a derived palette is not a stock vocabulary, and marking it
    // as one would let Preset cycle the user away from their own column.
    expect(p.preset).toBeUndefined();
    expect(validatePalette(p)).toEqual([]);
  });

  it('uses the colours the VIEWER already draws for those ids', () => {
    // The assertion that proves panel and viewport agree. A palette that merely
    // had the right names would still mislabel every swatch.
    const p = derive(treeColumn);
    expect(p.classes[1].color).toEqual(treeInstanceColor(1));
    expect(p.classes[2].color).toEqual(treeInstanceColor(2));
  });

  it('derives from the EXACT observed values, not the range', () => {
    // Trees 1 and 3 survive a filter. A [1,3] range enumeration would invent a
    // Tree 2 that owns no points.
    const p = derive({ ...treeColumn, observed: [1, 3], range: [1, 3] });
    expect(p.classes.map((c) => c.value)).toEqual([0, 1, 3]);
  });

  it('gives a scalar column an empty palette, never its millions of values', () => {
    const p = derive({
      slug: 'col_4', label: 'col_4', kind: 'scalar', missing: false,
      observed: [0.5, 1.5], range: [0, 1.5],
    });
    expect(p.classes.map((c) => c.value)).toEqual([0]);
    expect(p.slug).toBe('col_4');
  });

  it('keeps a registered scheme whole (ground_class keeps its domain names)', () => {
    const p = derive({
      slug: 'ground_class', label: 'Ground class', kind: 'categorical',
      missing: false, observed: [1, 2], range: [1, 2],
    });
    expect(p.classes.map((c) => c.label)).toEqual(['Unclassified', 'Ground', 'Non-ground']);
  });

  it('ids derived palettes per column, so switching column remounts the editor', () => {
    expect(derive(treeColumn).id).not.toBe(
      derive({ ...treeColumn, slug: 'ground_class', label: 'G' }).id,
    );
  });
});

describe('withRequiredUnclassified', () => {
  it('is idempotent — a scheme that already has 0 is untouched', () => {
    // A duplicate 0 would make validatePalette reject its own derived palette.
    const classes = [
      { value: 0, label: 'Unclassified', color: [0.5, 0.5, 0.5] as const },
      { value: 1, label: 'A', color: [1, 0, 0] as const },
    ];
    expect(withRequiredUnclassified(classes as never)).toBe(classes);
  });
});

describe('a palette must name a column the backend accepts', () => {
  it('blocks saving a palette with a missing or reserved column', () => {
    expect(paletteErrors({ ...OK, slug: '' })).not.toEqual([]);
    expect(paletteErrors({ ...OK, slug: 'classification' })).not.toEqual([]);
    expect(paletteErrors({ ...OK, slug: 'Tree_Instance' })).not.toEqual([]);
    expect(paletteErrors({ ...OK, slug: 'tree_instance' })).toEqual([]);
  });
});

describe('slugifyLabelColumn / validateLabelColumn', () => {
  it.each([
    ['QC pass 2!', 'qc_pass_2'],
    ['2nd pass', 'nd_pass'],
    ['  Row  QC  ', 'row_qc'],
    ['Tree-Instance', 'tree_instance'],
    ['!!!', ''],
  ])('slugifies %j to %j', (input, expected) => {
    expect(slugifyLabelColumn(input)).toBe(expected);
  });

  it('every non-empty slug it produces is one the backend accepts', () => {
    for (const name of ['QC pass 2!', '2nd pass', 'Row  QC', 'a'.repeat(60)]) {
      const slug = slugifyLabelColumn(name);
      if (slug) expect(isValidLabelSlug(slug)).toBe(true);
    }
  });

  it('rejects an empty name, a reserved name, and a column the cloud already has', () => {
    expect(validateLabelColumn('', [])).not.toEqual([]);
    expect(validateLabelColumn('Classification', [])).not.toEqual([]);
    expect(validateLabelColumn('Tree instance', ['tree_instance'])).not.toEqual([]);
    expect(validateLabelColumn('Row QC', ['tree_instance'])).toEqual([]);
  });
});

describe('nextFreeClassValue with a start hint', () => {
  it('continues an existing column numbering instead of jumping to 64', () => {
    // Splitting a merged tree must give Tree 3, not class 64.
    const derived = palette([
      { value: 0, label: 'Unassigned', color: [0.2, 0.2, 0.2] },
      { value: 1, label: 'Tree 1', color: [1, 0, 0] },
      { value: 2, label: 'Tree 2', color: [0, 1, 0] },
    ]);
    expect(nextFreeClassValue(derived, 1)).toBe(3);
  });

  it('still uses the user-definable band for a hand-built palette', () => {
    expect(nextFreeClassValue(OK)).toBe(USER_CLASS_MIN + 2);
  });

  it('marks a derived palette as derived, and a preset as not', () => {
    // `derived` is what the editor reads to decide where Add class numbers
    // from. It CANNOT be inferred from the values: wood/leaf and organs also
    // number from 1, so an "are these below 64" test renumbers those too and
    // silently breaks the ASPRS user-definable band.
    const p = derivePaletteForColumn(
      { slug: 'tree_instance', label: 'Tree instance', kind: 'categorical',
        missing: false, observed: [1, 2], range: [1, 2] },
      NOW, categoricalSchemeForRange, buildGenericCategoricalSchemeFromValues,
    );
    expect(p.derived).toBe(true);
    expect(makePreset('wood_leaf', 'manual_class', NOW).derived).toBeUndefined();
    expect(makeEmptyPalette('row_qc', NOW, 'x').derived).toBeUndefined();
  });

  it('survives the library JSON round-trip', () => {
    // Saved palettes come back through parsePalette; losing `derived` there
    // would make Add class jump to 64 the second time a user opened the column.
    const p = derivePaletteForColumn(
      { slug: 'tree_instance', label: 'Tree instance', kind: 'categorical',
        missing: false, observed: [1, 2], range: [1, 2] },
      NOW, categoricalSchemeForRange, buildGenericCategoricalSchemeFromValues,
    );
    expect(parsePalette(JSON.parse(JSON.stringify(p)))?.derived).toBe(true);
  });
});

describe('withPendingLabelColumn', () => {
  const base = (): LabelableColumn[] => ([
    { slug: 'manual_class', label: 'Hand labels', kind: 'manual', missing: true },
    { slug: 'tree_instance', label: 'Tree instance', kind: 'categorical', missing: false },
  ]);

  it('adds a column the octree has never heard of', () => {
    // The window this exists for: the user creates a classification, paints it,
    // and commits. The column is real on the backend from the first stroke, but
    // the picker is built from OCTREE metadata, which only learns about it when
    // the background rebuild lands — a converter run later.
    const out = withPendingLabelColumn(base(), {
      slug: 'row_qc', label: 'Row QC', observed: [2, 0, 1],
    });
    const added = out.find((c) => c.slug === 'row_qc');
    expect(added).toBeTruthy();
    expect(added!.kind).toBe('categorical');
    expect(added!.missing).toBe(false);
    expect(added!.observed).toEqual([0, 1, 2]);   // sorted
    expect(added!.range).toEqual([0, 2]);
  });

  it('fills in a column the picker was showing as MISSING', () => {
    // `manual_class` is always offered, flagged missing until the cloud has it.
    // A commit is exactly what stops it being missing, so this must patch the
    // existing entry rather than list the slug twice.
    const out = withPendingLabelColumn(base(), {
      slug: 'manual_class', label: 'Hand labels', observed: [0, 1],
    });
    expect(out.filter((c) => c.slug === 'manual_class')).toHaveLength(1);
    expect(out.find((c) => c.slug === 'manual_class')!.missing).toBe(false);
    // The kind is the picker's own classification of the column and is kept.
    expect(out.find((c) => c.slug === 'manual_class')!.kind).toBe('manual');
  });

  it('defers to the octree once it carries the column', () => {
    const out = withPendingLabelColumn(base(), {
      slug: 'tree_instance', label: 'Something else', observed: [9],
    });
    expect(out).toEqual(base());
  });

  it('is a no-op without a pending column, and refuses an invalid slug', () => {
    expect(withPendingLabelColumn(base(), null)).toEqual(base());
    // A slug the backend would refuse must never reach the picker — an entry
    // that 400s on the first stroke is worse than one that is not there.
    expect(withPendingLabelColumn(base(), { slug: 'classification', label: 'x' }))
      .toEqual(base());
  });
});
