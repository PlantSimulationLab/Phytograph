// Leaf/wood split column for the LAD inversion.
//
// The backend splits each voxel's intercepted area into leaf and wood by the
// share of its returns in each class (see `_resolve_wood_split`). By default it
// reads `wood_class`, which Phytograph's own Wood / Leaf Segmentation writes
// (1 = wood, 2 = leaf). A classifier run outside Phytograph usually lands in the
// LAS classification byte or its own extra dimension instead, with its own
// numbering, so the LAD dialog lets the user pick the column and say which of
// its values are wood and which leaf.

import type { LADWoodSplit } from '../utils/backendApi';
import type { Scan } from './scan';
import { columnSlugs } from './scan';
import { octreeAttributeSlug } from './pointCloudHelpers';
import { WOOD_CLASS_ATTRIBUTE } from './classification';

export const WOOD_SPLIT_OFF = '__off__';

// Per-pulse bookkeeping and geometry, never a classification.
const NOT_A_CLASS_COLUMN = new Set([
  'timestamp', 'target_index', 'target_count', 'is_miss',
  'row_index', 'column_index', 'intensity', 'reflectance',
  'ox', 'oy', 'oz', 'origin_x', 'origin_y', 'origin_z',
  'rgb', 'red', 'green', 'blue', 'gps-time', 'gps_time',
]);

export interface WoodSplitColumn {
  slug: string;
  label: string;
}

// Columns every selected scan carries that could hold a classification, with
// `wood_class` first when present. Intersected because one LAD run sends one
// column name for all its scans.
export function woodSplitColumns(scans: Scan[]): WoodSplitColumn[] {
  if (scans.length === 0) return [];
  let common = columnSlugs(scans[0]);
  const labels = new Map<string, string>();
  for (const s of scans) {
    const slugs = columnSlugs(s);
    common = new Set([...common].filter(k => slugs.has(k)));
    for (const [key, label] of Object.entries(s.data?.octree?.attributeLabels ?? {})) {
      const slug = octreeAttributeSlug(key);
      if (!labels.has(slug) && typeof label === 'string' && label) labels.set(slug, label);
    }
  }
  const out = [...common]
    .filter(slug => !NOT_A_CLASS_COLUMN.has(slug.toLowerCase()))
    .map(slug => ({ slug, label: labels.get(slug) ?? slug }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const wood = out.findIndex(c => c.slug === WOOD_CLASS_ATTRIBUTE);
  if (wood > 0) out.unshift(...out.splice(wood, 1));
  return out;
}

// The column the dialog starts on: Phytograph's own segmentation when every scan
// has it (the backend's default), otherwise no split.
export function defaultWoodSplitChoice(columns: WoodSplitColumn[]): string {
  return columns.some(c => c.slug === WOOD_CLASS_ATTRIBUTE) ? WOOD_CLASS_ATTRIBUTE : WOOD_SPLIT_OFF;
}

// "1, 2 5-7" -> [1, 2, 5, 6, 7]. Integers only (class codes); null on anything
// it can't read, so the dialog can say so instead of silently dropping a value.
export function parseClassValues(text: string): number[] | null {
  const out: number[] = [];
  for (const tok of text.split(/[\s,;]+/).filter(Boolean)) {
    const range = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(tok);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (b < a || b - a > 10000) return null;
      for (let v = a; v <= b; v++) out.push(v);
      continue;
    }
    if (!/^-?\d+$/.test(tok)) return null;
    out.push(Number(tok));
  }
  return [...new Set(out)];
}

// The request field for a dialog state, or an error message. `undefined` means
// "leave it to the backend default" (wood_class as-is).
export function buildWoodSplit(
  choice: string, woodText: string, leafText: string,
): { split?: LADWoodSplit; error?: string } {
  if (choice === WOOD_SPLIT_OFF) return { split: { slug: null } };
  if (choice === WOOD_CLASS_ATTRIBUTE) return {};
  const wood = parseClassValues(woodText);
  const leaf = parseClassValues(leafText);
  if (wood === null || leaf === null) {
    return { error: 'Leaf/wood values must be whole numbers, e.g. "1, 3" or "2-5".' };
  }
  if (wood.length === 0 && leaf.length === 0) {
    return { error: 'Enter which values of the leaf/wood column are wood and which are leaf.' };
  }
  const both = wood.filter(v => leaf.includes(v));
  if (both.length > 0) {
    return { error: `Value${both.length > 1 ? 's' : ''} ${both.join(', ')} listed as both wood and leaf.` };
  }
  return { split: { slug: choice, wood_values: wood, leaf_values: leaf } };
}
