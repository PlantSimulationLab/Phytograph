import { describe, expect, it } from 'vitest';
import { pruneCloudColorModes, type CloudColorModeEntry } from './cloudColorModes';

const flat = (id: string, fields: string[]) => ({
  id,
  data: { octree: undefined, scalarFields: Object.fromEntries(fields.map(f => [f, { values: new Float32Array(0), min: 0, max: 1 }])) },
}) as any;

const modes = (entries: Array<[string, CloudColorModeEntry]>) => new Map(entries);

describe('pruneCloudColorModes', () => {
  it('keeps the override of a cloud that has not reached `clouds` yet', () => {
    // A split sets each child's color mode in the same tick it adds the child;
    // `clouds` can change (the parent's update) before the child arrives.
    const seen = new Set<string>();
    const prev = modes([['child', { mode: 'scalar', field: 'ground_class' }]]);
    const out = pruneCloudColorModes(prev, [flat('parent', ['ground_class'])], seen);
    expect(out.get('child')).toEqual({ mode: 'scalar', field: 'ground_class' });
    // ...and it still holds once the child does arrive.
    const later = pruneCloudColorModes(out, [flat('parent', ['ground_class']), flat('child', ['ground_class'])], seen);
    expect(later.get('child')).toEqual({ mode: 'scalar', field: 'ground_class' });
  });

  it('drops the override of a cloud that was seen and then removed', () => {
    const seen = new Set<string>();
    const prev = modes([['a', { mode: 'height' }]]);
    pruneCloudColorModes(prev, [flat('a', [])], seen);
    const out = pruneCloudColorModes(prev, [], seen);
    expect(out.has('a')).toBe(false);
  });

  it('drops a scalar override whose field the cloud no longer carries', () => {
    const prev = modes([['a', { mode: 'scalar', field: 'wood_class' }]]);
    const out = pruneCloudColorModes(prev, [flat('a', ['ground_class'])], new Set());
    expect(out.has('a')).toBe(false);
  });

  it('returns the same map when nothing changed', () => {
    const prev = modes([['a', { mode: 'scalar', field: 'ground_class' }]]);
    expect(pruneCloudColorModes(prev, [flat('a', ['ground_class'])], new Set())).toBe(prev);
  });
});
