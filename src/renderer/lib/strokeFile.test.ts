import { describe, it, expect } from 'vitest';
import { parseStrokeFile, renumberStrokes, serializeStrokes, STROKE_FILE_VERSION } from './strokeFile';
import type { LabelStroke } from './pointCloudTypes';

const strokes: LabelStroke[] = [
  { strokeId: 'a', toClass: 64, region: { kind: 'box', min: [0, 0, 0], max: [1, 1, 1] } },
  {
    strokeId: 'b', toClass: 2, fromClasses: [0, 65], excludeClasses: [7],
    region: { kind: 'spheres_union', centers: [[1, 2, 3]], radii: [0.5] },
    slab: { kind: 'slab', a: [0, 0], b: [1, 0], depth: 1, zMin: 0, zMax: 2, offset: 0 },
  },
];

describe('stroke files', () => {
  it('round-trip the strokes and the column', () => {
    const f = parseStrokeFile(serializeStrokes('organ_class', strokes, { paletteName: 'Organs', source: 'a.las' }));
    expect(f).toMatchObject({ slug: 'organ_class', version: STROKE_FILE_VERSION, paletteName: 'Organs', source: 'a.las' });
    expect(f.strokes).toEqual(strokes);
  });

  it.each([
    ['not json', /not JSON/],
    [JSON.stringify({ hello: 1 }), /not a Phytograph/],
    [JSON.stringify({ format: 'phytograph-label-strokes', version: 99, slug: 'x', strokes: [] }), /version 99/],
    [JSON.stringify({ format: 'phytograph-label-strokes', version: 1, strokes: [] }), /names no column/],
    [JSON.stringify({ format: 'phytograph-label-strokes', version: 1, slug: 'x', strokes: [{ toClass: 1, region: { kind: 'blob' } }] }), /Stroke 1 .*unknown region/],
    [JSON.stringify({ format: 'phytograph-label-strokes', version: 1, slug: 'x', strokes: [{ toClass: 1.5, region: { kind: 'box' } }] }), /no class/],
    [JSON.stringify({ format: 'phytograph-label-strokes', version: 1, slug: 'x', strokes: [{ toClass: 1, fromClasses: ['a'], region: { kind: 'box' } }] }), /class list/],
  ])('refuse a bad file whole: %s', (text, message) => {
    expect(() => parseStrokeFile(text)).toThrow(message);
  });

  it('renumber ids uniquely, keeping everything else', () => {
    const out = renumberStrokes(strokes, 'imp1');
    expect(out.map((s) => s.strokeId)).toEqual(['imp1-0', 'imp1-1']);
    expect(out[1]).toMatchObject({ toClass: 2, fromClasses: [0, 65] });
  });
});
