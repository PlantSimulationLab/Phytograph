// Naming for the Scalar Fields tool's Rename / Duplicate, and the per-cloud
// bookkeeping a rename or delete has to carry along.
//
// A field has TWO names: the slug (an identifier — the octree's buffer key, the
// name a formula uses) and the label (what every picker shows). The Fields list,
// the Display "Color by" picker and the Scans panel all show the LABEL. Rename
// used to edit only the slug and deliberately keep a label that differed from it
// — and every imported field's label differs from its slug — so a rename changed
// nothing the user could see and read as having silently failed.
//
// So the user now types the NAME THEY SEE. It becomes the label verbatim, and
// the slug is that name when it is already a legal identifier, else derived from
// it. A name that only differs from the old label in punctuation keeps the slug,
// i.e. is a label-only rename.
//
// Pure: no React, no DOM.
import { checkSlug, suggestSlug } from './scalarFieldExpression';
import type { OctreeRef } from './pointCloudTypes';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface FieldNameTarget {
  /** The slug the backend will store the field under. */
  slug: string;
  /** The display name — exactly what the user typed, trimmed. */
  label: string;
  /** Why this cannot be submitted, or null. */
  problem: string | null;
  /** Nothing would change (a rename to the current name). */
  unchanged: boolean;
}

/**
 * Resolve what the user typed into a slug + label.
 *
 * `current` is the field being renamed (omit it for a duplicate, which always
 * makes a new slug). `taken` is every slug on the cloud(s) EXCEPT, for a rename,
 * the field's own — so that keeping it is allowed.
 */
export function resolveFieldName(
  typed: string,
  taken: readonly string[],
  current?: { slug: string; label: string },
): FieldNameTarget {
  const label = (typed ?? '').trim();
  if (!label) {
    return { slug: '', label, problem: 'Enter a name.', unchanged: false };
  }
  if (current && label === current.label) {
    return { slug: current.slug, label, problem: null, unchanged: true };
  }

  let slug: string;
  if (IDENTIFIER.test(label)) {
    // Already a legal identifier: use it exactly, and let a clash be an error
    // rather than silently suffixing a name the user spelled out.
    slug = label;
  } else {
    const base = suggestSlug(label, []);
    // Punctuation-only edits ("Reflectance [dB]" → "Reflectance dB") map back
    // onto the same slug: a label-only rename.
    slug = current && base === current.slug ? current.slug : suggestSlug(label, taken);
  }
  const problem = current && slug === current.slug ? null : checkSlug(slug, taken);
  return { slug, label, problem, unchanged: false };
}

/**
 * Move every per-cloud record keyed by `from` over to `to` on a cloud's octree
 * ref, returning a new ref (or the same one when nothing referred to `from`).
 *
 * `buildSessionOctreeData` carries these lists forward verbatim from the old
 * ref, so without this a renamed categorical field came back as a gradient, a
 * forced-continuous one lost its override, and a bound class palette was
 * orphaned under the old name. The ranges/labels/observed classes need no help:
 * they come from the backend's metadata for the relabeled octree.
 */
export function renameSlugInOctreeRef(ref: OctreeRef, from: string, to: string): OctreeRef {
  if (from === to) return ref;
  const swap = (list?: string[]) =>
    list && list.includes(from) ? list.map(s => (s === from ? to : s)) : list;
  const categoricalAttributes = swap(ref.categoricalAttributes);
  const continuousAttributes = swap(ref.continuousAttributes);
  let classPalettes = ref.classPalettes;
  if (classPalettes && from in classPalettes) {
    const { [from]: palette, ...rest } = classPalettes;
    classPalettes = { ...rest, [to]: { ...palette, slug: to } };
  }
  if (categoricalAttributes === ref.categoricalAttributes
      && continuousAttributes === ref.continuousAttributes
      && classPalettes === ref.classPalettes) {
    return ref;
  }
  return { ...ref, categoricalAttributes, continuousAttributes, classPalettes };
}

/** Drop a deleted field's per-cloud records. Same contract as the rename. */
export function dropSlugFromOctreeRef(ref: OctreeRef, slug: string): OctreeRef {
  const drop = (list?: string[]) =>
    list && list.includes(slug) ? list.filter(s => s !== slug) : list;
  const categoricalAttributes = drop(ref.categoricalAttributes);
  const continuousAttributes = drop(ref.continuousAttributes);
  let classPalettes = ref.classPalettes;
  if (classPalettes && slug in classPalettes) {
    const { [slug]: _gone, ...rest } = classPalettes;
    classPalettes = rest;
  }
  if (categoricalAttributes === ref.categoricalAttributes
      && continuousAttributes === ref.continuousAttributes
      && classPalettes === ref.classPalettes) {
    return ref;
  }
  return { ...ref, categoricalAttributes, continuousAttributes, classPalettes };
}
