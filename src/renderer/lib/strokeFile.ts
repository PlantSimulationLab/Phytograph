/**
 * Label strokes as a file (F10): save the strokes that made a column, load
 * them onto the same scan re-imported, or onto a collaborator's copy.
 *
 * Every stroke region is already world-space and replayable — undo/redo
 * depends on exactly that — so a file is just the list, with a version and the
 * column it came from. Loading re-numbers the stroke ids (they are the join key
 * to the session's undo history and must be unique in it) and replays the
 * whole file as ONE undoable step.
 */
import type { LabelStroke } from './pointCloudTypes';

export const STROKE_FILE_VERSION = 1;

export interface StrokeFile {
  format: 'phytograph-label-strokes';
  version: number;
  /** The column the strokes were painted in. */
  slug: string;
  /** Name of the column's class set, for the reader. */
  paletteName?: string;
  /** The scan they were painted on, for the reader. */
  source?: string;
  strokes: LabelStroke[];
}

const REGION_KINDS = new Set([
  'box', 'polygon', 'squares_union', 'spheres_union', 'polyline_halfspace', 'voxel_set',
]);

export function serializeStrokes(
  slug: string, strokes: LabelStroke[], meta: { paletteName?: string; source?: string } = {},
): string {
  const file: StrokeFile = {
    format: 'phytograph-label-strokes',
    version: STROKE_FILE_VERSION,
    slug,
    ...meta,
    strokes,
  };
  return JSON.stringify(file);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isIntList = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(isInt));

/**
 * Parse and check a stroke file. Throws with a message a user can act on;
 * never returns a half-valid list, since replaying part of a file would leave
 * a column that matches neither the file nor what was there before.
 */
export function parseStrokeFile(text: string): StrokeFile {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This is not a label stroke file (it is not JSON).');
  }
  if (raw?.format !== 'phytograph-label-strokes') {
    throw new Error('This is not a Phytograph label stroke file.');
  }
  if (!isInt(raw.version) || raw.version > STROKE_FILE_VERSION) {
    throw new Error(`This stroke file is version ${raw.version}; this Phytograph reads up to ${STROKE_FILE_VERSION}. Update Phytograph to load it.`);
  }
  if (typeof raw.slug !== 'string' || !raw.slug) throw new Error('The stroke file names no column.');
  if (!Array.isArray(raw.strokes)) throw new Error('The stroke file holds no strokes.');
  raw.strokes.forEach((s: any, i: number) => {
    const bad = (why: string) => new Error(`Stroke ${i + 1} is damaged: ${why}.`);
    if (!s || typeof s !== 'object') throw bad('not an object');
    if (!isInt(s.toClass)) throw bad('no class to paint');
    if (!isIntList(s.fromClasses) || !isIntList(s.excludeClasses)) throw bad('bad class list');
    if (!s.region || !REGION_KINDS.has(s.region.kind)) throw bad(`unknown region "${s.region?.kind}"`);
    if (s.slab !== undefined && s.slab?.kind !== 'slab') throw bad('bad cross-section');
    if (s.limitBox !== undefined && s.limitBox?.kind !== 'box') throw bad('bad limiting box');
    if (s.fromColumn !== undefined && typeof s.fromColumn?.slug !== 'string') throw bad('bad source column');
  });
  return raw as StrokeFile;
}

/** The file's strokes with fresh, unique ids, ready to append to a column. */
export function renumberStrokes(strokes: LabelStroke[], prefix: string): LabelStroke[] {
  return strokes.map((s, i) => ({ ...s, strokeId: `${prefix}-${i.toString(36)}` }));
}
