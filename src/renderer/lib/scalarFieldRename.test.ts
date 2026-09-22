import { describe, it, expect } from 'vitest';
import {
  resolveFieldName, renameSlugInOctreeRef, dropSlugFromOctreeRef,
} from './scalarFieldRename';
import type { OctreeRef } from './pointCloudTypes';
import type { ClassPalette } from './classPalettes';

const refl = { slug: 'reflectance', label: 'Reflectance [dB]' };

describe('resolveFieldName', () => {
  it('makes the typed name the LABEL — the name every picker shows', () => {
    // The original bug: the label was carried over, so nothing visible changed.
    const t = resolveFieldName('refl_db', ['band'], refl);
    expect(t).toEqual({ slug: 'refl_db', label: 'refl_db', problem: null, unchanged: false });
  });

  it('derives a slug from a name that is not an identifier, keeping the label verbatim', () => {
    const t = resolveFieldName('Return Strength (dB)', ['band'], refl);
    expect(t.label).toBe('Return Strength (dB)');
    expect(t.slug).toBe('Return_Strength_dB');
    expect(t.problem).toBeNull();
  });

  it('treats a punctuation-only edit as a label-only rename', () => {
    const t = resolveFieldName('Reflectance dB', ['band'], { slug: 'Reflectance_dB', label: 'Reflectance [dB]' });
    expect(t.slug).toBe('Reflectance_dB');
    expect(t.label).toBe('Reflectance dB');
    expect(t.problem).toBeNull();
    expect(t.unchanged).toBe(false);
  });

  it('is unchanged only when the visible name is the same', () => {
    expect(resolveFieldName('  Reflectance [dB] ', [], refl).unchanged).toBe(true);
    // Typing the slug is a real change of what the user sees.
    expect(resolveFieldName('reflectance', [], refl).unchanged).toBe(false);
  });

  it('refuses a typed identifier that another field already uses', () => {
    expect(resolveFieldName('band', ['band'], refl).problem).toMatch(/already has a field/);
  });

  it('suffixes a DERIVED slug that would clash, since the user never typed it', () => {
    expect(resolveFieldName('band!', ['band'], refl).slug).toBe('band_2');
  });

  it('refuses an empty name', () => {
    expect(resolveFieldName('   ', [], refl).problem).toBe('Enter a name.');
  });

  it('duplicate (no current field) always resolves to a new slug', () => {
    const t = resolveFieldName('Reflectance copy', ['reflectance']);
    expect(t.slug).toBe('Reflectance_copy');
    expect(t.label).toBe('Reflectance copy');
  });
});

const palette: ClassPalette = {
  id: 'p1', name: 'Bands', slug: 'band', classes: [], updatedAt: 0,
};
const ref = (over: Partial<OctreeRef> = {}): OctreeRef => ({
  cacheId: 'abc', sourceXyzPath: '/x.xyz', ...over,
});

describe('renameSlugInOctreeRef', () => {
  it('carries categorical status and the bound palette to the new slug', () => {
    const out = renameSlugInOctreeRef(
      ref({ categoricalAttributes: ['band', 'other'], classPalettes: { band: palette } }),
      'band', 'strip');
    expect(out.categoricalAttributes).toEqual(['strip', 'other']);
    expect(out.classPalettes).toEqual({ strip: { ...palette, slug: 'strip' } });
  });

  it('carries a forced-continuous override', () => {
    const out = renameSlugInOctreeRef(ref({ continuousAttributes: ['band'] }), 'band', 'strip');
    expect(out.continuousAttributes).toEqual(['strip']);
  });

  it('returns the same ref when nothing names the slug', () => {
    const r = ref({ categoricalAttributes: ['other'] });
    expect(renameSlugInOctreeRef(r, 'band', 'strip')).toBe(r);
    expect(renameSlugInOctreeRef(r, 'other', 'other')).toBe(r);
  });
});

describe('dropSlugFromOctreeRef', () => {
  it('removes the deleted field everywhere it is named', () => {
    const out = dropSlugFromOctreeRef(
      ref({ categoricalAttributes: ['band'], continuousAttributes: ['band', 'x'],
            classPalettes: { band: palette } }),
      'band');
    expect(out.categoricalAttributes).toEqual([]);
    expect(out.continuousAttributes).toEqual(['x']);
    expect(out.classPalettes).toEqual({});
  });

  it('returns the same ref when nothing names the slug', () => {
    const r = ref();
    expect(dropSlugFromOctreeRef(r, 'band')).toBe(r);
  });
});
